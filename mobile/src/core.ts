export const BLOCK_SIZE = 4 * 1024 * 1024;
export const MAX_SIZE = 2 * 1024 * 1024 * 1024;
const SUPPORTED_CONTENT_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/avif',
  'video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v', 'video/3gpp',
]);

export function isSupportedContentType(contentType: string): boolean {
  return SUPPORTED_CONTENT_TYPES.has(contentType);
}

export function shouldSkipSelection(item?: Pick<QueueItem, 'status'>): boolean {
  return item?.status === 'queued' || item?.status === 'working';
}

export type MediaItem = {
  id: string; name: string; contentType: string; size: number;
  createdAt: string; url: string; thumbnailUrl?: string;
};
export type StorageUsage = { limitBytes: number; usedBytes: number; reservedBytes: number; availableBytes: number };
export function parseStorageUsage(value: unknown): StorageUsage {
  if (!value || typeof value !== 'object') throw new Error('Invalid storage usage response.');
  const row = value as Record<string, unknown>;
  const number = (key: string): number => {
    const bytes = row[key];
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid storage usage response.');
    return bytes;
  };
  const usage = { limitBytes: number('limitBytes'), usedBytes: number('usedBytes'), reservedBytes: number('reservedBytes'), availableBytes: number('availableBytes') };
  if (!usage.limitBytes || usage.availableBytes !== Math.max(0, usage.limitBytes - usage.usedBytes - usage.reservedBytes)) {
    throw new Error('Invalid storage usage response.');
  }
  return usage;
}
export function formatStorageBytes(bytes: number): string {
  const unit = bytes >= 1e12 ? 'TB' : bytes >= 1e9 ? 'GB' : bytes >= 1e6 ? 'MB' : bytes >= 1e3 ? 'KB' : 'B';
  const divisor = { TB: 1e12, GB: 1e9, MB: 1e6, KB: 1e3, B: 1 }[unit];
  return `${(bytes / divisor).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`;
}
export type UploadTicket = {
  duplicate: false; uploadId: string; uploadUrl: string;
  thumbnailUploadUrl?: string; expiresAt: string; blockSize: number;
};
export type QueueItem = {
  key: string; name: string; contentType: string;
  assetId?: string; uri?: string; revision?: number | null;
  status: 'queued' | 'working' | 'error' | 'done' | 'cancelled';
  error?: string; progress: number; sha256?: string; size?: number;
  uploadId?: string; blocks: number[]; hasThumbnail?: boolean;
};
export type Policy = {
  connected: boolean; reachable: boolean; wifi: boolean;
  allowMobile: boolean; active: boolean;
};

export function canUpload(policy: Policy): boolean {
  return policy.active && policy.connected && policy.reachable
    && (policy.wifi || policy.allowMobile);
}

// Every block ID decodes to exactly eight ASCII digits, including on resume.
export function blockId(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > 99999999) throw new Error('Invalid block index');
  const text = index.toString().padStart(8, '0');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let i = 0; i < text.length; i += 3) {
    const a = text.charCodeAt(i);
    const b = text.charCodeAt(i + 1);
    const c = text.charCodeAt(i + 2);
    const bits = (a << 16) | ((b || 0) << 8) | (c || 0);
    result += alphabet[(bits >>> 18) & 63] + alphabet[(bits >>> 12) & 63]
      + (Number.isNaN(b) ? '=' : alphabet[(bits >>> 6) & 63])
      + (Number.isNaN(c) ? '=' : alphabet[bits & 63]);
  }
  return result;
}

export function planBlocks(size: number, completed: number[] = []) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_SIZE) {
    throw new Error('Choose a non-empty file up to 2 GiB.');
  }
  const done = new Set(completed);
  return Array.from({ length: Math.ceil(size / BLOCK_SIZE) }, (_, index) => ({
    index, id: blockId(index), offset: index * BLOCK_SIZE,
    size: Math.min(BLOCK_SIZE, size - index * BLOCK_SIZE), done: done.has(index),
  }));
}

export function sameContent(item: QueueItem, digest: string, size: number) {
  return item.sha256 === digest && item.size === size;
}

export function mergeQueue(queue: QueueItem[], incoming: QueueItem[]): QueueItem[] {
  const result = [...queue];
  for (const item of incoming) {
    const index = result.findIndex(existing => existing.key === item.key);
    if (index < 0) result.push(item);
    else if (item.revision !== result[index].revision) result[index] = item;
  }
  return result;
}

export function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Cancelled');
}

export function trustedBlobUrl(raw: string, expectedHost: string): URL {
  const url = new URL(raw);
  if (!/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(expectedHost)
    || url.protocol !== 'https:' || url.hostname !== expectedHost
    || url.port || url.username || url.password || url.hash || !url.searchParams.has('sig')) {
    throw new Error('The server returned an untrusted storage URL.');
  }
  return url;
}

export function privateApiUrl(raw: string, base: string): string {
  const root = new URL(base);
  const url = new URL(raw, `${base}/`);
  if (url.origin !== root.origin || !url.pathname.startsWith(`${root.pathname}/`)
    || url.username || url.password || url.hash) {
    throw new Error('The server returned an untrusted media URL.');
  }
  return url.toString();
}
