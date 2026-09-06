import { DEFAULT_QUOTA_BYTES } from "./quota.js";

export interface StorageConfig {
  storageAccountUrl: string;
  storageContainer: string;
  quotaTable: string;
  quotaBytes: number;
}
export interface Config extends StorageConfig {
  googleClientIds: string[];
  allowedGoogleEmails: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const googleClientIds = [...new Set((env.GOOGLE_CLIENT_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean))];
  if (!googleClientIds.length || googleClientIds.some(id => id === "*")) {
    throw new Error("GOOGLE_CLIENT_IDS must contain explicit Google OAuth client IDs");
  }
  const allowedGoogleEmails = [...new Set((env.ALLOWED_GOOGLE_EMAILS ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean))];
  if (!allowedGoogleEmails.length || allowedGoogleEmails.some(email => !/^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(email))) {
    throw new Error("ALLOWED_GOOGLE_EMAILS must contain explicitly approved email addresses");
  }
  return { ...loadStorageConfig(env), googleClientIds, allowedGoogleEmails };
}

export function loadStorageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const storageAccountUrl = env.AZURE_STORAGE_ACCOUNT_URL ?? "";
  if (!/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net\/?$/.test(storageAccountUrl)) {
    throw new Error("AZURE_STORAGE_ACCOUNT_URL must be an HTTPS Azure Blob account URL");
  }
  const storageContainer = env.AZURE_STORAGE_CONTAINER ?? "media";
  if (!/^[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/.test(storageContainer)) {
    throw new Error("Invalid AZURE_STORAGE_CONTAINER");
  }
  const quotaTable = env.AZURE_QUOTA_TABLE ?? "syncachuquota";
  if (!/^[A-Za-z][A-Za-z0-9]{2,62}$/.test(quotaTable)) throw new Error("Invalid AZURE_QUOTA_TABLE");
  const quotaText = env.STORAGE_QUOTA_BYTES ?? String(DEFAULT_QUOTA_BYTES);
  const quotaBytes = Number(quotaText);
  if (!/^[1-9]\d*$/.test(quotaText) || !Number.isSafeInteger(quotaBytes)) throw new Error("Invalid STORAGE_QUOTA_BYTES");
  return { storageAccountUrl: storageAccountUrl.replace(/\/$/, ""), storageContainer, quotaTable, quotaBytes };
}
