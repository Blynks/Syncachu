import type { QuotaChange, QuotaStore, SavedEntry } from "../src/quota.js";

export class MemoryQuotaStore implements QuotaStore {
  rows = new Map<string, SavedEntry>();
  private version = 0;
  constructor(ready = true) {
    if (ready) this.rows.set("usage", { rowKey: "usage", kind: "counter", state: "ready", usedBytes: 0, reservedBytes: 0, etag: "0" });
  }
  async get(key: string) {
    const row = this.rows.get(key);
    return row ? { ...row } : undefined;
  }
  async transact(changes: QuotaChange[]) {
    for (const change of changes) {
      const row = this.rows.get(change.entry.rowKey);
      if (change.etag ? row?.etag !== change.etag : !!row) return false;
    }
    for (const change of changes) this.rows.set(change.entry.rowKey, { ...change.entry, etag: String(++this.version) });
    return true;
  }
  async *expired(before: string) {
    for (const row of [...this.rows.values()]) {
      if (row.kind === "reservation" && (row.state === "reserved" || row.state === "publishing") && row.expiresAt <= before) yield row.rowKey;
    }
  }
}
