import { DefaultAzureCredential } from "@azure/identity";
import { TableClient, odata, type TableEntity, type TransactionAction } from "@azure/data-tables";
import type { StorageConfig } from "./config.js";
import type { QuotaChange, QuotaEntry, QuotaStore, SavedEntry } from "./quota.js";

const partitionKey = "instance";
function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : undefined;
}
function decode(row: Record<string, unknown>): SavedEntry {
  if (typeof row.rowKey !== "string" || typeof row.etag !== "string") throw new Error("Invalid quota row");
  const base = { rowKey: row.rowKey, etag: row.etag };
  const number = (key: string) => {
    const value = row[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid quota bytes");
    return value;
  };
  if (row.kind === "counter" && row.rowKey === "usage" && (row.state === "ready" || row.state === "initializing")) {
    return { ...base, rowKey: "usage", kind: "counter", state: row.state, usedBytes: number("usedBytes"), reservedBytes: number("reservedBytes") };
  }
  if (row.kind === "media") return { ...base, kind: "media", bytes: number("bytes") };
  if (row.kind === "reservation" && ["reserved", "publishing", "committed", "expired"].includes(String(row.state))
    && typeof row.owner === "string" && typeof row.mediaId === "string" && typeof row.expiresAt === "string"
    && Number.isFinite(Date.parse(row.expiresAt))) {
    const state = row.state;
    if (state === "reserved" || state === "publishing" || state === "committed" || state === "expired") {
      return { ...base, kind: "reservation", state, owner: row.owner, mediaId: row.mediaId, bytes: number("bytes"), expiresAt: row.expiresAt };
    }
  }
  throw new Error("Invalid quota row");
}
function entity(entry: QuotaEntry): TableEntity<Record<string, unknown>> {
  // Explicit EDM Double avoids Azure's Int32 inference at the 2 GiB boundary.
  const row: TableEntity<Record<string, unknown>> = { ...entry, partitionKey };
  delete row.etag;
  for (const key of ["bytes", "usedBytes", "reservedBytes"]) {
    if (typeof row[key] === "number") row[key] = { value: row[key], type: "Double" };
  }
  return row;
}

export class AzureQuotaStore implements QuotaStore {
  constructor(config: StorageConfig, private readonly table = new TableClient(
    config.storageAccountUrl.replace(".blob.", ".table."), config.quotaTable, new DefaultAzureCredential(),
  )) {}
  async get(rowKey: string): Promise<SavedEntry | undefined> {
    try { return decode(await this.table.getEntity(partitionKey, rowKey)); }
    catch (error) { if (status(error) === 404) return undefined; throw error; }
  }
  async transact(changes: QuotaChange[]): Promise<boolean> {
    const actions: TransactionAction[] = changes.map(change => change.etag
      ? ["update", entity(change.entry), "Replace", { etag: change.etag }]
      : ["create", entity(change.entry)]);
    try { await this.table.submitTransaction(actions); return true; }
    catch (error) {
      if (status(error) === 409 || status(error) === 412) return false;
      throw error;
    }
  }
  async *expired(before: string): AsyncIterable<string> {
    const filter = odata`PartitionKey eq ${partitionKey} and kind eq 'reservation' and (state eq 'reserved' or state eq 'publishing') and expiresAt le ${before}`;
    for await (const row of this.table.listEntities({ queryOptions: { filter, select: ["RowKey"] } })) {
      if (!row.rowKey) throw new Error("Invalid expired reservation");
      yield row.rowKey;
    }
  }
}
