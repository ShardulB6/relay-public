import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

import { Emitter } from "./events.ts";
import type { KeyValueStore } from "./storage.ts";

/**
 * Provider credentials (API keys, OAuth tokens) kept in extension storage, one per provider.
 * Writes are serialized per provider with the Web Locks API across side panels in other
 * windows, so two panels never refresh the same token at once.
 */
export class StoredCredentials implements CredentialStore {
  readonly onChange = new Emitter<string>();
  #store: KeyValueStore;

  constructor(store: KeyValueStore) {
    this.#store = store;
  }

  read(providerId: string): Promise<Credential | undefined> {
    return this.#store.get<Credential>(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const infos: CredentialInfo[] = [];
    for (const providerId of await this.#store.keys()) {
      const credential = await this.read(providerId);
      if (credential) infos.push({ providerId, type: credential.type });
    }
    return infos;
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.#exclusive(providerId, async () => {
      const current = await this.read(providerId);
      const next = await fn(current);
      if (next === undefined) return current;
      await this.#store.set(providerId, next);
      this.onChange.emit(providerId);
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.#exclusive(providerId, async () => {
      await this.#store.delete(providerId);
      this.onChange.emit(providerId);
    });
  }

  #exclusive<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    return navigator.locks.request(`relay-credential:${providerId}`, task);
  }
}
