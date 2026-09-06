import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Platform, Pressable, SafeAreaView, StyleSheet, Switch, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { fetch } from 'expo/fetch';
import { GoogleSignin, isSuccessResponse } from '@react-native-google-signin/google-signin';
import { BLOB_HOST, configurationError } from './src/api';
import { checkCancelled, formatStorageBytes, MediaItem, trustedBlobUrl } from './src/core';
import { SyncEngine } from './src/engine';

function Action({ title, onPress, disabled = false, secondary = false }: {
  title: string; onPress: () => void; disabled?: boolean; secondary?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
    onPress={onPress} style={({ pressed }) => [styles.button, secondary && styles.secondary, (pressed || disabled) && styles.dim]}>
    <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{title}</Text>
  </Pressable>;
}

function Toggle({ label, detail, value, onChange }: { label: string; detail: string; value: boolean; onChange: (value: boolean) => void }) {
  return <View style={styles.toggle}>
    <View style={styles.flex}><Text style={styles.label}>{label}</Text><Text style={styles.muted}>{detail}</Text></View>
    <Switch accessibilityLabel={label} value={value} onValueChange={onChange} trackColor={{ true: '#4D6889' }} />
  </View>;
}

function Thumbnail({ item, session }: { item: MediaItem; session: AbortSignal }) {
  const [uri, setUri] = useState<string>();
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    session.addEventListener('abort', abort);
    setUri(undefined);
    setError(false);
    if (item.thumbnailUrl) void (async () => {
      checkCancelled(session);
      const url = trustedBlobUrl(item.thumbnailUrl!, BLOB_HOST).toString();
      const response = await fetch(url, {
        signal: controller.signal, redirect: 'error', credentials: 'omit',
      });
      if (!response.ok) throw new Error('Thumbnail unavailable');
      if (!(response.headers.get('content-type') ?? '').startsWith('image/jpeg')) throw new Error('Invalid thumbnail');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 1024 * 1024) throw new Error('Thumbnail too large');
      checkCancelled(controller.signal);
      checkCancelled(session);
      let text = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      setUri(`data:image/jpeg;base64,${btoa(text)}`);
    })().catch(() => { if (!controller.signal.aborted && !session.aborted) setError(true); });
    return () => { controller.abort(); session.removeEventListener('abort', abort); };
  }, [item.thumbnailUrl, session]);
  return <View style={styles.mediaCard}>
    {uri ? <Image accessibilityLabel={`Thumbnail of ${item.name}`} source={{ uri }} style={styles.thumbnail} />
      : <View style={[styles.thumbnail, styles.placeholder]}><Text style={styles.muted}>{error ? 'Preview unavailable' : item.contentType.startsWith('video/') ? 'VIDEO' : 'PHOTO'}</Text></View>}
    <Text style={styles.mediaName} numberOfLines={2}>{item.name}</Text>
    <Text style={styles.muted}>{(item.size / 1024 / 1024).toFixed(1)} MB · Uploaded</Text>
  </View>;
}

