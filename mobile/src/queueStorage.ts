import { QueueItem } from './core';

export const QUEUE_CHUNK_BYTES = 64 * 1024;
export type QueueSnapshot = { queue: QueueItem[]; auto: boolean; allowMobile: boolean };
export type EncodedQueue = { chunks: string[]; auto: boolean; allowMobile: boolean };
type Storage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
  multiRemove(keys: readonly string[]): Promise<void>;
};
type Manifest = { version: 2; generation: string; chunks: number; auto: boolean; allowMobile: boolean };

export function encodeQueue(snapshot: QueueSnapshot): EncodedQueue {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let entries: string[] = [];
  let bytes = 2;
  for (const item of snapshot.queue) {
    const encoded = JSON.stringify(item);
    const size = encoder.encode(encoded).byteLength;
    if (size + 2 > QUEUE_CHUNK_BYTES) throw new Error('A queue entry is too large to save safely.');
    if (bytes + size + (entries.length ? 1 : 0) > QUEUE_CHUNK_BYTES) {
      chunks.push(`[${entries.join(',')}]`);
      entries = [];
      bytes = 2;
    }
    bytes += size + (entries.length ? 1 : 0);
    entries.push(encoded);
  }
  if (entries.length) chunks.push(`[${entries.join(',')}]`);
  return { chunks, auto: snapshot.auto, allowMobile: snapshot.allowMobile };
}

export class QueueStorage {
  private manifestKey;
  private chunkPrefix;
  constructor(private storage: Storage, private key: string) {
    this.manifestKey = `${key}.manifest`;
    this.chunkPrefix = `${key}.chunk.`;
  }
  private parseManifest(raw: string): Manifest {
    const manifest = JSON.parse(raw) as Manifest;
    if (manifest.version !== 2 || !/^[a-z0-9-]+$/.test(manifest.generation)
      || !Number.isSafeInteger(manifest.chunks) || manifest.chunks < 0 || manifest.chunks > 100_000) {
      throw new Error('Saved queue manifest is invalid.');
    }
    return manifest;
  }
  private chunkKey(generation: string, index: number) {
    return `${this.chunkPrefix}${generation}.${index}`;
  }
  private async cleanup(generation?: string, removeLegacy = false): Promise<void> {
    const activePrefix = generation ? `${this.chunkPrefix}${generation}.` : undefined;
    const obsolete = (await this.storage.getAllKeys()).filter(key =>
      (removeLegacy && key === this.key)
      || (key.startsWith(this.chunkPrefix) && (!activePrefix || !key.startsWith(activePrefix))));
    for (let offset = 0; offset < obsolete.length; offset += 100) {
      await this.storage.multiRemove(obsolete.slice(offset, offset + 100));
    }
  }
  async read(): Promise<QueueSnapshot | null> {
    const raw = await this.storage.getItem(this.manifestKey);
    if (!raw) {
      const legacy = await this.storage.getItem(this.key);
      return legacy ? JSON.parse(legacy) as QueueSnapshot : null;
    }
    const manifest = this.parseManifest(raw);
    const queue: QueueItem[] = [];
    for (let index = 0; index < manifest.chunks; index++) {
      const rawChunk = await this.storage.getItem(this.chunkKey(manifest.generation, index));
      if (rawChunk === null) throw new Error('A saved queue chunk is missing.');
      const items = JSON.parse(rawChunk);
      if (!Array.isArray(items)) throw new Error('A saved queue chunk is invalid.');
      queue.push(...items);
    }
    return { queue, auto: manifest.auto === true, allowMobile: manifest.allowMobile === true };
  }
  // The engine serializes writes. Publish one small manifest only after every chunk is durable.
  async write(encoded: EncodedQueue): Promise<void> {
    const published = await this.storage.getItem(this.manifestKey);
    await this.cleanup(published ? this.parseManifest(published).generation : undefined);
    const generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    for (let index = 0; index < encoded.chunks.length; index++) {
      await this.storage.setItem(this.chunkKey(generation, index), encoded.chunks[index]);
    }
    const manifest: Manifest = {
      version: 2, generation, chunks: encoded.chunks.length,
      auto: encoded.auto, allowMobile: encoded.allowMobile,
    };
    await this.storage.setItem(this.manifestKey, JSON.stringify(manifest));
    // Post-publication cleanup is optional; the next write reclaims interrupted generations first.
    try {
      await this.cleanup(generation, true);
    } catch {}
  }
}
