import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { describe, expect, it } from "vite-plus/test";

import { connectSqlite, type SqliteWorker } from "./sqlite.ts";
import { createSqliteHandler } from "./sqlite-handler.ts";
import type { SqliteRequest, SqliteResponse } from "./sqlite-protocol.ts";

const sqlite3 = await sqlite3InitModule();

/** Serves requests in this thread against an in-memory database, like the worker does on OPFS. */
function inMemoryWorker(): SqliteWorker {
  const handle = createSqliteHandler(async () => new sqlite3.oo1.DB(":memory:"));
  const worker: SqliteWorker = {
    onmessage: null,
    onerror: null,
    terminate() {},
    postMessage(request: SqliteRequest) {
      // Replies arrive later, as they do from a real worker.
      void handle(request).then(
        (value) => reply({ id: request.id, ok: true, value }),
        (error: Error) => reply({ id: request.id, ok: false, error: error.message }),
      );
    },
  };
  const reply = (response: SqliteResponse) =>
    queueMicrotask(() => worker.onmessage?.call(null as never, { data: response } as never));
  return worker;
}

registerStorageConformance(
  { describe, expect, it },
  "SqliteStorage over the SQLite worker",
  async (use) => {
    const storage = await SqliteStorage.open(await connectSqlite(inMemoryWorker(), "test"));
    try {
      await use(storage);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  },
);

describe("worker SQLite transactions", () => {
  it("roll back on failure and hold back other work until they finish", async () => {
    const db = await connectSqlite(inMemoryWorker(), "test");
    await db.exec("CREATE TABLE t (v INTEGER)");
    const failed = db.transaction(async (tx) => {
      await tx.run("INSERT INTO t VALUES (?)", 1);
      throw new Error("boom");
    });
    // Queued behind the transaction, so it sees the rollback.
    const rows = db.all<{ v: number }>("SELECT v FROM t");
    await expect(failed).rejects.toThrow("boom");
    expect(await rows).toEqual([]);

    let handle: Parameters<Parameters<typeof db.transaction>[0]>[0] | undefined;
    await db.transaction(async (tx) => {
      handle = tx;
      await tx.run("INSERT INTO t VALUES (?)", 2);
    });
    expect(await db.all("SELECT v FROM t")).toEqual([{ v: 2 }]);
    expect(() => handle!.run("INSERT INTO t VALUES (3)")).toThrow("no longer active");
    await db.close();
  });
});
