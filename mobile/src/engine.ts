import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import * as Network from 'expo-network';
import * as MediaLibrary from 'expo-media-library';
import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';
import { Api, ApiError, API_URL, BLOB_HOST } from './api';
import { canUpload, checkCancelled, MediaItem, mergeQueue, parseStorageUsage, Policy, QueueItem, shouldSkipSelection, StorageUsage } from './core';
import { contentType, removeOwnedFile, userDirectory } from './device';
import { upload } from './upload';
import { encodeQueue, QueueStorage } from './queueStorage';
import { BackgroundBackup } from './background';

type Snapshot = {
  ready: boolean; queue: QueueItem[]; allowMobile: boolean; auto: boolean;
  online: boolean; active: boolean; scanning: boolean; message: string;
  gallery: MediaItem[]; cursor?: string; galleryBusy: boolean;
  usage?: StorageUsage; usageBusy: boolean; usageError: string;
  background: boolean;
};

export class SyncEngine {
  readonly session = new AbortController();
  readonly api: Api;
  private directory;
  private queueStorage;
  private listeners = new Set<() => void>();
  private subscriptions: { remove(): void }[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private running = false;
  private quotaBlocked?: string;
  private wakeRequested = false;
  private rescan = false;
  private job?: { key: string; controller: AbortController };
  private background;
  private backgroundReady = false;
  private nativeRun?: Promise<void>;
  private nativeWake = false;
  private nativeRefresh?: Promise<void>;
  private poll?: ReturnType<typeof setInterval>;
  private closing?: Promise<void>;
  private policy: Policy = { active: AppState.currentState === 'active', connected: false, reachable: false, wifi: false, allowMobile: false };
  private state: Snapshot = {
    ready: false, queue: [], allowMobile: false, auto: false, online: false,
    active: AppState.currentState === 'active', scanning: false, message: '',
    gallery: [], galleryBusy: false,
    usageBusy: false, usageError: '',
    background: false,
  };
  constructor(readonly userId: string) {
    this.api = new Api(userId, this.session.signal);
    this.directory = userDirectory(userId);
    this.queueStorage = new QueueStorage(AsyncStorage, `syncachu.v1.${encodeURIComponent(userId)}`);
    this.background = new BackgroundBackup(userId);
    this.state.background = this.background.available;
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private update(patch: Partial<Snapshot>) {
    if (this.session.signal.aborted) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  private async persist() {
    checkCancelled(this.session.signal);
    const data = encodeQueue({ queue: this.state.queue, auto: this.state.auto, allowMobile: this.state.allowMobile });
    this.writeChain = this.writeChain.catch(() => {}).then(() => this.queueStorage.write(data));
    await this.writeChain;
  }
  private assertActive() {
    checkCancelled(this.session.signal);
    if (!this.policy.active) throw new Error('Paused. Open the app to continue.');
  }
  async initialize() {
    try {
      const saved = await this.queueStorage.read();
      checkCancelled(this.session.signal);
      if (saved) {
        if (!Array.isArray(saved.queue)) throw new Error('Invalid saved queue.');
        this.update({
          queue: saved.queue.map((item: QueueItem) => ({ ...item, status: item.status === 'working' ? 'queued' : item.status })),
          auto: saved.auto === true, allowMobile: saved.allowMobile === true,
        });
        this.policy.allowMobile = this.state.allowMobile;
      }
      this.policy.active = AppState.currentState === 'active';
      if (this.background.available && this.policy.active) {
        try { await this.configureBackground(); } catch (error) { this.error(error); }
      }
      this.policy.active = AppState.currentState === 'active';
      this.update({ ready: true, active: this.policy.active });
      this.subscriptions.push(
        Network.addNetworkStateListener(state => this.network(state)),
        AppState.addEventListener('change', state => {
          this.policy.active = state === 'active';
          this.update({ active: this.policy.active });
          this.reconcile();
          if (this.policy.active) {
            if (this.background.available) void this.configureBackground().then(() => this.pump()).catch(error => this.error(error));
            void Network.getNetworkStateAsync().then(state => this.network(state)).catch(() => {});
            void this.scanIfAuto();
          }
        }),
        MediaLibrary.addListener(() => { void this.scanIfAuto(); }),
      );
      if (this.background.available) {
        this.poll = setInterval(() => {
          if (this.policy.active) void this.pump();
        }, 1000);
      }
      this.network(await Network.getNetworkStateAsync());
      await Promise.all([this.loadGallery(), this.loadUsage()]);
      await this.scanIfAuto();
    } catch (error) { this.error(error); }
  }
  private network(state: Network.NetworkState) {
    this.policy.connected = state.isConnected === true;
    this.policy.reachable = state.isInternetReachable === true;
    this.policy.wifi = state.type === Network.NetworkStateType.WIFI;
    this.update({ online: this.policy.connected && this.policy.reachable });
    this.reconcile();
  }
  private reconcile() {
    if (this.background.available) { void this.pump(); return; }
    if (!canUpload(this.policy)) this.job?.controller.abort();
    else {
      void this.pump();
    }
  }
  error(error: unknown) {
    if (!this.session.signal.aborted) this.update({ message: error instanceof Error ? error.message : 'Something went wrong. Please retry.' });
  }
  async setMobile(value: boolean) {
    const previous = this.state.allowMobile;
    this.policy.allowMobile = value;
    this.update({ allowMobile: value });
    try {
      checkCancelled(this.session.signal);
      if (this.background.available) await this.background.setMobile(value);
      checkCancelled(this.session.signal);
    } catch (error) {
      if (this.state.allowMobile === value) {
        this.policy.allowMobile = previous;
        this.update({ allowMobile: previous });
      }
      this.error(error);
      return;
    }
    this.reconcile();
    try { await this.persist(); } catch (error) { this.error(error); }
  }
  async setAuto(value: boolean) {
    try {
      this.assertActive();
      if (value) {
        const permission = await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video']);
        this.assertActive();
        if (!permission.granted) throw new Error('Photo access was denied. Enable access in device settings.');
      }
      this.update({ auto: value });
      await this.persist();
      if (value) await this.scan(false);
    } catch (error) { this.error(error); }
  }
  private async scanIfAuto() {
    if (this.state.auto && this.policy.active && this.state.ready) {
      if (this.state.scanning) { this.rescan = true; return; }
      await this.scan(false);
    }
  }
  async scan(requestPermission = true) {
    if (this.state.scanning || !this.state.ready || this.session.signal.aborted) return;
    this.update({ scanning: true, message: '' });
    try {
      const permission = requestPermission
        ? await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video'])
        : await MediaLibrary.getPermissionsAsync(false, ['photo', 'video']);
      this.assertActive();
      if (!permission.granted) throw new Error('Photo access is not granted. Use Choose files or enable photo access in Settings.');
      let offset = 0;
      while (true) {
        this.assertActive();
        if (!requestPermission && !this.state.auto) break;
        const assets = await new MediaLibrary.Query()
          .within(MediaLibrary.AssetField.MEDIA_TYPE, [MediaLibrary.MediaType.IMAGE, MediaLibrary.MediaType.VIDEO])
          .orderBy(MediaLibrary.AssetField.CREATION_TIME).offset(offset).limit(100).exeForMetadata();
        this.assertActive();
        const incoming: QueueItem[] = assets.map(asset => ({
          key: `asset:${asset.id}`, assetId: asset.id, revision: asset.modificationTime,
          name: asset.filename || asset.id, contentType: contentType(asset.filename || '', asset.mediaType === MediaLibrary.MediaType.VIDEO),
          status: 'queued', progress: 0, blocks: [],
        }));
        const next = mergeQueue(this.state.queue, incoming);
        if (this.job && next.find(item => item.key === this.job!.key) !== this.state.queue.find(item => item.key === this.job!.key)) {
          this.job.controller.abort();
        }
        this.update({ queue: next });
        await this.persist();
        void this.pump();
        if (assets.length < 100) break;
        offset += assets.length;
      }
      this.update({ message: permission.accessPrivileges === 'limited'
        ? 'Queued all accessible photos and videos. Your library permission is limited.'
        : 'Library scan complete. Duplicates are skipped automatically.' });
    } catch (error) { this.error(error); }
    finally {
      this.update({ scanning: false });
      if (this.rescan) { this.rescan = false; void this.scanIfAuto(); }
    }
  }
  async pick() {
    const created: string[] = [];
    const replaced: string[] = [];
    let accepted = false;
    try {
      this.assertActive();
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, selectionLimit: 20,
        allowsEditing: false, quality: 1,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
        videoExportPreset: ImagePicker.VideoExportPreset.Passthrough, shouldDownloadFromNetwork: false,
      });
      this.assertActive();
      if (result.canceled) return;
      const incoming: QueueItem[] = [];
      for (const asset of result.assets) {
        this.assertActive();
        const key = asset.assetId ? `asset:${asset.assetId}` : `picked:${asset.uri}`;
        const existing = this.state.queue.find(item => item.key === key);
        if (shouldSkipSelection(existing) || incoming.some(item => item.key === key)) continue;
        const source = new File(asset.uri);
        const destination = new File(this.directory, `${Date.now()}-${Math.random().toString(36).slice(2)}${source.extension}`);
        created.push(destination.uri);
        await source.copy(destination);
        this.assertActive();
        const name = asset.fileName || source.name;
        incoming.push({
          ...existing,
          key, name, uri: destination.uri, contentType: asset.mimeType || contentType(name, asset.type === 'video'),
          assetId: undefined, status: 'queued', error: undefined, blocks: existing?.blocks ?? [], progress: 0,
          backgroundId: undefined,
        });
        if (existing?.uri) replaced.push(existing.uri);
      }
      this.update({ queue: [...this.state.queue.filter(old => !incoming.some(item => item.key === old.key)), ...incoming] });
      accepted = true;
      await this.persist();
      replaced.forEach(uri => removeOwnedFile(uri, this.directory));
      this.update({ message: `${incoming.length} selected file(s) queued. Originals on your device are never modified.` });
      void this.pump();
    } catch (error) { this.error(error); }
    finally { if (!accepted) created.forEach(uri => removeOwnedFile(uri, this.directory)); }
  }
  async retry(key?: string) {
    if (this.background.available) {
      try {
        this.assertActive();
        await this.configureBackground();
        // Read native failures first: the last visible status may predate suspension.
        await this.pump();
        checkCancelled(this.session.signal);
        const failed = this.state.queue.filter(item => item.status === 'error' && (!key || item.key === key));
        await this.background.retry(failed.flatMap(item => item.backgroundId ? [item.backgroundId] : []));
        checkCancelled(this.session.signal);
      } catch (error) { this.error(error); return; }
    }
    this.quotaBlocked = undefined;
    this.update({ queue: this.state.queue.map(item => item.status === 'error' && (!key || item.key === key)
      ? { ...item, status: 'queued', error: undefined } : item), message: '' });
    try { await this.persist(); void this.pump(); } catch (error) { this.error(error); }
  }
  async cancel(key: string) {
    const cancelled = this.state.queue.find(item => item.key === key);
    if (this.quotaBlocked === key) this.quotaBlocked = undefined;
    this.update({ queue: this.state.queue.map(item => item.key === key ? { ...item, status: 'cancelled' } : item) });
    if (this.job?.key === key) this.job.controller.abort();
    try {
      await this.persist();
      if (cancelled?.backgroundId && this.background.available) await this.background.cancel(cancelled.backgroundId);
      removeOwnedFile(cancelled?.uri, this.directory);
      void this.pump();
    } catch (error) { this.error(error); }
  }
  private async pump() {
    if (this.background.available) {
      if (this.nativeRun) { this.nativeWake = true; return this.nativeRun; }
      if (!this.backgroundReady || !this.state.ready || !this.policy.active || this.session.signal.aborted) return;
      const pending = this.syncBackground().catch(error => this.error(error));
      this.nativeRun = pending;
      try { await pending; }
      finally {
        this.nativeRun = undefined;
        if (this.nativeWake) { this.nativeWake = false; void this.pump(); }
      }
      return;
    }
    if (this.running) { this.wakeRequested = true; return; }
    if (this.quotaBlocked || !this.state.ready || this.session.signal.aborted || !canUpload(this.policy)) return;
    this.running = true;
    try {
      while (canUpload(this.policy) && !this.session.signal.aborted) {
        const item = this.state.queue.find(item => item.status === 'queued');
        if (!item) break;
        const controller = new AbortController();
        this.job = { key: item.key, controller };
        const abort = () => controller.abort();
        this.session.signal.addEventListener('abort', abort);
        const save = async (patch: Partial<QueueItem>) => {
          checkCancelled(controller.signal);
          Object.assign(item, patch);
          this.update({ queue: [...this.state.queue] });
          await this.persist();
          checkCancelled(controller.signal);
        };
        try {
          await save({ status: 'working', error: undefined });
          const media = await upload(item, this.api, controller.signal, save, progress => {
            if (!controller.signal.aborted) { item.progress = progress; this.update({ queue: [...this.state.queue] }); }
          });
          await save({ status: 'done', progress: 1, blocks: [], uploadId: undefined });
          this.update({ gallery: [media, ...this.state.gallery.filter(existing => existing.id !== media.id)] });
          removeOwnedFile(item.uri, this.directory);
        } catch (error) {
          if (this.session.signal.aborted) break;
          if (this.state.queue.includes(item)) {
            const blockedByQuota = !controller.signal.aborted && error instanceof ApiError && error.status === 507;
            if (blockedByQuota) this.quotaBlocked = item.key;
            item.status = controller.signal.aborted ? 'queued' : 'error';
            item.error = controller.signal.aborted ? undefined : error instanceof Error ? error.message : 'Upload failed. Retry to resume.';
            this.update({ queue: [...this.state.queue], ...(blockedByQuota ? { message: error.message } : {}) });
            try { await this.persist(); } catch (storageError) { this.error(storageError); break; }
            if (blockedByQuota) break;
          }
        } finally {
          this.session.signal.removeEventListener('abort', abort);
          this.job = undefined;
          await this.loadUsage();
        }
      }
    } finally {
      this.running = false;
      if (this.wakeRequested) { this.wakeRequested = false; void this.pump(); }
    }
  }
  private async configureBackground() {
    if (this.nativeRefresh) return this.nativeRefresh;
    const refresh = async () => {
      this.assertActive();
      const token = await this.api.token();
      this.assertActive();
      await this.background.configure(API_URL, BLOB_HOST, token, this.state.allowMobile);
      checkCancelled(this.session.signal);
      this.backgroundReady = true;
    };
    const pending = refresh();
    this.nativeRefresh = pending;
    try { await pending; } finally { this.nativeRefresh = undefined; }
  }
  private async syncBackground() {
    const jobs = await this.background.snapshot();
    checkCancelled(this.session.signal);
    const items = new Map(this.state.queue.filter(item => item.backgroundId).map(item => [item.backgroundId, item]));
    const acknowledge: string[] = [];
    const cancel: string[] = [];
    const remove: string[] = [];
    let changed = false;
    let completed = false;
    for (const job of jobs) {
      const item = items.get(job.id);
      if (!item || item.status === 'cancelled') {
        if (job.status !== 'done' && job.status !== 'cancelled') cancel.push(job.id);
        if (item?.uri) remove.push(item.uri);
        acknowledge.push(job.id);
        continue;
      }
      if (item.status === 'done') {
        if (job.status === 'done') {
          acknowledge.push(job.id);
          if (item.uri) remove.push(item.uri);
        }
        continue;
      }
      if (item.status !== job.status || item.progress !== job.progress || item.error !== job.error) {
        Object.assign(item, { status: job.status, progress: job.progress, error: job.error });
        changed = true;
      }
      if (job.httpStatus === 507 || job.httpStatus === 401 || job.httpStatus === 403) {
        this.update({ message: job.error || 'Backup paused. Open Syncachu and retry.' });
      }
      if (job.status === 'done' && job.media) {
        this.update({ gallery: [job.media, ...this.state.gallery.filter(media => media.id !== job.media!.id)] });
        if (item.uri) remove.push(item.uri);
        acknowledge.push(job.id);
        completed = true;
      } else if (job.status === 'cancelled') {
        if (item.uri) remove.push(item.uri);
        acknowledge.push(job.id);
      }
    }
    if (changed || acknowledge.length) {
      this.update({ queue: [...this.state.queue] });
      // Native completions survive process death until the JS queue is durably updated.
      await this.persist();
      checkCancelled(this.session.signal);
      for (const id of cancel) await this.background.cancel(id);
      if (acknowledge.length) await this.background.acknowledge(acknowledge);
      remove.forEach(uri => removeOwnedFile(uri, this.directory));
    }
    const known = new Set(jobs.map(job => job.id));
    const missing = this.state.queue.filter(item => (item.status === 'queued' || item.status === 'working')
      && (!item.backgroundId || !known.has(item.backgroundId)));
    if (missing.length && this.policy.active) {
      for (const item of missing) {
        item.backgroundId ??= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      }
      this.update({ queue: [...this.state.queue] });
      await this.persist();
      this.assertActive();
      const currentItems = new Set(this.state.queue);
      const current = missing.filter(item => currentItems.has(item) && (item.status === 'queued' || item.status === 'working'));
      if (current.length) await this.background.enqueue(current);
    }
    if (completed) await this.loadUsage();
  }
  async loadGallery(more = false) {
    if (this.state.galleryBusy || (more && !this.state.cursor)) return;
    this.update({ galleryBusy: true });
    try {
      const query = more ? `?cursor=${encodeURIComponent(this.state.cursor!)}` : '';
      const result = await this.api.request<{ items: MediaItem[]; nextCursor?: string }>(`media${query}`);
      checkCancelled(this.session.signal);
      const gallery = more ? [...this.state.gallery] : [];
      for (const item of result.items) if (!gallery.some(existing => existing.id === item.id)) gallery.push(item);
      this.update({ gallery, cursor: result.nextCursor });
    } catch (error) { this.error(error); }
    finally { this.update({ galleryBusy: false }); }
  }
  async loadUsage() {
    if (this.state.usageBusy || this.session.signal.aborted) return;
    this.update({ usageBusy: true, usageError: '' });
    try {
      const usage = parseStorageUsage(await this.api.request<unknown>('usage'));
      checkCancelled(this.session.signal);
      this.update({ usage });
    } catch (error) {
      this.update({ usage: undefined, usageError: error instanceof Error ? error.message : 'Storage usage unavailable. Try Refresh.' });
    } finally { this.update({ usageBusy: false }); }
  }
  async destroy() {
    if (this.closing) return this.closing;
    this.session.abort();
    this.job?.controller.abort();
    this.subscriptions.forEach(subscription => subscription.remove());
    this.listeners.clear();
    if (this.poll) clearInterval(this.poll);
    this.closing = Promise.all([
      this.background.stop(), this.writeChain.catch(() => {}), this.api.drain(), this.nativeRun,
    ]).then(() => {});
    return this.closing;
  }
}
