import type {
  SqliteDatabase,
  SqliteExecutor,
  SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

import type { SqliteRequest, SqliteResponse } from "./sqlite-protocol.ts";

type Request = SqliteRequest extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never;

/** The part of `Worker` the connection uses, so tests can serve requests in-process. */
export type SqliteWorker = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;

/** Sends requests to the SQLite worker and matches the replies. */
class WorkerConnection {
  #worker: SqliteWorker;
  #nextId = 1;
  #pending = new Map<number, PromiseWithResolvers<unknown>>();

  constructor(worker: SqliteWorker) {
    this.#worker = worker;
    worker.onmessage = ({ data }: MessageEvent<SqliteResponse>) => {
      const pending = this.#pending.get(data.id);
      this.#pending.delete(data.id);
      if (data.ok) pending?.resolve(data.value);
      else pending?.reject(new Error(data.error));
    };
    worker.onerror = (event) => {
      const error = new Error(`SQLite worker failed: ${event.message}`);
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    };
  }

  send<T>(request: Request): Promise<T> {
    const id = this.#nextId++;
    const pending = Promise.withResolvers<unknown>();
    this.#pending.set(id, pending);
    this.#worker.postMessage({ ...request, id });
    return pending.promise as Promise<T>;
  }

  terminate() {
    this.#worker.terminate();
  }
}

class Executor implements SqliteExecutor {
  protected connection: WorkerConnection;
  #guard: () => void;

  constructor(connection: WorkerConnection, guard: () => void = () => {}) {
    this.connection = connection;
    this.#guard = guard;
  }

  protected call<T>(request: Request): Promise<T> {
    this.#guard();
    return this.connection.send<T>(request);
  }

  exec(sql: string): Promise<void> {
    return this.call({ op: "exec", sql });
  }

  run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.call({ op: "run", sql, params });
  }

  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.call({ op: "get", sql, params });
  }

  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.call({ op: "all", sql, params });
  }
}

/**
 * pi-durable's `SqliteDatabase` over a SQLite worker. The worker has one connection, so operations
 * run in call order, and a transaction holds back everything else until it commits or rolls back.
 */
class WorkerSqliteDatabase extends Executor implements SqliteDatabase {
  #tail: Promise<unknown> = Promise.resolve();

  /** Run `operation` after everything queued before it. */
  #queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => {});
    return result;
  }

  protected override call<T>(request: Request): Promise<T> {
    return this.#queue(() => this.connection.send<T>(request));
  }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.#queue(async () => {
      await this.connection.send({ op: "exec", sql: "BEGIN IMMEDIATE" });
      const scope = { active: true };
      const handle = new Executor(this.connection, () => {
        if (!scope.active) throw new Error("SQLite transaction handle is no longer active");
      });
      try {
        const result = await callback(handle);
        scope.active = false;
        await this.connection.send({ op: "exec", sql: "COMMIT" });
        return result;
      } catch (error) {
        scope.active = false;
        try {
          await this.connection.send({ op: "exec", sql: "ROLLBACK" });
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "SQLite transaction failed and rollback failed",
          );
        }
        throw error;
      }
    });
  }

  close(): Promise<void> {
    return this.#queue(async () => {
      await this.connection.send({ op: "close" });
      this.connection.terminate();
    });
  }
}

/** Open the database at `path` through `worker`, which serves `SqliteRequest`s. */
export async function connectSqlite(worker: SqliteWorker, path: string): Promise<SqliteDatabase> {
  const connection = new WorkerConnection(worker);
  try {
    await connection.send({ op: "open", path });
  } catch (error) {
    connection.terminate();
    throw error;
  }
  return new WorkerSqliteDatabase(connection);
}

/** Open the database at `path` in the extension's origin private file system. */
export function openWorkerSqlite(path: string): Promise<SqliteDatabase> {
  return connectSqlite(
    new Worker(new URL("./sqlite-worker.ts", import.meta.url), { type: "module" }),
    path,
  );
}
