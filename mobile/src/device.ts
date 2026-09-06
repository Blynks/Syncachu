import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { checkCancelled, MAX_SIZE, QueueItem } from './core';
import { hashChunks } from './hash';

export function contentType(name: string, video = false): string {
  const ext = name.split('.').pop()?.toLowerCase();
  const known: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic',
    heif: 'image/heif', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
    mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v',
    webm: 'video/webm', '3gp': 'video/3gpp', mkv: 'video/x-matroska',
  };
  return known[ext ?? ''] ?? (video ? 'video/mp4' : 'application/octet-stream');
}

export function userDirectory(userId: string): Directory {
  const key = bytesToHex(sha256(new TextEncoder().encode(userId)));
  const directory = new Directory(Paths.document, 'syncachu', key);
  directory.create({ intermediates: true, idempotent: true });
  return directory;
}

export async function resolveFile(item: QueueItem, signal: AbortSignal): Promise<File> {
  checkCancelled(signal);
  let uri = item.uri;
  if (item.assetId) {
    const asset = new MediaLibrary.Asset(item.assetId);
    if (Platform.OS === 'ios' && await asset.getIsInCloud()) {
      throw new Error('This original is in iCloud. Download it in Photos, then retry.');
    }
    uri = await asset.getUri();
  }
  checkCancelled(signal);
  if (!uri || (!uri.startsWith('file://') && !uri.startsWith('content://'))) {
    throw new Error('Original is not available locally. Download it in Photos or select it again.');
  }
  const file = new File(uri);
  if (!file.exists) throw new Error('Original is unavailable. Restore permission or select it again.');
  return file;
}

export async function hashFile(file: File, signal: AbortSignal, progress: (ratio: number) => void) {
  const before = file.info();
  const size = before.size ?? 0;
  if (!size || size > MAX_SIZE) throw new Error('Choose a non-empty file up to 2 GiB.');
  const handle = file.open(FileMode.ReadOnly);
  try {
    const digest = await hashChunks(size, length => handle.readBytes(length), signal, progress);
    checkCancelled(signal);
    const after = file.info();
    if (after.size !== before.size || after.modificationTime !== before.modificationTime) {
      throw new Error('Original changed while hashing. Retry.');
    }
    return { sha256: digest, size, modified: after.modificationTime };
  } finally { handle.close(); }
}

export async function thumbnail(file: File, video: boolean, signal: AbortSignal): Promise<File | undefined> {
  let frame: File | undefined;
  try {
    const source = video ? (await VideoThumbnails.getThumbnailAsync(file.uri, { time: 0 })).uri : file.uri;
    if (video) frame = new File(source);
    checkCancelled(signal);
    const context = ImageManipulator.manipulate(source);
    context.resize({ width: 480 });
    const image = await context.renderAsync();
    try {
      const result = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.65 });
      const output = new File(result.uri);
      if (signal.aborted || output.size > 1024 * 1024) { output.delete(); return undefined; }
      return output;
    } finally { image.release(); context.release(); }
  } catch {
    checkCancelled(signal);
    return undefined;
  } finally { if (frame?.exists) frame.delete(); }
}

export function removeOwnedFile(uri: string | undefined, directory: Directory) {
  const prefix = `${directory.uri.replace(/\/+$/, '')}/`;
  if (uri?.startsWith(prefix)) {
    try { const file = new File(uri); if (file.exists) file.delete(); } catch {}
  }
}
