import { requireOptionalNativeModule } from 'expo';
import { MediaItem, QueueItem } from './core';

type NativeModule = {
  configure(config: string): Promise<void>;
  enqueue(userId: string, jobs: string): Promise<void>;
  snapshot(userId: string): Promise<string>;
  cancel(userId: string, id: string): Promise<void>;
  retry(userId: string, ids: string): Promise<void>;
  acknowledge(userId: string, ids: string): Promise<void>;
  setMobile(userId: string, allowMobile: boolean): Promise<void>;
  stop(userId: string): Promise<void>;
};
export type BackgroundJob = {
  id: string; status: QueueItem['status']; progress: number;
  error?: string; httpStatus?: number; media?: MediaItem;
};
const native = requireOptionalNativeModule<NativeModule>('SyncachuBackgroundBackup');

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid background backup response.');
  return value as Record<string, unknown>;
}

export function parseBackgroundJobs(raw: string): BackgroundJob[] {
  const rows: unknown = JSON.parse(raw);
  if (!Array.isArray(rows)) throw new Error('Invalid background backup queue.');
  const ids = new Set<string>();
  return rows.map(value => {
    const row = record(value);
    const { id, status, progress, error, httpStatus } = row;
    if (typeof id !== 'string' || !id || ids.has(id)
      || (status !== 'queued' && status !== 'working' && status !== 'error' && status !== 'done' && status !== 'cancelled')
      || typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1
      || (error !== undefined && typeof error !== 'string')
      || (httpStatus !== undefined && (typeof httpStatus !== 'number' || !Number.isInteger(httpStatus)))) {
      throw new Error('Invalid background backup status.');
    }
    ids.add(id);
    let media: MediaItem | undefined;
    if (status === 'done') {
      const result = record(row.media);
      const { id, name, contentType, size, createdAt, url, thumbnailUrl } = result;
      if (typeof id !== 'string' || typeof name !== 'string' || typeof contentType !== 'string'
        || typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0
        || typeof createdAt !== 'string' || typeof url !== 'string'
        || (thumbnailUrl !== undefined && typeof thumbnailUrl !== 'string')) {
        throw new Error('Invalid background backup completion.');
      }
      media = { id, name, contentType, size, createdAt, url, thumbnailUrl };
    }
    return { id, status, progress, error, httpStatus, media };
  });
}

export class BackgroundBackup {
  readonly available = native !== null;
  constructor(private userId: string) {}
  private module(): NativeModule {
    if (!native) throw new Error('Rebuild the native app to enable background backup.');
    return native;
  }
  configure(apiUrl: string, blobHost: string, token: string, allowMobile: boolean) {
    return this.module().configure(JSON.stringify({ userId: this.userId, apiUrl, blobHost, token, allowMobile }));
  }
  enqueue(items: QueueItem[]) {
    return this.module().enqueue(this.userId, JSON.stringify(items.map(item => {
      if (!item.backgroundId) throw new Error('Save the background job before submitting it.');
      return {
        id: item.backgroundId, key: item.key, name: item.name, contentType: item.contentType,
        uri: item.uri, assetId: item.assetId,
      };
    })));
  }
  async snapshot(): Promise<BackgroundJob[]> {
    return parseBackgroundJobs(await this.module().snapshot(this.userId));
  }
  cancel(id: string) { return this.module().cancel(this.userId, id); }
  retry(ids: string[]) { return this.module().retry(this.userId, JSON.stringify(ids)); }
  acknowledge(ids: string[]) { return this.module().acknowledge(this.userId, JSON.stringify(ids)); }
  setMobile(value: boolean) { return this.module().setMobile(this.userId, value); }
  stop() { return native ? native.stop(this.userId) : Promise.resolve(); }
}
