import { createHash, randomUUID } from "node:crypto";
import {
  ApiError, MAX_MEDIA_SIZE, MAX_THUMBNAIL_SIZE, SAS_LIFETIME_MS, TICKET_LIFETIME_MS,
  type MediaItem, type Snapshot, type Storage, type StoredMedia, type Ticket, type UploadInput,
  type UploadTicket,
} from "./types.js";

const contentTypes = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif",
  "image/avif", "video/mp4", "video/quicktime", "video/webm", "video/x-m4v", "video/3gpp",
]);
const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function validateInput(value: unknown): UploadInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "Invalid upload");
  const v = value as Record<string, unknown>;
  if (typeof v.sha256 !== "string" || !hashPattern.test(v.sha256)
    || typeof v.size !== "number" || !Number.isSafeInteger(v.size) || v.size <= 0
    || typeof v.contentType !== "string" || !contentTypes.has(v.contentType)
    || typeof v.name !== "string" || !v.name.trim() || v.name.length > 255 || /[\u0000-\u001f\u007f]/.test(v.name)
    || typeof v.hasThumbnail !== "boolean") throw new ApiError(400, "Invalid upload");
  if (v.size > MAX_MEDIA_SIZE) throw new ApiError(413, "Media exceeds 2 GiB limit");
  return { sha256: v.sha256, size: v.size, contentType: v.contentType, name: v.name, hasThumbnail: v.hasThumbnail };
}

export async function verifyStream(
  stream: AsyncIterable<Uint8Array>, expectedSize: number | undefined, expectedDigest?: string, thumbnail = false,
): Promise<string> {
  const max = thumbnail ? MAX_THUMBNAIL_SIZE : MAX_MEDIA_SIZE;
  const hash = createHash("sha256");
  const header: number[] = [];
  let tail = Buffer.alloc(0);
  let size = 0;
  for await (const part of stream) {
    const chunk = Buffer.from(part.buffer, part.byteOffset, part.byteLength);
    size += chunk.byteLength;
    if (size > max) throw new ApiError(413, thumbnail ? "Thumbnail exceeds 1 MiB limit" : "Media exceeds 2 GiB limit");
    if (expectedSize !== undefined && size > expectedSize) throw new ApiError(409, "Uploaded size does not match");
    hash.update(chunk);
    if (thumbnail) {
      for (let i = 0; i < chunk.length && header.length < 3; i++) header.push(chunk[i]!);
      if (chunk.length >= 2) tail = Buffer.from(chunk.subarray(-2));
      else if (chunk.length) tail = Buffer.concat([tail, chunk]).subarray(-2);
    }
  }
  const digest = hash.digest("hex");
  if (expectedSize !== undefined && size !== expectedSize) throw new ApiError(409, "Uploaded size does not match");
  if (expectedDigest !== undefined && digest !== expectedDigest) throw new ApiError(409, "Uploaded SHA-256 does not match");
  if (thumbnail && (size < 5 || header[0] !== 0xff || header[1] !== 0xd8 || header[2] !== 0xff
    || tail[0] !== 0xff || tail[1] !== 0xd9)) throw new ApiError(400, "Thumbnail must be a JPEG");
  return digest;
}

export class MediaService {
  constructor(private readonly storage: Storage, private readonly now: () => number = Date.now) {}

  private async ticket(owner: string, uploadId: string): Promise<Ticket> {
    if (!idPattern.test(uploadId)) throw new ApiError(400, "Invalid upload ID");
    const ticket = await this.storage.getTicket(owner, uploadId);
    if (!ticket || ticket.owner !== owner) throw new ApiError(404, "Upload not found");
    return ticket;
  }

  private assertActive(ticket: Ticket): void {
    if (this.now() >= Date.parse(ticket.createdAt) + TICKET_LIFETIME_MS) {
      throw new ApiError(409, "Upload expired; start a new upload");
    }
  }

  private async issue(ticket: Ticket): Promise<UploadTicket> {
    this.assertActive(ticket);
    const expiresAt = new Date(Math.min(this.now() + SAS_LIFETIME_MS, Date.parse(ticket.createdAt) + TICKET_LIFETIME_MS));
    return this.storage.uploadUrls(ticket, expiresAt);
  }

  async begin(owner: string, body: unknown): Promise<{ duplicate: true; media: MediaItem } | UploadTicket> {
    const input = validateInput(body);
    const existing = await this.storage.getMedia(owner, input.sha256);
    if (existing) return { duplicate: true, media: await this.storage.mediaUrls(owner, existing) };
    const ticket: Ticket = { ...input, owner, uploadId: randomUUID(), createdAt: new Date(this.now()).toISOString() };
    await this.storage.createTicket(ticket);
    return this.issue(ticket);
  }

  async renew(owner: string, uploadId: string): Promise<UploadTicket> {
    return this.issue(await this.ticket(owner, uploadId));
  }

  async complete(owner: string, uploadId: string): Promise<MediaItem> {
    const ticket = await this.ticket(owner, uploadId);
    const existing = await this.storage.getMedia(owner, ticket.sha256);
    if (existing) return this.storage.mediaUrls(owner, existing);
    this.assertActive(ticket);
    const snapshots: Snapshot[] = [];
    try {
      const original = await this.storage.snapshot(ticket, false);
      snapshots.push(original);
      if (original.size > MAX_MEDIA_SIZE) throw new ApiError(413, "Media exceeds 2 GiB limit");
      if (original.size !== ticket.size) throw new ApiError(409, "Uploaded size does not match");
      await verifyStream(await this.storage.readSnapshot(original), ticket.size, ticket.sha256);
      let thumbnail: Snapshot | undefined;
      let thumbnailDigest: string | undefined;
      if (ticket.hasThumbnail) {
        thumbnail = await this.storage.snapshot(ticket, true);
        snapshots.push(thumbnail);
        if (thumbnail.size > MAX_THUMBNAIL_SIZE) throw new ApiError(413, "Thumbnail exceeds 1 MiB limit");
        thumbnailDigest = await verifyStream(await this.storage.readSnapshot(thumbnail), thumbnail.size, undefined, true);
      }
      let media: StoredMedia = await this.storage.promoteOriginal(owner, original, {
        id: ticket.sha256, name: ticket.name, size: ticket.size, contentType: ticket.contentType,
        createdAt: new Date(this.now()).toISOString(),
      });
      if (thumbnail && thumbnailDigest) {
        const thumbnailKey = await this.storage.promoteThumbnail(owner, ticket.sha256, thumbnailDigest, thumbnail);
        media = { ...media, thumbnailKey };
      }
      media = await this.storage.finalize(owner, media);
      return await this.storage.mediaUrls(owner, media);
    } finally {
      // Remove only this request's immutable snapshots; other completions may use the staging blob.
      await Promise.allSettled(snapshots.map(snapshot => this.storage.removeSnapshot(snapshot)));
    }
  }

  async gallery(owner: string, cursor?: string): Promise<{ items: MediaItem[]; nextCursor?: string }> {
    let marker: string | undefined;
    if (cursor !== undefined) {
      try {
        if (cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
        if (parsed.owner !== owner || typeof parsed.marker !== "string" || !parsed.marker) throw new Error();
        marker = parsed.marker;
      } catch {
        throw new ApiError(400, "Invalid cursor");
      }
    }
    const page = await this.storage.list(owner, marker);
    const items = await Promise.all(page.items.map(media => this.storage.mediaUrls(owner, media)));
    return page.marker
      ? { items, nextCursor: Buffer.from(JSON.stringify({ owner, marker: page.marker })).toString("base64url") }
      : { items };
  }
}
