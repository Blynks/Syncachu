import { loadStorageConfig } from "./config.js";
import { QuotaLedger } from "./quota.js";
import { AzureQuotaStore } from "./quotaStorage.js";
import { AzureBlobStorage } from "./storage.js";

const config = loadStorageConfig();
const storage = new AzureBlobStorage(config);
const quota = new QuotaLedger(new AzureQuotaStore(config), config.quotaBytes);
await storage.assertPrivate();
await quota.initialize(storage.quotaRecords());
console.log("Instance quota initialized:", await quota.usage());
