export class Emitter<T = void> {
  #listeners = new Set<(value: T) => void>();

  /** Subscribe; returns an unsubscribe function. */
  on(listener: (value: T) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(value: T): void {
    for (const listener of this.#listeners) listener(value);
  }
}
