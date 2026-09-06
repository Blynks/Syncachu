import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import * as Network from 'expo-network';
import * as MediaLibrary from 'expo-media-library';
import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';
import { Api } from './api';
import { canUpload, checkCancelled, MediaItem, mergeQueue, Policy, QueueItem, shouldSkipSelection } from './core';
import { contentType, removeOwnedFile, userDirectory } from './device';
import { upload } from './upload';
import { encodeQueue, QueueStorage } from './queueStorage';

type Snapshot = {
  ready: boolean; queue: QueueItem[]; allowMobile: boolean; auto: boolean;
  online: boolean; active: boolean; scanning: boolean; message: string;
  gallery: MediaItem[]; cursor?: string; galleryBusy: boolean;
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
  private rescan = false;
  private job?: { key: string; controller: AbortController };
  private policy: Policy = { active: AppState.currentState === 'active', connected: false, reachable: false, wifi: false, allowMobile: false };
  private state: Snapshot = {
    ready: false, queue: [], allowMobile: false, auto: false, online: false,
    active: AppState.currentState === 'active', scanning: false, message: '',
    gallery: [], galleryBusy: false,
  };
  constructor(readonly userId: string) {
    this.api = new Api(userId, this.session.signal);
    this.directory = userDirectory(userId);
    this.queueStorage = new QueueStorage(AsyncStorage, `syncachu.v1.${encodeURIComponent(userId)}`);
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
      this.update({ ready: true, active: this.policy.active });
      this.subscriptions.push(
        Network.addNetworkStateListener(state => this.network(state)),
        AppState.addEventListener('change', state => {
          this.policy.active = state === 'active';
          this.update({ active: this.policy.active });
          this.reconcile();
          if (this.policy.active) {
            void Network.getNetworkStateAsync().then(state => this.network(state)).catch(() => {});
            void this.scanIfAuto();
          }
        }),
        MediaLibrary.addListener(() => { void this.scanIfAuto(); }),
      );
      this.network(await Network.getNetworkStateAsync());
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
    if (!canUpload(this.policy)) this.job?.controller.abort();
    else {
      void this.pump();
    }
  }
  error(error: unknown) {
    if (!this.session.signal.aborted) this.update({ message: error instanceof Error ? error.message : 'Something went wrong. Please retry.' });
  }
  async setMobile(value: boolean) {
    this.policy.allowMobile = value;
    this.update({ allowMobile: value });
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
    this.update({ queue: this.state.queue.map(item => item.status === 'error' && (!key || item.key === key)
      ? { ...item, status: 'queued', error: undefined } : item), message: '' });
    try { await this.persist(); void this.pump(); } catch (error) { this.error(error); }
  }
  async cancel(key: string) {
    const cancelled = this.state.queue.find(item => item.key === key);
    this.update({ queue: this.state.queue.map(item => item.key === key ? { ...item, status: 'cancelled' } : item) });
    if (this.job?.key === key) this.job.controller.abort();
    try {
      await this.persist();
      removeOwnedFile(cancelled?.uri, this.directory);
    } catch (error) { this.error(error); }
  }
  private async pump() {
    if (this.running || !this.state.ready || this.session.signal.aborted || !canUpload(this.policy)) return;
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
            item.status = controller.signal.aborted ? 'queued' : 'error';
            item.error = controller.signal.aborted ? undefined : error instanceof Error ? error.message : 'Upload failed. Retry to resume.';
            this.update({ queue: [...this.state.queue] });
            try { await this.persist(); } catch (storageError) { this.error(storageError); break; }
          }
        } finally {
          this.session.signal.removeEventListener('abort', abort);
          this.job = undefined;
        }
      }
    } finally { this.running = false; }
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
  async destroy() {
    this.session.abort();
    this.job?.controller.abort();
    this.subscriptions.forEach(subscription => subscription.remove());
    this.listeners.clear();
    await this.writeChain.catch(() => {});
  }
}
