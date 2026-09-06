import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { fetch } from 'expo/fetch';
import { checkCancelled, privateApiUrl } from './core';

export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/+$/, '');
export const BLOB_HOST = process.env.EXPO_PUBLIC_AZURE_BLOB_HOST ?? '';

export function configurationError(): string | undefined {
  try {
    const url = new URL(API_URL);
    if (url.protocol !== 'https:' || url.username || url.password
      || url.search || url.hash || !url.pathname.endsWith('/api')) throw new Error();
  } catch {
    return 'Set EXPO_PUBLIC_API_URL to an HTTPS address ending in /api.';
  }
  if (!/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(BLOB_HOST)) {
    return 'Set EXPO_PUBLIC_AZURE_BLOB_HOST to your Azure storage account host.';
  }
  if (!process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID) return 'Set the Google web client ID in .env.';
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export class Api {
  constructor(private userId: string, private sessionSignal: AbortSignal) {}

  async token(signal = this.sessionSignal): Promise<string> {
    checkCancelled(signal);
    checkCancelled(this.sessionSignal);
    if (GoogleSignin.getCurrentUser()?.user.id !== this.userId) throw new Error('Account changed. Sign in again.');
    const { idToken } = await GoogleSignin.getTokens();
    checkCancelled(signal);
    checkCancelled(this.sessionSignal);
    if (GoogleSignin.getCurrentUser()?.user.id !== this.userId) throw new Error('Account changed. Sign in again.');
    if (!idToken) throw new Error('Google did not return an ID token. Check the web client ID.');
    return idToken;
  }

  async request<T>(path: string, body?: object, signal = this.sessionSignal): Promise<T> {
    const token = await this.token(signal);
    const response = await fetch(privateApiUrl(path, API_URL), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: ['Bearer', token].join(' '), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal, redirect: 'error', credentials: 'omit',
    });
    checkCancelled(signal);
    checkCancelled(this.sessionSignal);
    if (!response.ok) {
      let message = `Request failed (${response.status}).`;
      try { message = (await response.json()).error || message; } catch {}
      throw new ApiError(response.status, message);
    }
    return response.json() as Promise<T>;
  }
}
