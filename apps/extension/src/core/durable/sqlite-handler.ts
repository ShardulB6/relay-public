import type { Database, PreparedStatement } from "@sqlite.org/sqlite-wasm";

import type { SqliteRequest } from "./sqlite-protocol.ts";

/**
 * Serves `SqliteRequest`s against one connection. `open` makes the connection for a path; the
 * worker opens it on the origin private file system, tests in memory.
 */
export function createSqliteHandler(open: (path: string) => Promise<Database>) {
  let db: Database | undefined;
  // pi-durable runs a small set of statements over and over.
  const statements = new Map<string, PreparedStatement>();

  function statement(sql: string): PreparedStatement {
    let prepared = statements.get(sql);
    if (!prepared) {
      prepared = db!.prepare(sql);
      statements.set(sql, prepared);
    }
    return prepared;
  }

  return async function handle(request: SqliteRequest): Promise<unknown> {
    if (request.op === "open") {
      db = await open(request.path);
      return;
    }
    if (!db) throw new Error("The database is not open");
    switch (request.op) {
      case "exec":
        db.exec(request.sql);
        return;
      case "close":
        for (const prepared of statements.values()) prepared.finalize();
        statements.clear();
        db.close();
        db = undefined;
        return;
    }
    const prepared = statement(request.sql);
    try {
      if (request.params.length > 0) prepared.bind(request.params);
      if (request.op === "run") {
        prepared.step();
        return;
      }
      const rows: Record<string, unknown>[] = [];
      while (prepared.step()) {
        rows.push(prepared.get({}));
        if (request.op === "get") break;
      }
      return request.op === "get" ? rows[0] : rows;
    } finally {
      prepared.reset(true);
    }
  };
}
