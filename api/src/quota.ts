import { ApiError, MAX_THUMBNAIL_SIZE, TICKET_LIFETIME_MS, type StoredMedia, type Ticket } from "./types.js";

export const DEFAULT_QUOTA_BYTES = 1_000_000_000_000;
export type Usage = { limitBytes: number; usedBytes: number; reservedBytes: number; availableBytes: number };
export type Counter = { rowKey: "usage"; kind: "counter"; state: "initializing" | "ready"; usedBytes: number; reservedBytes: number };
export type Reservation = {
  rowKey: string; kind: "reservation"; state: "reserved" | "publishing" | "committed" | "expired";
  owner: string; mediaId: string; bytes: number; expiresAt: string;
};
export type Charge = { rowKey: string; kind: "media"; bytes: number };
export type QuotaEntry = Counter | Reservation | Charge;
export type SavedEntry = QuotaEntry & { etag: string };
export type QuotaChange = { entry: QuotaEntry; etag?: string };
export interface QuotaStore {
  get(key: string): Promise<SavedEntry | undefined>;
  transact(changes: QuotaChange[]): Promise<boolean>;
  expired(before: string): AsyncIterable<string>;
}

const reservationKey = (ticket: Ticket) => `upload-${ticket.uploadId}`;
const chargeKey = (owner: string, id: string) => `media-${owner}-${id}`;
const allocation = (ticket: Ticket) => ticket.size + (ticket.hasThumbnail ? MAX_THUMBNAIL_SIZE : 0);
function safeBytes(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid quota accounting");
}

