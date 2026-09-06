export interface Config {
  googleClientIds: string[];
  storageAccountUrl: string;
  storageContainer: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const googleClientIds = [...new Set((env.GOOGLE_CLIENT_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean))];
  if (!googleClientIds.length || googleClientIds.some(id => id === "*")) {
    throw new Error("GOOGLE_CLIENT_IDS must contain explicit Google OAuth client IDs");
  }
  const storageAccountUrl = env.AZURE_STORAGE_ACCOUNT_URL ?? "";
  if (!/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net\/?$/.test(storageAccountUrl)) {
    throw new Error("AZURE_STORAGE_ACCOUNT_URL must be an HTTPS Azure Blob account URL");
  }
  const storageContainer = env.AZURE_STORAGE_CONTAINER ?? "media";
  if (!/^[a-z0-9](?:[a-z0-9]|-(?!-)){1,61}[a-z0-9]$/.test(storageContainer)) {
    throw new Error("Invalid AZURE_STORAGE_CONTAINER");
  }
  return { googleClientIds, storageAccountUrl: storageAccountUrl.replace(/\/$/, ""), storageContainer };
}
