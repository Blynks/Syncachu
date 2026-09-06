import { DefaultAzureCredential } from "@azure/identity";
import {
  BlobServiceClient, BlobSASPermissions, SASProtocol, generateBlobSASQueryParameters,
  type ContainerClient, type UserDelegationKey,
} from "@azure/storage-blob";
import type { StorageConfig } from "./config.js";
import {
  ApiError, BLOCK_SIZE, SAS_LIFETIME_MS, type MediaItem, type Snapshot, type Storage,
  type StoredMedia, type Ticket, type UploadTicket,
} from "./types.js";

const prefix = (owner: string) => `users/${owner}/`;
const ticketKey = (owner: string, id: string) => `tickets/${owner}/${id}.json`;
const indexKey = (owner: string, id: string) => `${prefix(owner)}index/${id}.json`;
const originalKey = (owner: string, id: string) => `${prefix(owner)}final/${id}/original`;
const stagingKey = (ticket: Ticket, thumbnail: boolean) =>
  `staging/${ticket.owner}/${ticket.uploadId}/${thumbnail ? "thumbnail" : "original"}`;

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "statusCode" in error
    ? Number(error.statusCode) : undefined;
}

export class AzureBlobStorage implements Storage {
  private readonly container: ContainerClient;
  private readonly accountName: string;
  private delegation: Promise<UserDelegationKey> | undefined;
  private delegationExpiry = 0;

  constructor(
    config: StorageConfig,
    private readonly service = new BlobServiceClient(config.storageAccountUrl, new DefaultAzureCredential()),
    private readonly now: () => number = Date.now,
  ) {
    this.container = service.getContainerClient(config.storageContainer);
    this.accountName = new URL(config.storageAccountUrl).hostname.split(".")[0]!;
  }

  async assertPrivate(): Promise<void> {
    // Fail closed rather than silently changing an existing container's access policy.
    const properties = await this.container.getProperties();
    if (properties.blobPublicAccess) throw new Error("The media container must be private");
  }

  private async key(): Promise<UserDelegationKey> {
    if (!this.delegation || this.delegationExpiry < this.now() + SAS_LIFETIME_MS + 60_000) {
      this.delegationExpiry = this.now() + 60 * 60 * 1000;
      this.delegation = this.service.getUserDelegationKey(
        new Date(this.now() - 5 * 60 * 1000), new Date(this.delegationExpiry),
      );
      this.delegation.catch(() => { this.delegation = undefined; });
    }
    return this.delegation;
  }

  private async sas(
    blobName: string, permission: "cw" | "r", expiresAt: Date, snapshot?: string, contentDisposition?: "attachment",
  ): Promise<string> {
    const query = generateBlobSASQueryParameters({
      containerName: this.container.containerName,
      blobName,
      permissions: BlobSASPermissions.parse(permission),
      protocol: SASProtocol.Https,
      startsOn: new Date(this.now() - 5 * 60 * 1000),
      expiresOn: expiresAt,
      cacheControl: "private, no-store",
      ...(snapshot ? { snapshotTime: snapshot } : {}),
      ...(contentDisposition ? { contentDisposition } : {}),
    }, await this.key(), this.accountName);
    const client = this.container.getBlobClient(blobName);
    // snapshotTime scopes the signature but must also appear in the source URL.
    const url = snapshot ? client.withSnapshot(snapshot).url : client.url;
    return `${url}${url.includes("?") ? "&" : "?"}${query.toString()}`;
  }

  private async readJson<T>(name: string): Promise<T | undefined> {
    try {
      const response = await this.container.getBlobClient(name).download();
      if (!response.readableStreamBody) throw new Error("Missing metadata body");
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of response.readableStreamBody) {
        const bytes = Buffer.from(chunk as Uint8Array);
        length += bytes.length;
        if (length > 16 * 1024) throw new Error("Metadata limit exceeded");
        chunks.push(bytes);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } catch (error) {
      if (status(error) === 404) return undefined;
      throw error;
    }
  }