export class QuotaLedger {
  constructor(private readonly store: QuotaStore, readonly limitBytes = DEFAULT_QUOTA_BYTES, private readonly now = Date.now) {
    safeBytes(limitBytes);
    if (!limitBytes) throw new Error("Quota must be positive");
  }
  private async counter(initializing = false): Promise<Counter & { etag: string }> {
    const row = await this.store.get("usage");
    if (!row || row.kind !== "counter" || row.state !== (initializing ? "initializing" : "ready")) {
      throw new ApiError(503, "Storage quota is not ready. Contact the instance administrator.");
    }
    safeBytes(row.usedBytes); safeBytes(row.reservedBytes);
    return row;
  }
  private async retry(action: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt++) {
      if (await action()) return;
      await new Promise(resolve => setTimeout(resolve, Math.min(200, 5 * 2 ** attempt) + Math.random() * 20));
    }
    throw new ApiError(503, "Storage accounting is busy. Retry shortly.");
  }
  private async reservation(ticket: Ticket): Promise<(Reservation & { etag: string }) | undefined> {
    const row = await this.store.get(reservationKey(ticket));
    if (!row) return undefined;
    if (row.kind !== "reservation" || row.owner !== ticket.owner || row.mediaId !== ticket.sha256
      || row.bytes !== allocation(ticket)) throw new Error("Invalid upload reservation");
    return row;
  }
  async usage(): Promise<Usage> {
    const row = await this.counter();
    return {
      limitBytes: this.limitBytes, usedBytes: row.usedBytes, reservedBytes: row.reservedBytes,
      availableBytes: Math.max(0, this.limitBytes - row.usedBytes - row.reservedBytes),
    };
  }
  async reserve(ticket: Ticket): Promise<void> {
    await this.retry(async () => {
      const counter = await this.counter();
      const existing = await this.reservation(ticket);
      if (existing) {
        if (existing.state === "expired") throw new ApiError(409, "Upload reservation expired");
        return true;
      }
      const bytes = allocation(ticket);
      safeBytes(bytes);
      if (Date.parse(ticket.createdAt) + TICKET_LIFETIME_MS <= this.now()) throw new ApiError(409, "Upload expired");
      if (bytes > this.limitBytes - counter.usedBytes - counter.reservedBytes) {
        throw new ApiError(507, "Instance storage quota reached. Pending uploads reserve space for up to 24 hours; contact the administrator or retry after space is available.");
      }
      return this.store.transact([
        { entry: { ...counter, reservedBytes: counter.reservedBytes + bytes }, etag: counter.etag },
        { entry: {
          rowKey: reservationKey(ticket), kind: "reservation", state: "reserved",
          owner: ticket.owner, mediaId: ticket.sha256, bytes,
          expiresAt: new Date(Date.parse(ticket.createdAt) + TICKET_LIFETIME_MS).toISOString(),
        } },
      ]);
    });
  }
  async check(ticket: Ticket): Promise<void> {
    await this.counter();
    const row = await this.reservation(ticket);
    if (!row || row.state === "expired") throw new ApiError(409, "Upload reservation expired; start a new upload");
  }
  async claim(ticket: Ticket): Promise<void> {
    await this.counter();
    await this.retry(async () => {
      const row = await this.reservation(ticket);
      if (!row || row.state === "expired"
        || (row.state === "reserved" && Date.parse(row.expiresAt) <= this.now())) {
        throw new ApiError(409, "Upload reservation expired; start a new upload");
      }
      if (row.state !== "reserved") return true;
      // Once publication starts, expiry must not reclaim bytes that may already exist in final storage.
      return this.store.transact([{ entry: { ...row, state: "publishing" }, etag: row.etag }]);
    });
  }
  async settle(ticket: Ticket, media: StoredMedia): Promise<void> {
    if (media.id !== ticket.sha256) throw new Error("Media does not match upload reservation");
    await this.retry(async () => {
      const counter = await this.counter();
      const row = await this.reservation(ticket);
      const charged = await this.store.get(chargeKey(ticket.owner, media.id));
      if (charged && charged.kind !== "media") throw new Error("Invalid media charge");
      if (charged && (!row || row.state === "committed" || row.state === "expired")) return true;
      if (!row || (row.state !== "publishing" && !(charged && row.state === "reserved"))) {
        throw new ApiError(409, "Upload has no active publication reservation");
      }
      if (!charged && media.thumbnailKey && media.thumbnailSize === undefined) throw new Error("Missing thumbnail size");
      const bytes = media.size + (media.thumbnailSize ?? 0);
      safeBytes(bytes);
      if (!charged && bytes > row.bytes) throw new Error("Media exceeds reserved storage");
      const reservedBytes = counter.reservedBytes - row.bytes;
      const usedBytes = counter.usedBytes + (charged ? 0 : bytes);
      safeBytes(reservedBytes); safeBytes(usedBytes);
      const changes: QuotaChange[] = [
        { entry: { ...counter, reservedBytes, usedBytes }, etag: counter.etag },
        { entry: { ...row, state: "committed" }, etag: row.etag },
      ];
      if (!charged) changes.push({ entry: { rowKey: chargeKey(ticket.owner, media.id), kind: "media", bytes } });
      return this.store.transact(changes);
    });
  }
  async expireReservations(): Promise<void> {
    await this.counter();
    const before = new Date(this.now()).toISOString();
    for await (const key of this.store.expired(before)) {
      await this.retry(async () => {
        const counter = await this.counter();
        const row = await this.store.get(key);
        if (!row || row.kind !== "reservation" || (row.state !== "reserved" && row.state !== "publishing") || row.expiresAt > before) return true;
        if (row.state === "publishing") {
          const charged = await this.store.get(chargeKey(row.owner, row.mediaId));
          if (!charged) return true;
          if (charged.kind !== "media") throw new Error("Invalid media charge");
        }
        const reservedBytes = counter.reservedBytes - row.bytes;
        safeBytes(reservedBytes);
        return this.store.transact([
          { entry: { ...counter, reservedBytes }, etag: counter.etag },
          { entry: { ...row, state: row.state === "publishing" ? "committed" : "expired" }, etag: row.etag },
        ]);
      });
    }
  }
  async initialize(records: AsyncIterable<{ owner: string; id: string; bytes: number }>): Promise<void> {
    const existing = await this.store.get("usage");
    if (existing?.kind === "counter" && existing.state === "ready") return;
    if (!existing) {
      await this.store.transact([{ entry: { rowKey: "usage", kind: "counter", state: "initializing", usedBytes: 0, reservedBytes: 0 } }]);
    }
    for await (const record of records) {
      safeBytes(record.bytes);
      await this.retry(async () => {
        const counter = await this.counter(true);
        const key = chargeKey(record.owner, record.id);
        const charged = await this.store.get(key);
        if (charged) {
          if (charged.kind !== "media" || charged.bytes !== record.bytes) throw new Error("Catalog changed during quota initialization");
          return true;
        }
        const usedBytes = counter.usedBytes + record.bytes;
        safeBytes(usedBytes);
        return this.store.transact([
          { entry: { ...counter, usedBytes }, etag: counter.etag },
          { entry: { rowKey: key, kind: "media", bytes: record.bytes } },
        ]);
      });
    }
    await this.retry(async () => {
      const counter = await this.counter(true);
      return this.store.transact([{ entry: { ...counter, state: "ready" }, etag: counter.etag }]);
    });
  }
}
