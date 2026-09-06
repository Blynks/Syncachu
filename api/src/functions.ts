import functions from "@azure/functions";
import { createAuthenticator } from "./auth.js";
import { loadConfig, loadStorageConfig } from "./config.js";
import { createHandler, type Dependencies } from "./http.js";
import { MediaService } from "./service.js";
import { AzureBlobStorage } from "./storage.js";
import { QuotaLedger } from "./quota.js";
import { AzureQuotaStore } from "./quotaStorage.js";

const { app } = functions;
let dependencies: Dependencies | undefined;
let quota: QuotaLedger | undefined;
function getQuota(): QuotaLedger {
  if (!quota) {
    const config = loadStorageConfig();
    quota = new QuotaLedger(new AzureQuotaStore(config), config.quotaBytes);
  }
  return quota;
}
function getDependencies(): Dependencies {
  if (!dependencies) {
    const config = loadConfig();
    const authenticate = createAuthenticator(config.googleClientIds, config.allowedGoogleEmails);
    let storage: AzureBlobStorage | undefined;
    dependencies = {
      authenticate,
      service: async () => {
        storage ??= new AzureBlobStorage(config);
        await storage.assertPrivate();
        return new MediaService(storage, getQuota());
      },
    };
  }
  return dependencies;
}

app.http("createUpload", {
  methods: ["POST"], authLevel: "anonymous", route: "uploads", handler: createHandler("begin", getDependencies),
});
app.http("renewUpload", {
  methods: ["POST"], authLevel: "anonymous", route: "uploads/{uploadId}/renew", handler: createHandler("renew", getDependencies),
});
app.http("completeUpload", {
  methods: ["POST"], authLevel: "anonymous", route: "uploads/{uploadId}/complete", handler: createHandler("complete", getDependencies),
});
app.http("listMedia", {
  methods: ["GET"], authLevel: "anonymous", route: "media", handler: createHandler("gallery", getDependencies),
});
app.http("storageUsage", {
  methods: ["GET"], authLevel: "anonymous", route: "usage", handler: createHandler("usage", getDependencies),
});
app.timer("expireUploadReservations", {
  schedule: "0 */15 * * * *",
  handler: async () => { await getQuota().expireReservations(); },
});
app.http("health", {
  methods: ["GET"], authLevel: "anonymous", route: "health",
  handler: async () => ({ status: 200, jsonBody: { status: "ok" }, headers: { "Cache-Control": "no-store" } }),
});