function Library({ engine, email, onSignOut }: { engine: SyncEngine; email: string; onSignOut: () => void }) {
  const state = useSyncExternalStore(engine.subscribe, engine.snapshot);
  const [visibleQueue, setVisibleQueue] = useState(10);
  useEffect(() => { void engine.initialize(); return () => { void engine.destroy(); }; }, [engine]);
  const pending = state.queue.filter(item => item.status !== 'done' && item.status !== 'cancelled');
  const completed = state.queue.filter(item => item.status === 'done').length;
  const confirmAuto = (value: boolean) => {
    if (!value) { void engine.setAuto(false); return; }
    Alert.alert('Sync while this app is open?', 'Automatically queue all accessible photos and videos, including future additions, whenever Syncachu is open. Uploads follow your network preference. This is not continuous background backup.', [
      { text: 'Not now', style: 'cancel' }, { text: 'Enable', onPress: () => { void engine.setAuto(true); } },
    ]);
  };
  const header = <View style={styles.header}>
    <View style={styles.row}>
      <View style={styles.flex}><Text style={styles.eyebrow}>YOUR PRIVATE PHOTO CLOUD</Text><Text accessibilityRole="header" style={styles.title}>Syncachu</Text></View>
      <Action title="Sign out" secondary onPress={onSignOut} />
    </View>
    <Text style={styles.muted}>{email}</Text>
    <View style={styles.hero}>
      <Text accessibilityRole="header" style={styles.heroTitle}>A little space for every memory.</Text>
      <Text style={styles.heroText}>Original photos and videos, safely in your own cloud. Your device library stays untouched.</Text>
      <View style={styles.badge}><Text style={styles.badgeText}>{!state.active ? 'Paused · app is not active' : !state.online ? 'Offline · queue saved' : !state.allowMobile ? 'Uploads · Wi-Fi only' : 'Uploads · any connected network'}</Text></View>
    </View>
    <View style={styles.panel}>
      <Text accessibilityRole="header" style={styles.heading}>Instance storage</Text>
      {state.usage ? <>
        <Text style={styles.label}>{formatStorageBytes(state.usage.usedBytes)} saved / {formatStorageBytes(state.usage.limitBytes)} total</Text>
        <Text style={styles.muted}>{formatStorageBytes(state.usage.reservedBytes)} reserved for uploads · {formatStorageBytes(state.usage.availableBytes)} available</Text>
      </> : <Text accessibilityRole={state.usageError ? 'alert' : undefined} style={styles.muted}>
        {state.usageError || (state.usageBusy ? 'Loading storage usage…' : 'Storage usage unavailable. Tap Refresh.')}
      </Text>}
      <Text style={styles.note}>Shared across approved accounts. Counts saved originals, thumbnails, and upload reservations, not your Azure bill.</Text>
    </View>
    {!state.ready ? <ActivityIndicator accessibilityLabel="Loading saved queue" color="#405D80" /> : <>
      <View style={styles.actions}>
        <Action title="Choose files" onPress={() => { void engine.pick(); }} />
        <Action title={state.scanning ? 'Scanning library…' : 'Sync all'} secondary disabled={state.scanning}
          onPress={() => Alert.alert('Upload your accessible library?', 'This queues all photos and videos you grant access to. Cloud-only originals may need downloading in Photos first. Uploads use Wi-Fi unless you allow mobile data.', [
            { text: 'Cancel', style: 'cancel' }, { text: 'Sync all', onPress: () => { void engine.scan(); } },
          ])} />
      </View>
      <View style={styles.panel}>
        <Toggle label="Allow mobile data" detail="Off by default. Applies to manual uploads too." value={state.allowMobile} onChange={value => { void engine.setMobile(value); }} />
        <View style={styles.divider} />
        <Toggle label="Auto-sync when app is open" detail="Opt in to scan your accessible library while active." value={state.auto} onChange={confirmAuto} />
      </View>
    </>}
    <Text style={styles.note}>Keep Syncachu open to upload. Transfers pause when you leave and resume when you return on an allowed network. No continuous OS background sync.</Text>
    {!!state.message && <Text accessibilityRole="alert" style={styles.notice}>{state.message}</Text>}
    <View style={styles.row}><Text accessibilityRole="header" style={styles.heading}>Upload queue</Text><Text style={styles.muted}>{pending.length} pending · {completed} saved</Text></View>
    {pending.length === 0 && <Text style={styles.empty}>You’re all caught up. Choose a few memories to get started.</Text>}
    {pending.slice(0, visibleQueue).map(item => <View key={item.key} style={styles.queueItem}>
      <View style={styles.row}><Text numberOfLines={1} style={[styles.label, styles.flex]}>{item.name}</Text>
        <Text style={styles.muted}>{item.status === 'working' ? `${Math.round(item.progress * 100)}%` : item.status}</Text></View>
      <View accessibilityRole="progressbar" accessibilityLabel={`Upload progress for ${item.name}`} accessibilityValue={{ min: 0, max: 100, now: Math.round(item.progress * 100) }} style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${Math.round(item.progress * 100)}%` }]} />
      </View>
      {!!item.error && <Text accessibilityRole="alert" style={styles.error}>{item.error}</Text>}
      <View style={styles.actions}>
        {item.status === 'error' && <Action title="Retry" secondary onPress={() => { void engine.retry(item.key); }} />}
        <Action title="Cancel" secondary onPress={() => { void engine.cancel(item.key); }} />
      </View>
    </View>)}
    {pending.length > visibleQueue && <Action title="Show more queued files" secondary onPress={() => setVisibleQueue(value => value + 20)} />}
    {pending.some(item => item.status === 'error') && <Action title="Retry failed uploads" onPress={() => { void engine.retry(); }} />}
    <View style={styles.row}><Text accessibilityRole="header" style={styles.heading}>Saved memories</Text>
      <Action title={state.galleryBusy || state.usageBusy ? 'Loading…' : 'Refresh'} secondary disabled={state.galleryBusy || state.usageBusy}
        onPress={() => { void engine.loadGallery(); void engine.loadUsage(); }} /></View>
    <Text style={styles.note}>Private, short-lived previews. Tap Refresh to load your cloud library or renew expired links.</Text>
  </View>;
  return <FlatList data={state.gallery} numColumns={2} keyExtractor={item => item.id} ListHeaderComponent={header}
    contentContainerStyle={styles.list} columnWrapperStyle={styles.galleryRow}
    renderItem={({ item }) => <Thumbnail item={item} session={engine.session.signal} />}
    ListEmptyComponent={<Text style={styles.empty}>Your uploaded memories will appear here.</Text>}
    ListFooterComponent={state.cursor ? <Action title="Load more memories" secondary disabled={state.galleryBusy} onPress={() => { void engine.loadGallery(true); }} /> : <View style={{ height: 32 }} />} />;
}

export default function App() {
  const [account, setAccount] = useState<{ engine: SyncEngine; email: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const authBusy = useRef(false);
  const current = useRef(account);
  current.current = account;
  const issue = configurationError() || (Platform.OS === 'ios'
    && (!process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || !process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME)
    ? 'Set the iOS Google client ID and URL scheme, then rebuild the development client.' : undefined);
  const signIn = async () => {
    if (authBusy.current) return;
    authBusy.current = true;
    setBusy(true); setError('');
    try {
      if (issue) throw new Error(issue);
      await GoogleSignin.configure({
        webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
        iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
        offlineAccess: false,
      });
      if (Platform.OS === 'android') await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      const result = await GoogleSignin.signIn();
      if (isSuccessResponse(result)) {
        if (!result.data.idToken) throw new Error('No Google ID token. Check the web OAuth client configuration.');
        const engine = new SyncEngine(result.data.user.id);
        try {
          await engine.api.request('usage');
          setAccount({ engine, email: result.data.user.email });
        } catch (error) {
          await engine.destroy();
          throw error;
        }
      }
    } catch (error) { setError(error instanceof Error ? error.message : 'Sign-in failed. Please try again.'); }
    finally { authBusy.current = false; setBusy(false); }
  };
  const signOut = async () => {
    if (authBusy.current) return;
    authBusy.current = true;
    setBusy(true);
    const previous = current.current;
    // Tear down immediately, before awaiting Google: old requests cannot update a new account.
    const closed = previous?.engine.destroy();
    setAccount(undefined);
    try { await closed; await GoogleSignin.signOut(); }
    catch { setError('Local session closed. Google sign-out failed; try signing in again.'); }
    finally { authBusy.current = false; setBusy(false); }
  };
  return <SafeAreaView style={styles.screen}>
    <StatusBar style="dark" />
    {account ? <Library key={account.engine.userId} engine={account.engine} email={account.email} onSignOut={() => { void signOut(); }} />
      : <View style={styles.welcome}>
        <View style={styles.mark}><Image accessibilityLabel="Syncachu logo" source={require('./assets/syncachu-logo.png')} style={styles.markImage} /></View>
        <Text style={styles.eyebrow}>MEMORIES, WITHOUT THE CLUTTER</Text>
        <Text accessibilityRole="header" style={styles.welcomeTitle}>Meet Syncachu.</Text>
        <Text style={styles.welcomeText}>Your photos. Your videos.{'\n'}Your own private cloud.</Text>
        <Text style={styles.note}>Sign in with Google to upload selected originals or sync your accessible library. Wi-Fi only by default.</Text>
        <Action title={busy ? 'Please wait…' : 'Continue with Google'} disabled={busy || !!issue} onPress={() => { void signIn(); }} />
        {!!(issue || error) && <Text accessibilityRole="alert" style={styles.error}>{issue || error}</Text>}
        <Text style={styles.note}>Requires an iOS or Android development build. Not supported in Expo Go. Auto-sync works only while this app is open.</Text>
      </View>}
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F8F7F2', paddingTop: Platform.OS === 'android' ? 28 : 0 },
  list: { padding: 20, paddingBottom: 40 }, header: { gap: 16 }, flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  eyebrow: { color: '#586F8B', fontSize: 10, letterSpacing: 1.5, fontWeight: '800' },
  title: { fontSize: 33, color: '#26364D', fontWeight: '800' },
  hero: { backgroundColor: '#2E435E', borderRadius: 24, padding: 24, gap: 14 },
  heroTitle: { color: '#FFFFFF', fontSize: 27, fontWeight: '700', lineHeight: 34 },
  heroText: { color: '#DEE5EF', fontSize: 15, lineHeight: 23 },
  badge: { backgroundColor: '#F1DFA4', borderRadius: 20, paddingHorizontal: 12, paddingVertical: 8, alignSelf: 'flex-start' },
  badgeText: { color: '#35445B', fontSize: 12, fontWeight: '700' },
  button: { minHeight: 46, justifyContent: 'center', alignItems: 'center', backgroundColor: '#405D80', borderRadius: 13, paddingHorizontal: 18, paddingVertical: 12 },
  buttonText: { color: 'white', fontSize: 14, fontWeight: '700' },
  secondary: { backgroundColor: '#E9EDF2' }, secondaryText: { color: '#3B526F' }, dim: { opacity: 0.5 },
  actions: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  panel: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 16, gap: 14 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 14 }, divider: { height: 1, backgroundColor: '#E9EDF2' },
  label: { fontSize: 15, fontWeight: '600', color: '#2E3E54' },
  muted: { color: '#5C697A', fontSize: 12, lineHeight: 19 },
  note: { color: '#667181', fontSize: 12, lineHeight: 19 },
  notice: { color: '#4E5E74', backgroundColor: '#F3EEDB', padding: 12, borderRadius: 12, fontSize: 13, lineHeight: 20 },
  heading: { color: '#2E3E54', fontWeight: '700', fontSize: 21 },
  empty: { color: '#667181', paddingVertical: 16, lineHeight: 22 },
  queueItem: { backgroundColor: '#FFF', borderRadius: 14, padding: 14, gap: 10 },
  progressTrack: { height: 5, backgroundColor: '#E5EAF0', borderRadius: 5, overflow: 'hidden' },
  progressFill: { height: 5, backgroundColor: '#607D9E' },
  error: { color: '#A24F4A', fontSize: 13, lineHeight: 20 },
  galleryRow: { gap: 12 }, mediaCard: { flex: 1, maxWidth: '49%', marginBottom: 20, gap: 5 },
  thumbnail: { width: '100%', aspectRatio: 1, borderRadius: 14 }, placeholder: { backgroundColor: '#E3E8EE', alignItems: 'center', justifyContent: 'center' },
  mediaName: { fontSize: 13, color: '#304159', fontWeight: '600' },
  welcome: { flex: 1, justifyContent: 'center', padding: 32, gap: 23 },
  welcomeTitle: { color: '#2E435E', fontWeight: '800', fontSize: 43 },
  welcomeText: { color: '#4D607A', fontSize: 23, lineHeight: 33 },
  mark: { backgroundColor: '#F1DFA4', width: 72, height: 72, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  markImage: { width: 64, height: 64 },
});
