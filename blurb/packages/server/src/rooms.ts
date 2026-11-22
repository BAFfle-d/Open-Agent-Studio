/**
 * Transport-agnostic relay logic. One Room per pet.
 *
 * Trust model:
 *  - The owner (desktop app) authenticates with a per-pet token. Only the
 *    owner can publish state and public chat.
 *  - Fans are anonymous. Everything they send is size-capped, rate-limited
 *    (per fan, per IP-hash, and per room), filtered, and gated by the owner's
 *    fan mode before it is forwarded. Fan chat is never shown publicly until
 *    the owner's app approves it.
 *  - The server never sends the owner's IP, or anything not in PublicState,
 *    to fans. It doesn't know anything else: the desktop never sends it.
 */
import { randomBytes } from 'node:crypto';
import {
  FAN_RATE_RULES,
  KeyedLimiter,
  MAX_FAN_FRAME_BYTES,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  ROOM_RATE_RULES,
  TOYS,
  TREATS,
  applyPublicDelta,
  makeId,
  safeParse,
  sanitizeNickname,
  screenFanChat,
  type FanAction,
  type FanEvent,
  type FanMode,
  type PublicChat,
  type PublicDelta,
  type PublicState,
  type ServerToFan,
  type ServerToOwner,
} from '@blurb/shared';
import { checkToken, sha256, type ServerConfig } from './config.js';

export interface Conn {
  send(msg: object): void;
  close(code?: number, reason?: string): void;
  /** Salted hash of the remote IP. Used only for rate limiting, never sent. */
  ipKey: string;
}

interface Fan {
  id: string;
  nickname: string;
  conn: Conn;
}

const CHAT_LOG = 50;

export class Room {
  owner?: Conn;
  state?: PublicState;
  chat: PublicChat[] = [];
  fanMode: FanMode = 'view_only';
  fans = new Map<string, Fan>();
  /** eventId -> fanId, so owner decisions route back to the right fan. */
  pending = new Map<string, { fanId: string; text?: string; nickname: string; at: number }>();
  private roomLimiter = new KeyedLimiter(ROOM_RATE_RULES);

  constructor(readonly petId: string) {}

  broadcast(msg: ServerToFan) {
    for (const f of this.fans.values()) f.conn.send(msg);
  }

  toOwner(msg: ServerToOwner) {
    this.owner?.send(msg);
  }

  presence() {
    this.broadcast({ type: 'presence', petOnline: !!this.owner, viewers: this.fans.size });
    this.toOwner({ type: 'viewers', count: this.fans.size });
  }

  roomTake(kind: 'treat' | 'toy' | 'chat') {
    return this.roomLimiter.take('room', kind);
  }

  pushChat(m: PublicChat) {
    this.chat.push(m);
    if (this.chat.length > CHAT_LOG) this.chat.shift();
    this.broadcast({ type: 'chat', message: m });
  }
}

export class Relay {
  rooms = new Map<string, Room>();
  private fanLimiter = new KeyedLimiter(FAN_RATE_RULES);
  private connsPerIp = new Map<string, number>();
  private salt = randomBytes(16).toString('hex');

  constructor(readonly cfg: ServerConfig) {}

  ipKey(ip: string) {
    return sha256(`${this.salt}:${ip}`).toString('hex').slice(0, 16);
  }

  /** Returns false if this IP already has too many sockets open. */
  admit(ipKey: string): boolean {
    const n = this.connsPerIp.get(ipKey) ?? 0;
    if (n >= this.cfg.maxConnsPerIp) return false;
    this.connsPerIp.set(ipKey, n + 1);
    return true;
  }

  release(ipKey: string) {
    const n = (this.connsPerIp.get(ipKey) ?? 1) - 1;
    if (n <= 0) this.connsPerIp.delete(ipKey);
    else this.connsPerIp.set(ipKey, n);
  }

  room(petId: string): Room | undefined {
    if (!this.cfg.rooms.has(petId)) return undefined;
    let r = this.rooms.get(petId);
    if (!r) this.rooms.set(petId, (r = new Room(petId)));
    return r;
  }

  publicStatus(petId: string) {
    const r = this.rooms.get(petId);
    if (!this.cfg.rooms.has(petId)) return null;
    return { petId, online: !!r?.owner, viewers: r?.fans.size ?? 0, name: r?.state?.pet.name ?? null };
  }

