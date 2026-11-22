/**
 * Single-lane chat queue with owner priority.
 *
 * - Owner messages always jump the queue.
 * - If a fan reply is generating when the owner speaks, it is aborted and
 *   the owner is answered first (the fan message is re-queued once).
 * - Fan messages expire if they wait too long, and the queue is bounded.
 */
export interface QueueItem<T> {
  id: string;
  priority: number; // 0 = owner (highest)
  enqueuedAt: number;
  payload: T;
  attempts?: number;
  /** Assigned by the queue; breaks ties so order is stable. */
  seq?: number;
}

export interface ChatQueueOptions {
  maxFanQueue: number;
  fanTtlMs: number;
}

export class ChatQueue<T> {
  private items: QueueItem<T>[] = [];
  private running?: { item: QueueItem<T>; ctrl: AbortController };
  private draining = false;
  private seq = 0;

  constructor(
    private handler: (item: QueueItem<T>, signal: AbortSignal) => Promise<void>,
    private opts: ChatQueueOptions = { maxFanQueue: 8, fanTtlMs: 5 * 60_000 },
    private now: () => number = Date.now,
  ) {}

  get size() {
    return this.items.length;
  }

  get busy() {
    return !!this.running;
  }

  /** Returns false if dropped (queue full). */
  push(item: QueueItem<T>): boolean {
    if (item.priority > 0) {
      const fans = this.items.filter((i) => i.priority > 0);
      if (fans.length >= this.opts.maxFanQueue) return false;
    }
    this.items.push({ ...item, seq: item.seq ?? this.seq++ });
    this.sort();
    // Owner preempts an in-flight fan reply.
    if (item.priority === 0 && this.running && this.running.item.priority > 0) {
      const preempted = this.running.item;
      this.running.ctrl.abort();
      if ((preempted.attempts ?? 0) < 1) {
        this.items.push({ ...preempted, attempts: (preempted.attempts ?? 0) + 1 });
        this.sort();
      }
    }
    void this.drain();
    return true;
  }

  private sort() {
    this.items.sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt || (a.seq ?? 0) - (b.seq ?? 0));
  }

  cancelAll() {
    this.items = [];
    this.running?.ctrl.abort();
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.items.length) {
        const t = this.now();
        this.items = this.items.filter((i) => i.priority === 0 || t - i.enqueuedAt < this.opts.fanTtlMs);
        const item = this.items.shift();
        if (!item) break;
        const ctrl = new AbortController();
        this.running = { item, ctrl };
        try {
          await this.handler(item, ctrl.signal);
        } catch {
          /* handler reports its own errors */
        } finally {
          this.running = undefined;
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
