import { ConfigContext, ExpoConfig } from 'expo/config';
import { ConfigPlugin, withGradleProperties } from 'expo/config-plugins';

const withQueueStorageCapacity: ConfigPlugin = config => withGradleProperties(config, mod => {
  const key = 'AsyncStorage_db_size_in_MB';
  mod.modResults = mod.modResults.filter(entry => entry.type !== 'property' || entry.key !== key);
  mod.modResults.push({ type: 'property', key, value: '128' });
  return mod;
});

export default ({ config }: ConfigContext): ExpoConfig => withQueueStorageCapacity({
  ...config,
  name: 'Syncachu',
  slug: 'syncachu',
  scheme: 'syncachu',
  version: '1.0.0',
  ios: {
    ...config.ios,
    bundleIdentifier: process.env.EXPO_PUBLIC_APP_ID || 'com.example.syncachu',
    infoPlist: {
      ...config.ios?.infoPlist,
      UIBackgroundModes: [...new Set([...(config.ios?.infoPlist?.UIBackgroundModes ?? []), 'processing'])],
      BGTaskSchedulerPermittedIdentifiers: [
        ...new Set([...(config.ios?.infoPlist?.BGTaskSchedulerPermittedIdentifiers ?? []),
          `${process.env.EXPO_PUBLIC_APP_ID || 'com.example.syncachu'}.backup-processing`]),
      ],
    },
  },
  android: {
    ...config.android,
    package: process.env.EXPO_PUBLIC_APP_ID || 'com.example.syncachu',
    blockedPermissions: ['android.permission.RECORD_AUDIO'],
  },
  plugins: [
    ['@react-native-google-signin/google-signin', {
      iosUrlScheme: process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME || 'com.googleusercontent.apps.configure-me',
    }],
    ['expo-image-picker', {
      photosPermission: 'Choose original photos and videos to upload to your private Syncachu cloud.',
      cameraPermission: false, microphonePermission: false,
    }],
    ['expo-media-library', {
      photosPermission: 'Allow Syncachu to read and sync photos and videos you choose to share.',
      savePhotosPermission: 'Syncachu does not modify or delete your device originals.',
      granularPermissions: ['photo', 'video'],
    }],
    'expo-dev-client',
  ],
});