  /**
   * Handle a connection's lifetime. Returns handlers for the transport to call.
   * The first frame decides the role.
   */
  connect(conn: Conn) {
    let role: 'unknown' | 'owner' | 'fan' = 'unknown';
    let room: Room | undefined;
    let fan: Fan | undefined;
    const helloTimer = setTimeout(() => role === 'unknown' && conn.close(4000, 'hello timeout'), 5000);

    const onMessage = (raw: unknown) => {
      const limit = role === 'owner' ? MAX_FRAME_BYTES : MAX_FAN_FRAME_BYTES;
      const msg = safeParse(raw, limit);
      if (!msg) {
        if (role !== 'owner') conn.close(4002, 'bad frame');
        return;
      }
      if (role === 'unknown') {
        clearTimeout(helloTimer);
        if (msg.type === 'owner_hello') {
          room = typeof msg.petId === 'string' ? this.room(msg.petId) : undefined;
          if (!room || !checkToken(this.cfg, room.petId, msg.token) || msg.protocol !== PROTOCOL_VERSION) {
            conn.send({ type: 'error', message: 'unauthorized' } satisfies ServerToOwner);
            conn.close(4001, 'unauthorized');
            return;
          }
          if (room.owner && room.owner !== conn) room.owner.close(4003, 'replaced by a newer session');
          role = 'owner';
          room.owner = conn;
          conn.send({ type: 'owner_welcome', viewers: room.fans.size } satisfies ServerToOwner);
          room.presence();
          return;
        }
        if (msg.type === 'fan_hello') {
          room = typeof msg.petId === 'string' ? this.room(msg.petId) : undefined;
          if (!room) {
            conn.send({ type: 'error', message: 'no such pet' } satisfies ServerToFan);
            conn.close(4004, 'no such pet');
            return;
          }
          if (room.fans.size >= this.cfg.maxViewersPerRoom) {
            conn.send({ type: 'error', message: 'room is full, try again soon' } satisfies ServerToFan);
            conn.close(4005, 'full');
            return;
          }
          role = 'fan';
          const nickname = sanitizeNickname(msg.nickname) ?? `Visitor-${randomBytes(2).toString('hex')}`;
          fan = { id: makeId('fan'), nickname, conn };
          room.fans.set(fan.id, fan);
          conn.send({
            type: 'fan_welcome',
            fanId: fan.id,
            nickname,
            petOnline: !!room.owner,
            fanMode: room.fanMode,
            state: room.state,
            chat: room.chat,
            viewers: room.fans.size,
          } satisfies ServerToFan);
          room.presence();
          return;
        }
        conn.close(4002, 'expected hello');
        return;
      }
      if (role === 'owner' && room) this.onOwner(room, msg);
      else if (role === 'fan' && room && fan) this.onFan(room, fan, msg);
    };

    const onClose = () => {
      clearTimeout(helloTimer);
      if (!room) return;
      if (role === 'owner' && room.owner === conn) {
        room.owner = undefined;
        room.pending.clear();
        room.presence();
      }
      if (role === 'fan' && fan) {
        room.fans.delete(fan.id);
        this.fanLimiter.forget(fan.id);
        room.presence();
      }
    };

    return { onMessage, onClose };
  }

  private onOwner(room: Room, msg: { type: string; [k: string]: unknown }) {
    switch (msg.type) {
      case 'snapshot': {
        const s = msg.state as PublicState;
        if (!s || typeof s !== 'object' || s.v !== 1 || !s.pet || !Array.isArray(s.objects)) return;
        room.state = s;
        if (s.fanMode && s.fanMode !== room.fanMode) this.setMode(room, s.fanMode);
        room.broadcast({ type: 'snapshot', state: s });
        break;
      }
      case 'delta': {
        const d = msg.delta as PublicDelta;
        if (!room.state || !d || typeof d !== 'object') return;
        room.state = applyPublicDelta(room.state, d);
        if (d.fanMode) this.setMode(room, d.fanMode);
        room.broadcast({ type: 'delta', delta: d });
        break;
      }
      case 'chat_public': {
        const m = msg.message as PublicChat;
        if (!m || typeof m.text !== 'string') return;
        room.pushChat({
          id: String(m.id ?? makeId('chat')).slice(0, 64),
          role: m.role === 'fan' || m.role === 'system' ? m.role : 'pet',
          author: String(m.author ?? '').slice(0, 32),
          text: m.text.slice(0, 600),
          emotion: m.emotion,
          createdAt: Date.now(),
          replyTo: typeof m.replyTo === 'string' ? m.replyTo.slice(0, 64) : undefined,
        });
        break;
      }
      case 'fan_mode':
        if (msg.mode === 'fan_chat' || msg.mode === 'treats_only' || msg.mode === 'view_only') this.setMode(room, msg.mode);
        break;
      case 'fan_result': {
        const p = room.pending.get(String(msg.eventId));
        if (!p) return;
        const status = msg.status as 'approved' | 'rejected' | 'answered' | 'delivered';
        if (!['approved', 'rejected', 'answered', 'delivered'].includes(status)) return;
        // Keep the route through 'approved' so the later 'answered' still reaches the fan.
        if (status === 'rejected' || status === 'answered') room.pending.delete(String(msg.eventId));
        const f = room.fans.get(p.fanId);
        f?.conn.send({ type: 'fan_ack', clientId: '', eventId: String(msg.eventId), status, reason: typeof msg.reason === 'string' ? msg.reason.slice(0, 120) : undefined });
        // Approved fan chat becomes public only now — after the owner's app said yes.
        if (status === 'approved' && p.text) {
          room.pushChat({ id: String(msg.eventId), role: 'fan', author: p.nickname, text: p.text, createdAt: Date.now() });
        }
        break;
      }
    }
  }

