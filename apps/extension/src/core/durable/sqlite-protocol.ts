import type { SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";

export type SqliteRequest =
  | { id: number; op: "open"; path: string }
  | { id: number; op: "exec"; sql: string }
  | { id: number; op: "run" | "get" | "all"; sql: string; params: SqliteValue[] }
  | { id: number; op: "close" };

export type SqliteResponse =
  | { id: number; ok: true; value?: unknown }
  | { id: number; ok: false; error: string };
