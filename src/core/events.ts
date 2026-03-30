import type { ArctiEvents } from "./types.ts";

type EventHandler<T> = (data: T) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<string, EventHandler<unknown>[]>();
  private waiters = new Map<string, Array<(data: unknown) => void>>();

  on<K extends keyof ArctiEvents>(
    event: K,
    handler: EventHandler<ArctiEvents[K]>,
  ): () => void {
    const list = this.handlers.get(event as string) ?? [];
    list.push(handler as EventHandler<unknown>);
    this.handlers.set(event as string, list);

    // Return unsubscribe function
    return () => {
      const idx = list.indexOf(handler as EventHandler<unknown>);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  async emit<K extends keyof ArctiEvents>(
    event: K,
    data: ArctiEvents[K],
  ): Promise<void> {
    const handlers = this.handlers.get(event as string) ?? [];
    await Promise.allSettled(handlers.map((h) => h(data)));

    // Resolve waiters
    const waiters = this.waiters.get(event as string) ?? [];
    for (const resolve of waiters) {
      resolve(data);
    }
    this.waiters.delete(event as string);
  }

  waitFor<K extends keyof ArctiEvents>(event: K, timeoutMs = 600_000): Promise<ArctiEvents[K]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`waitFor("${String(event)}") timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const list = this.waiters.get(event as string) ?? [];
      list.push(((data: unknown) => {
        clearTimeout(timer);
        resolve(data as ArctiEvents[K]);
      }) as (data: unknown) => void);
      this.waiters.set(event as string, list);
    });
  }
}
