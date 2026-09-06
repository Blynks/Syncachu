import { randomUUID } from "node:crypto";
import {
  ApiError, BLOCK_SIZE, type MediaItem, type Snapshot, type Storage, type StoredMedia, type Ticket, type UploadTicket,
} from "../src/types.js";

export class MemoryStorage implements Storage {
  tickets = new Map<string, Ticket>();
  media = new Map<string, StoredMedia>();
  staging = new Map<string, Buffer>();
  snapshots = new Map<string, Buffer>();
  originals = new Map<string, Buffer>();
  originalRecords = new Map<string, StoredMedia>();
  thumbnails = new Map<string, Buffer>();
  calls: string[] = [];
  onRead: (() => void) | undefined;
  marker: string | undefined;

  async getTicket(owner: string, id: string) { return this.tickets.get(`${owner}/${id}`); }
  async createTicket(ticket: Ticket) { this.tickets.set(`${ticket.owner}/${ticket.uploadId}`, ticket); }
  async getMedia(owner: string, id: string) { return this.media.get(`${owner}/${id}`); }
  async uploadUrls(ticket: Ticket, expiresAt: Date): Promise<UploadTicket> {
    return {
      duplicate: false, uploadId: ticket.uploadId, expiresAt: expiresAt.toISOString(), blockSize: BLOCK_SIZE,
      uploadUrl: `https://blob.test/staging/${ticket.owner}/${ticket.uploadId}/original`,
      ...(ticket.hasThumbnail ? { thumbnailUploadUrl: `https://blob.test/staging/${ticket.owner}/${ticket.uploadId}/thumbnail` } : {}),
    };
  }
  stage(owner: string, id: string, data: Buffer, thumbnail = false) {
    this.staging.set(`${owner}/${id}/${thumbnail}`, Buffer.from(data));
  }
  async snapshot(ticket: Ticket, thumbnail: boolean): Promise<Snapshot> {
    this.calls.push("snapshot");
    const blobName = `${ticket.owner}/${ticket.uploadId}/${thumbnail}`;
    const data = this.staging.get(blobName);
    if (!data) throw new ApiError(409, "Media not uploaded");
    const snapshot = randomUUID();
    this.snapshots.set(snapshot, Buffer.from(data));
    return { blobName, snapshot, size: data.length };
  }
  async readSnapshot(snapshot: Snapshot): Promise<AsyncIterable<Uint8Array>> {
    this.calls.push("read");
    this.onRead?.();
    const bytes = this.snapshots.get(snapshot.snapshot)!;
    return (async function* () {
      for (let i = 0; i < bytes.length; i += 2) yield bytes.subarray(i, i + 2);
    })();
  }
  async promoteOriginal(owner: string, snapshot: Snapshot, media: StoredMedia) {
    this.calls.push("promote");
    const key = `${owner}/${media.id}`;
    if (!this.originals.has(key)) {
      this.originals.set(key, this.snapshots.get(snapshot.snapshot)!);
      this.originalRecords.set(key, media);
    }
    return this.originalRecords.get(key)!;
  }
  async promoteThumbnail(owner: string, id: string, digest: string, snapshot: Snapshot) {
    const key = `${owner}/${id}/${digest}`;
    if (!this.thumbnails.has(key)) this.thumbnails.set(key, this.snapshots.get(snapshot.snapshot)!);
    return key;
  }
  async finalize(owner: string, media: StoredMedia) {
    this.calls.push("finalize");
    const key = `${owner}/${media.id}`;
    if (!this.media.has(key)) this.media.set(key, media);
    return this.media.get(key)!;
  }
  async mediaUrls(owner: string, media: StoredMedia): Promise<MediaItem> {
    const { thumbnailKey, ...rest } = media;
    return {
      ...rest, url: `https://blob.test/final/${owner}/${media.id}`,
      ...(thumbnailKey ? { thumbnailUrl: `https://blob.test/${thumbnailKey}` } : {}),
    };
  }
  async list(owner: string, marker?: string) {
    this.calls.push(`list:${marker ?? ""}`);
    const items = [...this.media].filter(([key]) => key.startsWith(`${owner}/`)).map(([, value]) => value);
    return this.marker ? { items, marker: this.marker } : { items };
  }
  async removeSnapshot(snapshot: Snapshot) { this.snapshots.delete(snapshot.snapshot); }
}
