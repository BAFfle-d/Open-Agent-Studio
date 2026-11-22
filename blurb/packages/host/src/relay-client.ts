/**
 * Owner-side relay connection. Publishes PublicState (snapshot + deltas),
 * public chat, and moderation results; receives fan events.
 *
 * Only `PublicState` and `PublicChat` ever go out. The type signatures make
 * that the only thing you *can* send.
 */
import {
  PROTOCOL_VERSION,
  diffPublicState,
  type FanEvent,
  type FanMode,
  type OwnerToServer,
  type PublicChat,
  type PublicState,
  type ServerToOwner,
} from '@blurb/shared';

/** Minimal WebSocket shape satisfied by both `ws` and the browser API. */
export interface WSLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: { code?: number }) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export type RelayStatus = 'off' | 'connecting' | 'online' | 'unauthorized' | 'error';

export interface RelayClientOptions {
  url: string;
  petId: string;
  token: string;
  createSocket: (url: string) => WSLike;
  /** Snapshot every N ms even if deltas are flowing (heals any drift). */
  keyframeMs?: number;
}

export class RelayClient {
  status: RelayStatus = 'off';
  viewers = 0;
  private ws?: WSLike;
  private lastSent?: PublicState;
  private lastKeyframe = 0;
  private retry = 0;
  private stopped = true;
  private timer?: ReturnType<typeof setTimeout>;
  onFanEvent?: (e: FanEvent) => void;
  onStatus?: (s: RelayStatus, viewers: number) => void;

  constructor(private o: RelayClientOptions) {}

  start() {
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close(1000, 'bye');
    this.ws = undefined;
    this.setStatus('off');
  }

  private setStatus(s: RelayStatus) {
    this.status = s;
    this.onStatus?.(s, this.viewers);
  }

  private open() {
    this.setStatus('connecting');
    let ws: WSLike;
    try {
      ws = this.o.createSocket(this.o.url);
    } catch {
      this.setStatus('error');
      return this.scheduleReconnect();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.raw({ type: 'owner_hello', petId: this.o.petId, token: this.o.token, protocol: PROTOCOL_VERSION });
    };
    ws.onmessage = (ev) => {
      let m: ServerToOwner;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      switch (m.type) {
        case 'owner_welcome':
          this.retry = 0;
          this.viewers = m.viewers;
          this.lastSent = undefined; // force a fresh snapshot
          this.setStatus('online');
          break;
        case 'viewers':
          this.viewers = m.count;
          this.onStatus?.(this.status, this.viewers);
          break;
        case 'fan_event':
          this.onFanEvent?.(m.event);
          break;
        case 'error':
          if (m.message === 'unauthorized') this.setStatus('unauthorized');
          break;
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (ev?.code === 4001) {
        this.setStatus('unauthorized');
        return; // don't hammer the server with a bad token
      }
      if (this.status !== 'unauthorized') this.setStatus(this.stopped ? 'off' : 'error');
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.retry++) + Math.random() * 1000;
    this.timer = setTimeout(() => this.open(), delay);
  }

  private raw(m: OwnerToServer) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  get online() {
    return this.status === 'online';
  }

  publish(state: PublicState) {
    if (!this.online) return;
    const now = Date.now();
    if (!this.lastSent || now - this.lastKeyframe > (this.o.keyframeMs ?? 10_000)) {
      this.raw({ type: 'snapshot', state });
      this.lastKeyframe = now;
    } else {
      const d = diffPublicState(this.lastSent, state);
      if (d) this.raw({ type: 'delta', delta: d });
    }
    this.lastSent = state;
  }

  chat(message: PublicChat) {
    this.raw({ type: 'chat_public', message });
  }

  fanResult(eventId: string, fanId: string, status: 'approved' | 'rejected' | 'answered' | 'delivered', reason?: string) {
    this.raw({ type: 'fan_result', eventId, fanId, status, reason });
  }

  fanMode(mode: FanMode) {
    this.raw({ type: 'fan_mode', mode });
  }
}
