export const BLOCK_SIZE = 4_194_304 as const;
export const MAX_MEDIA_SIZE = 2 * 1024 * 1024 * 1024;
export const MAX_THUMBNAIL_SIZE = 1024 * 1024;
export const SAS_LIFETIME_MS = 15 * 60 * 1000;
export const TICKET_LIFETIME_MS = 24 * 60 * 60 * 1000;

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface UploadInput {
  sha256: string;
  size: number;
  contentType: string;
  name: string;
  hasThumbnail: boolean;
}

export interface Ticket extends UploadInput {
  owner: string;
  uploadId: string;
  createdAt: string;
}

export interface UploadTicket {
  duplicate: false;
  uploadId: string;
  uploadUrl: string;
  thumbnailUploadUrl?: string;
  expiresAt: string;
  blockSize: typeof BLOCK_SIZE;
}

export interface StoredMedia {
  id: string;
  name: string;
  contentType: string;
  size: number;
  createdAt: string;
  thumbnailKey?: string;
}

export interface MediaItem {
  id: string;
  name: string;
  contentType: string;
  size: number;
  createdAt: string;
  url: string;
  thumbnailUrl?: string;
}

export interface Snapshot {
  blobName: string;
  snapshot: string;
  size: number;
}

export interface Storage {
  getTicket(owner: string, uploadId: string): Promise<Ticket | undefined>;
  createTicket(ticket: Ticket): Promise<void>;
  getMedia(owner: string, id: string): Promise<StoredMedia | undefined>;
  uploadUrls(ticket: Ticket, expiresAt: Date): Promise<UploadTicket>;
  snapshot(ticket: Ticket, thumbnail: boolean): Promise<Snapshot>;
  readSnapshot(snapshot: Snapshot): Promise<AsyncIterable<Uint8Array>>;
  promoteOriginal(owner: string, snapshot: Snapshot, media: StoredMedia): Promise<StoredMedia>;
  promoteThumbnail(owner: string, mediaId: string, digest: string, snapshot: Snapshot): Promise<string>;
  finalize(owner: string, media: StoredMedia): Promise<StoredMedia>;
  mediaUrls(owner: string, media: StoredMedia): Promise<MediaItem>;
  list(owner: string, marker?: string): Promise<{ items: StoredMedia[]; marker?: string }>;
  removeSnapshot(snapshot: Snapshot): Promise<void>;
}
