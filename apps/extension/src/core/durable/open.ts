import type { Storage } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

import { openWorkerSqlite } from "./sqlite.ts";

const LOCK = "relay:conversations";
const DATABASE = "/relay.sqlite3";

/**
 * Open the conversation storage. pi-durable expects a single owner and does not lock its storage,
 * and Chrome opens a side panel per window, so the panel that opens it first holds a Web Lock for
 * as long as it lives. Another window's panel is refused.
 */
export async function openConversationStorage(): Promise<Storage> {
  const acquired = Promise.withResolvers<boolean>();
  void navigator.locks.request(LOCK, { ifAvailable: true }, (lock) => {
    acquired.resolve(lock !== null);
    // Released when the page closes.
    return lock ? new Promise<never>(() => {}) : undefined;
  });
  if (!(await acquired.promise)) {
    throw new Error("Relay is open in another window. Close its side panel to use Relay here.");
  }
  return SqliteStorage.open(await openWorkerSqlite(DATABASE));
}
