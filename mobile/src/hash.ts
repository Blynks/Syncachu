import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { checkCancelled, MAX_SIZE } from './core';

export const HASH_CHUNK_SIZE = 256 * 1024;

export async function hashChunks(
  size: number, read: (length: number) => Uint8Array, signal: AbortSignal,
  progress: (ratio: number) => void,
): Promise<string> {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_SIZE) throw new Error('Choose a non-empty file up to 2 GiB.');
  const hash = sha256.create();
  let consumed = 0;
  try {
    while (consumed < size) {
      checkCancelled(signal);
      const requested = Math.min(HASH_CHUNK_SIZE, size - consumed);
      const chunk = read(requested);
      if (!chunk.length || chunk.length > requested) throw new Error('Original changed while reading.');
      hash.update(chunk);
      consumed += chunk.length;
      progress(consumed / size);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    checkCancelled(signal);
    return bytesToHex(hash.digest());
  } finally { hash.destroy(); }
}
