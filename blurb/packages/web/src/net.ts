/** Fan-side connection to the relay, with auto-reconnect. */
import {
  PROTOCOL_VERSION,
  applyPublicDelta,
  type FanAckStatus,
  type FanAction,
  type FanMode,
  type PublicChat,
  type PublicState,
  type ServerToFan,
} from '@blurb/shared';

export interface FanView {
  connected: boolean;
  petOnline: boolean;
  viewers: number;
  fanMode: FanMode;
  nickname: string;
  state?: PublicState;
  chat: PublicChat[];
  error?: string;
}

export interface Ack {
  clientId: string;
  eventId?: string;
  status: FanAckStatus;
  reason?: string;
  retryAfterMs?: number;
  at: number;
}

type Listener = (v: FanView) => void;

export class FanClient {
  view: FanView = { connected: false, petOnline: false, viewers: 0, fanMode: 'view_only', nickname: '', chat: [] };
  private ws?: WebSocket;
  private listeners = new Set<Listener>();
  private ackListeners = new Set<(a: Ack) => void>();
  private stateListeners = new Set<(s: PublicState) => void>();
  private retry = 0;
  private stopped = false;
  private seq = 0;

  constructor(
    private url: string,
    private petId: string,
    private nickname?: string,
  ) {}

  start() {
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }

  on(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onAck(fn: (a: Ack) => void) {
    this.ackListeners.add(fn);
    return () => this.ackListeners.delete(fn);
  }
  onState(fn: (s: PublicState) => void) {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  private set(patch: Partial<FanView>) {
    this.view = { ...this.view, ...patch };
    for (const fn of this.listeners) fn(this.view);
  }

  private setState(s: PublicState) {
    this.view.state = s;
    for (const fn of this.stateListeners) fn(s);
  }

  private open() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ type: 'fan_hello', petId: this.petId, nickname: this.nickname, protocol: PROTOCOL_VERSION }));
    };
    ws.onmessage = (ev) => {
      let m: ServerToFan;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.handle(m);
    };
    ws.onclose = () => {
      this.set({ connected: false });
      if (this.stopped) return;
      const delay = Math.min(15000, 1000 * 2 ** this.retry++) + Math.random() * 500;
      setTimeout(() => this.open(), delay);
    };
  }

  private handle(m: ServerToFan) {
    switch (m.type) {
      case 'fan_welcome':
        if (m.state) this.setState(m.state);
        this.set({ connected: true, petOnline: m.petOnline, fanMode: m.fanMode, nickname: m.nickname, chat: m.chat, viewers: m.viewers, error: undefined });
        break;
      case 'snapshot':
        this.setState(m.state);
        this.set({ fanMode: m.state.fanMode });
        break;
      case 'delta':
        if (this.view.state) {
          this.setState(applyPublicDelta(this.view.state, m.delta));
          if (m.delta.fanMode) this.set({ fanMode: m.delta.fanMode });
        }
        break;
      case 'chat':
        this.set({ chat: [...this.view.chat, m.message].slice(-50) });
        break;
      case 'presence':
        this.set({ petOnline: m.petOnline, viewers: m.viewers });
        break;
      case 'fan_mode':
        this.set({ fanMode: m.mode });
        break;
      case 'nickname':
        this.set({ nickname: m.nickname });
        try {
          localStorage.setItem('blurb.nickname', m.nickname);
        } catch {
          /* storage unavailable */
        }
        break;
      case 'fan_ack':
        for (const fn of this.ackListeners) fn({ ...m, at: Date.now() });
        break;
      case 'error':
        this.set({ error: m.message });
        break;
    }
  }

  send(action: FanAction): string {
    const clientId = `c${++this.seq}`;
    this.ws?.send(JSON.stringify({ type: 'fan_action', clientId, action }));
    return clientId;
  }

  setNickname(n: string) {
    this.ws?.send(JSON.stringify({ type: 'set_nickname', nickname: n }));
  }
}