  private async writeJson(name: string, value: unknown): Promise<boolean> {
    const data = Buffer.from(JSON.stringify(value));
    try {
      await this.container.getBlockBlobClient(name).uploadData(data, {
        tier: "Hot",
        conditions: { ifNoneMatch: "*" },
        blobHTTPHeaders: { blobContentType: "application/json", blobCacheControl: "private, no-store" },
      });
      return true;
    } catch (error) {
      if (status(error) === 409 || status(error) === 412) return false;
      throw error;
    }
  }

  getTicket(owner: string, uploadId: string): Promise<Ticket | undefined> {
    return this.readJson(ticketKey(owner, uploadId));
  }

  async createTicket(ticket: Ticket): Promise<void> {
    if (!await this.writeJson(ticketKey(ticket.owner, ticket.uploadId), ticket)) throw new Error("Ticket collision");
  }

  getMedia(owner: string, id: string): Promise<StoredMedia | undefined> {
    return this.readJson(indexKey(owner, id));
  }

  async uploadUrls(ticket: Ticket, expiresAt: Date): Promise<UploadTicket> {
    const uploadUrl = await this.sas(stagingKey(ticket, false), "cw", expiresAt);
    return {
      duplicate: false, uploadId: ticket.uploadId, uploadUrl, expiresAt: expiresAt.toISOString(), blockSize: BLOCK_SIZE,
      ...(ticket.hasThumbnail ? { thumbnailUploadUrl: await this.sas(stagingKey(ticket, true), "cw", expiresAt) } : {}),
    };
  }

  async snapshot(ticket: Ticket, thumbnail: boolean): Promise<Snapshot> {
    const blobName = stagingKey(ticket, thumbnail);
    const blob = this.container.getBlobClient(blobName);
    let snapshot: string | undefined;
    try {
      const result = await blob.createSnapshot();
      snapshot = result.snapshot;
      if (!snapshot) throw new Error("Missing snapshot ID");
      const properties = await blob.withSnapshot(snapshot).getProperties();
      if (properties.blobType !== "BlockBlob" || properties.contentLength === undefined) {
        throw new ApiError(400, "Upload must be a block blob");
      }
      return { blobName, snapshot, size: properties.contentLength };
    } catch (error) {
      if (snapshot) await blob.withSnapshot(snapshot).deleteIfExists().catch(() => undefined);
      if (status(error) === 404) throw new ApiError(409, thumbnail ? "Thumbnail not uploaded" : "Media not uploaded");
      throw error;
    }
  }

  async readSnapshot(snapshot: Snapshot): Promise<AsyncIterable<Uint8Array>> {
    const response = await this.container.getBlobClient(snapshot.blobName).withSnapshot(snapshot.snapshot).download();
    if (!response.readableStreamBody) throw new Error("Missing upload body");
    return response.readableStreamBody as AsyncIterable<Uint8Array>;
  }

  private async promote(snapshot: Snapshot, name: string, contentType: string, media?: StoredMedia): Promise<boolean> {
    const source = await this.sas(snapshot.blobName, "r", new Date(this.now() + SAS_LIFETIME_MS), snapshot.snapshot);
    try {
      // Put Blob From URL is synchronous; an accepted background copy is never treated as complete.
      await this.container.getBlockBlobClient(name).syncUploadFromURL(source, {
        tier: media ? "Cool" : "Hot",
        conditions: { ifNoneMatch: "*" },
        copySourceBlobProperties: false,
        blobHTTPHeaders: { blobContentType: contentType, blobCacheControl: "private, no-store" },
        metadata: media ? { record: Buffer.from(JSON.stringify(media)).toString("base64url") } : {},
      });
      return true;
    } catch (error) {
      if (status(error) === 409 || status(error) === 412) {
        // Only a committed canonical object may win a race; never suppress a failed copy.
        const properties = await this.container.getBlobClient(name).getProperties();
        if (properties.contentLength === snapshot.size && (!properties.copyStatus || properties.copyStatus === "success")) {
          return false;
        }
      }
      throw error;
    }
  }