  private setMode(room: Room, mode: FanMode) {
    if (room.fanMode === mode) return;
    room.fanMode = mode;
    room.broadcast({ type: 'fan_mode', mode });
  }

  private onFan(room: Room, fan: Fan, msg: { type: string; [k: string]: unknown }) {
    const ack = (status: ServerToFan & { type: 'fan_ack' }) => fan.conn.send(status);
    if (msg.type === 'set_nickname') {
      const n = sanitizeNickname(msg.nickname);
      if (n) {
        fan.nickname = n;
        fan.conn.send({ type: 'nickname', nickname: n });
      } else fan.conn.send({ type: 'error', message: 'That nickname is not allowed.' });
      return;
    }
    if (msg.type !== 'fan_action') return;
    const clientId = typeof msg.clientId === 'string' ? msg.clientId.slice(0, 40) : '';
    const action = this.parseAction(msg.action);
    if (!action) return ack({ type: 'fan_ack', clientId, status: 'rejected', reason: 'Unknown action.' });

    if (!room.owner) return ack({ type: 'fan_ack', clientId, status: 'rejected', reason: 'The pet is offline right now.' });
    if (room.fanMode === 'view_only') return ack({ type: 'fan_ack', clientId, status: 'rejected', reason: 'The owner has set view-only mode.' });
    if (room.fanMode === 'treats_only' && action.type === 'chat')
      return ack({ type: 'fan_ack', clientId, status: 'rejected', reason: 'Chat is off right now — treats and toys only.' });

    // Rate limits: per fan, per IP, and per room.
    for (const key of [fan.id, `ip:${fan.conn.ipKey}`]) {
      const wait = Math.max(this.fanLimiter.take(key, 'any'), this.fanLimiter.take(key, action.type));
      if (wait) return ack({ type: 'fan_ack', clientId, status: 'rate_limited', retryAfterMs: wait, reason: 'Slow down a little!' });
    }
    const roomWait = room.roomTake(action.type);
    if (roomWait) return ack({ type: 'fan_ack', clientId, status: 'rate_limited', retryAfterMs: roomWait, reason: 'Lots of visitors right now — try again in a moment.' });

    let text: string | undefined;
    if (action.type === 'chat') {
      const r = screenFanChat(action.text, this.cfg.extraBlocked);
      if (!r.ok) return ack({ type: 'fan_ack', clientId, status: 'rejected', reason: 'That message can’t be sent. Keep it friendly!' });
      action.text = r.text;
      text = r.text;
    }

    const event: FanEvent = { id: makeId('evt'), fanId: fan.id, nickname: fan.nickname, action, receivedAt: Date.now() };
    room.pending.set(event.id, { fanId: fan.id, text, nickname: fan.nickname, at: Date.now() });
    if (room.pending.size > 500) room.pending.delete(room.pending.keys().next().value!);
    room.toOwner({ type: 'fan_event', event });
    ack({ type: 'fan_ack', clientId, eventId: event.id, status: action.type === 'chat' ? 'queued' : 'delivered' });
  }

  private parseAction(a: unknown): FanAction | null {
    if (!a || typeof a !== 'object') return null;
    const o = a as Record<string, unknown>;
    if (o.type === 'treat' && typeof o.treat === 'string' && o.treat in TREATS) return { type: 'treat', treat: o.treat as keyof typeof TREATS };
    if (o.type === 'toy' && typeof o.toy === 'string' && o.toy in TOYS) return { type: 'toy', toy: o.toy as keyof typeof TOYS };
    if (o.type === 'chat' && typeof o.text === 'string') return { type: 'chat', text: o.text };
    return null;
  }
}
