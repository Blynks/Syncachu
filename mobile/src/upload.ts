import { FileMode } from 'expo-file-system';
import { fetch } from 'expo/fetch';
import { Api, ApiError, BLOB_HOST } from './api';
import { BLOCK_SIZE, checkCancelled, isSupportedContentType, MediaItem, planBlocks, QueueItem, sameContent, trustedBlobUrl, UploadTicket } from './core';
import { hashFile, resolveFile, thumbnail } from './device';

export async function upload(
  source: QueueItem, api: Api, signal: AbortSignal,
  persist: (patch: Partial<QueueItem>) => Promise<void>,
  progress: (value: number) => void,
): Promise<MediaItem> {
  checkCancelled(signal);
  if (!isSupportedContentType(source.contentType)) {
    throw new Error(`Unsupported media type: ${source.contentType}. Choose JPEG, PNG, GIF, WebP, HEIC/HEIF, AVIF, MP4, MOV, WebM, M4V or 3GP.`);
  }
  const item = { ...source, blocks: [...source.blocks] };
  const save = async (patch: Partial<QueueItem>) => {
    await persist(patch);
    Object.assign(item, patch);
  };
  const file = await resolveFile(item, signal);
  const fingerprint = await hashFile(file, signal, ratio => progress(ratio * 0.15));
  checkCancelled(signal);
  if (!sameContent(item, fingerprint.sha256, fingerprint.size)) {
    await save({ sha256: fingerprint.sha256, size: fingerprint.size, uploadId: undefined, blocks: [], hasThumbnail: undefined });
  }
  const preview = await thumbnail(file, item.contentType.startsWith('video/'), signal);
  try {
    let ticket: UploadTicket | undefined;
    if (item.uploadId) {
      try {
        ticket = await api.request<UploadTicket>(`uploads/${encodeURIComponent(item.uploadId)}/renew`, {}, signal);
      } catch (error) {
        if (!(error instanceof ApiError) || ![404, 409].includes(error.status)) throw error;
        await save({ uploadId: undefined, blocks: [], hasThumbnail: undefined });
      }
    }
    if (!ticket) {
      const result = await api.request<UploadTicket | { duplicate: true; media: MediaItem }>('uploads', {
        sha256: fingerprint.sha256, size: fingerprint.size, contentType: item.contentType,
        name: item.name, hasThumbnail: !!preview,
      }, signal);
      if (result.duplicate) return result.media;
      ticket = result;
      await save({ uploadId: ticket.uploadId, hasThumbnail: !!preview, blocks: [] });
    }
    const validate = () => {
      if (ticket!.blockSize !== BLOCK_SIZE || !Number.isFinite(Date.parse(ticket!.expiresAt))
        || ticket!.uploadId !== item.uploadId) throw new Error('Invalid upload ticket.');
      trustedBlobUrl(ticket!.uploadUrl, BLOB_HOST);
      if (ticket!.thumbnailUploadUrl) trustedBlobUrl(ticket!.thumbnailUploadUrl, BLOB_HOST);
    };
    validate();
    const renew = async () => {
      ticket = await api.request<UploadTicket>(`uploads/${encodeURIComponent(item.uploadId!)}/renew`, {}, signal);
      validate();
    };
    const put = async (kind: 'original' | 'thumbnail', query: Record<string, string>, body: Uint8Array<ArrayBuffer> | string, headers: Record<string, string>) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        checkCancelled(signal);
        if (Date.parse(ticket!.expiresAt) < Date.now() + 30_000) await renew();
        const raw = kind === 'original' ? ticket!.uploadUrl : ticket!.thumbnailUploadUrl;
        if (!raw) throw new Error('Missing thumbnail upload ticket.');
        const url = trustedBlobUrl(raw, BLOB_HOST);
        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
        // SAS is the only credential sent to Azure. Never reuse backend headers.
        const response = await fetch(url.toString(), {
          method: 'PUT', headers: { 'x-ms-version': '2023-11-03', ...headers },
          body, signal, redirect: 'error', credentials: 'omit',
        });
        checkCancelled(signal);
        if (response.ok) return;
        if (response.status === 403 && attempt === 0) { await renew(); continue; }
        if (response.status === 400 && query.comp === 'blocklist') {
          // Azure may have discarded old uncommitted blocks while the app was closed.
          await save({ blocks: [] });
        }
        throw new Error(`Storage upload failed (${response.status}). Retry to resume.`);
      }
    };
    const blocks = planBlocks(fingerprint.size, item.blocks);
    const handle = file.open(FileMode.ReadOnly);
    try {
      for (const block of blocks) {
        checkCancelled(signal);
        if (!block.done) {
          handle.offset = block.offset;
          const bytes = handle.readBytes(block.size);
          if (bytes.length !== block.size) throw new Error('Original changed during upload. Retry.');
          await put('original', { comp: 'block', blockid: block.id }, bytes, { 'Content-Type': 'application/octet-stream' });
          await save({ blocks: [...item.blocks, block.index] });
        }
        progress(0.15 + 0.8 * ((block.offset + block.size) / fingerprint.size));
      }
    } finally { handle.close(); }
    const now = file.info();
    if (now.size !== fingerprint.size || now.modificationTime !== fingerprint.modified) {
      await save({ uploadId: undefined, blocks: [], sha256: undefined });
      throw new Error('Original changed during upload. Retry.');
    }
    await put('original', { comp: 'blocklist' },
      `<?xml version="1.0" encoding="utf-8"?><BlockList>${blocks.map(b => `<Latest>${b.id}</Latest>`).join('')}</BlockList>`,
      { 'Content-Type': 'application/xml', 'x-ms-blob-content-type': item.contentType });
    if (item.hasThumbnail) {
      if (!preview) throw new Error('Could not regenerate thumbnail. Retry when the original is available.');
      await put('thumbnail', {}, await preview.bytes(), { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'image/jpeg' });
    }
    progress(0.98);
    try {
      return await api.request<MediaItem>(`uploads/${encodeURIComponent(item.uploadId!)}/complete`, {}, signal);
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) await save({ blocks: [] });
      throw error;
    }
  } finally { if (preview?.exists) preview.delete(); }
}
