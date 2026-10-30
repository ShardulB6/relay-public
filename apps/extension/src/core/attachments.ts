import type { ConversationId } from "@earendil-works/pi-durable";

import type { KeyValueStore } from "./storage.ts";

/** A file as stored: its type and its bytes in base64. */
interface StoredFile {
  type: string;
  data: string;
}

/** `name` with a number before its extension: "resume (2).pdf". */
function numbered(name: string, number: number): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${number})${name.slice(dot)}` : `${name} (${number})`;
}

/**
 * The files the user attached, kept per conversation so tools can hand them to pages: uploading
 * a résumé the user attached, for one. A stored file never changes: a tool about to upload one
 * must not get another file attached later under the same name.
 */
export class Attachments {
  #store: KeyValueStore;
  /** Changes run one at a time, so none overwrites another's. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(store: KeyValueStore) {
    this.#store = store;
  }

  /** Store `files`, and return the names they are stored under, numbered when taken. */
  save(conversationId: ConversationId, files: readonly File[]): Promise<string[]> {
    if (files.length === 0) return Promise.resolve([]);
    return this.#change(async () => {
      const stored = await this.#files(conversationId);
      const names: string[] = [];
      for (const file of files) {
        let name = file.name;
        for (let number = 2; name in stored; number++) name = numbered(file.name, number);
        const data = new Uint8Array(await file.arrayBuffer()).toBase64();
        stored[name] = { type: file.type, data };
        names.push(name);
      }
      await this.#store.set(String(conversationId), stored);
      return names;
    });
  }

  async names(conversationId: ConversationId): Promise<string[]> {
    return Object.keys(await this.#files(conversationId));
  }

  async get(conversationId: ConversationId, name: string): Promise<File | undefined> {
    const stored = (await this.#files(conversationId))[name];
    if (!stored) return undefined;
    return new File([Uint8Array.fromBase64(stored.data)], name, { type: stored.type });
  }

  delete(conversationId: ConversationId): Promise<void> {
    return this.#change(() => this.#store.delete(String(conversationId)));
  }

  #change<T>(change: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(change);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #files(conversationId: ConversationId): Promise<Record<string, StoredFile>> {
    return (await this.#store.get<Record<string, StoredFile>>(String(conversationId))) ?? {};
  }
}
