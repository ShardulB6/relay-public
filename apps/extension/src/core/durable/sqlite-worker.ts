/// <reference lib="webworker" />
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

import { errorMessage } from "../errors.ts";
import { createSqliteHandler } from "./sqlite-handler.ts";
import type { SqliteRequest, SqliteResponse } from "./sqlite-protocol.ts";

// SQLite on the origin private file system. The SAH pool VFS needs no cross-origin isolation, but
// only one connection may hold it at a time, so the app takes a lock before starting this worker.
const handle = createSqliteHandler(async (path) => {
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "relay" });
  return new pool.OpfsSAHPoolDb(path);
});

self.onmessage = async ({ data }: MessageEvent<SqliteRequest>) => {
  let response: SqliteResponse;
  try {
    response = { id: data.id, ok: true, value: await handle(data) };
  } catch (error) {
    response = {
      id: data.id,
      ok: false,
      error: errorMessage(error),
    };
  }
  self.postMessage(response);
};