  async promoteOriginal(owner: string, snapshot: Snapshot, media: StoredMedia): Promise<StoredMedia> {
    const name = originalKey(owner, media.id);
    if (await this.promote(snapshot, name, media.contentType, media)) return media;
    const properties = await this.container.getBlobClient(name).getProperties();
    if (!properties.metadata?.record) throw new Error("Missing canonical metadata");
    return JSON.parse(Buffer.from(properties.metadata.record, "base64url").toString("utf8")) as StoredMedia;
  }

  async promoteThumbnail(owner: string, mediaId: string, digest: string, snapshot: Snapshot): Promise<string> {
    const name = `${prefix(owner)}final/${mediaId}/thumbnails/${digest}.jpg`;
    await this.promote(snapshot, name, "image/jpeg");
    return name;
  }

  async finalize(owner: string, media: StoredMedia): Promise<StoredMedia> {
    if (await this.writeJson(indexKey(owner, media.id), media)) return media;
    const existing = await this.getMedia(owner, media.id);
    if (!existing) throw new Error("Missing concurrent finalization");
    return existing;
  }

  async mediaUrls(owner: string, media: StoredMedia): Promise<MediaItem> {
    const expiresAt = new Date(this.now() + SAS_LIFETIME_MS);
    const { thumbnailKey, ...item } = media;
    if (thumbnailKey && !thumbnailKey.startsWith(`${prefix(owner)}final/${media.id}/thumbnails/`)) {
      throw new Error("Invalid thumbnail namespace");
    }
    return {
      ...item, url: await this.sas(originalKey(owner, media.id), "r", expiresAt, undefined, "attachment"),
      ...(thumbnailKey ? { thumbnailUrl: await this.sas(thumbnailKey, "r", expiresAt) } : {}),
    };
  }

  async list(owner: string, marker?: string): Promise<{ items: StoredMedia[]; marker?: string }> {
    try {
      const iterator = this.container.listBlobsFlat({ prefix: `${prefix(owner)}index/` })
        .byPage({ maxPageSize: 50, ...(marker ? { continuationToken: marker } : {}) });
      const page = await iterator.next();
      if (page.done) return { items: [] };
      const results = await Promise.all(page.value.segment.blobItems.map(async blob => {
        if (!blob.name.startsWith(`${prefix(owner)}index/`)) throw new Error("Invalid listing namespace");
        return this.readJson<StoredMedia>(blob.name);
      }));
      const items = results.filter((item): item is StoredMedia => item !== undefined);
      return page.value.continuationToken ? { items, marker: page.value.continuationToken } : { items };
    } catch (error) {
      if (marker && status(error) === 400) throw new ApiError(400, "Invalid cursor");
      throw error;
    }
  }

  async removeSnapshot(snapshot: Snapshot): Promise<void> {
    await this.container.getBlobClient(snapshot.blobName).withSnapshot(snapshot.snapshot).deleteIfExists();
  }

  async *quotaRecords(): AsyncIterable<{ owner: string; id: string; bytes: number }> {
    for await (const blob of this.container.listBlobsFlat({ prefix: "users/" })) {
      if (!blob.name.includes("/index/")) continue;
      const match = /^users\/([a-f0-9]{64})\/index\/([a-f0-9]{64})\.json$/.exec(blob.name);
      if (!match) throw new Error("Invalid catalog namespace during quota initialization");
      const owner = match[1]!;
      const id = match[2]!;
      const media = await this.readJson<StoredMedia>(blob.name);
      if (!media || media.id !== id || !Number.isSafeInteger(media.size) || media.size <= 0) throw new Error("Invalid catalog record");
      const original = await this.container.getBlobClient(originalKey(owner, id)).getProperties();
      if (original.contentLength !== media.size) throw new Error("Original size differs from catalog");
      let bytes = media.size;
      if (media.thumbnailKey) {
        if (!media.thumbnailKey.startsWith(`${prefix(owner)}final/${id}/thumbnails/`)) throw new Error("Invalid thumbnail namespace");
        const thumbnail = await this.container.getBlobClient(media.thumbnailKey).getProperties();
        if (thumbnail.contentLength === undefined) throw new Error("Missing thumbnail size");
        bytes += thumbnail.contentLength;
      }
      yield { owner, id, bytes };
    }
  }
}
