/** Classic token bucket. `capacity` tokens, refilled at `refillPerSec`. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    readonly capacity: number,
    readonly refillPerSec: number,
    now: number = Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  private refill(now: number) {
    const dt = Math.max(0, now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.refillPerSec);
    this.last = now;
  }

  /** Try to spend `cost`. Returns 0 on success, else ms until it would succeed. */
  take(cost = 1, now: number = Date.now()): number {
    this.refill(now);
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return 0;
    }
    return Math.ceil(((cost - this.tokens) / this.refillPerSec) * 1000);
  }
}

export interface RateRule {
  capacity: number;
  refillPerSec: number;
}

/** Per-fan limits. Chat is the expensive one (it can cost the owner LLM tokens). */
export const FAN_RATE_RULES: Record<'treat' | 'toy' | 'chat' | 'any', RateRule> = {
  treat: { capacity: 3, refillPerSec: 1 / 20 }, // 3 burst, then 1 per 20 s
  toy: { capacity: 4, refillPerSec: 1 / 10 },
  chat: { capacity: 2, refillPerSec: 1 / 30 }, // 2 burst, then 1 per 30 s
  any: { capacity: 10, refillPerSec: 1 / 2 }, // flood guard across all actions
};

/** Room-wide caps so a crowd can't drown the pet. */
export const ROOM_RATE_RULES: Record<'treat' | 'toy' | 'chat', RateRule> = {
  treat: { capacity: 10, refillPerSec: 1 / 6 },
  toy: { capacity: 10, refillPerSec: 1 / 3 },
  chat: { capacity: 6, refillPerSec: 1 / 10 },
};

export class KeyedLimiter<K extends string> {
  private buckets = new Map<string, TokenBucket>();
  constructor(private rules: Record<K, RateRule>) {}

  take(key: string, kind: K, now = Date.now()): number {
    const id = `${key}\u0000${kind}`;
    let b = this.buckets.get(id);
    if (!b) {
      const r = this.rules[kind];
      b = new TokenBucket(r.capacity, r.refillPerSec, now);
      this.buckets.set(id, b);
    }
    return b.take(1, now);
  }

  forget(key: string) {
    for (const id of this.buckets.keys()) if (id.startsWith(`${key}\u0000`)) this.buckets.delete(id);
  }

  get size() {
    return this.buckets.size;
  }
}
