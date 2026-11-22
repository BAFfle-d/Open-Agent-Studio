/**
 * WebSocket protocol between desktop (owner), relay server, and fan viewers.
 * JSON text frames, one message per frame, `type` discriminated.
 */
import type { PublicDelta, PublicState } from './public-state.js';
import type { Emotion, FanAction, FanEvent, FanMode } from './types.js';

export const PROTOCOL_VERSION = 1;
/** Hard cap on any inbound frame; fan frames are far smaller. */
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_FAN_FRAME_BYTES = 2 * 1024;

export interface PublicChat {
  id: string;
  role: 'pet' | 'fan' | 'system';
  author: string;
  text: string;
  emotion?: Emotion;
  createdAt: number;
  replyTo?: string;
}

// ---- desktop (owner) -> server ----
export type OwnerToServer =
  | { type: 'owner_hello'; petId: string; token: string; protocol: number }
  | { type: 'snapshot'; state: PublicState }
  | { type: 'delta'; delta: PublicDelta }
  | { type: 'chat_public'; message: PublicChat }
  | { type: 'fan_mode'; mode: FanMode }
  | { type: 'fan_result'; eventId: string; fanId: string; status: 'approved' | 'rejected' | 'answered' | 'delivered'; reason?: string };

// ---- server -> desktop ----
export type ServerToOwner =
  | { type: 'owner_welcome'; viewers: number }
  | { type: 'fan_event'; event: FanEvent }
  | { type: 'viewers'; count: number }
  | { type: 'error'; message: string };

// ---- fan -> server ----
export type FanToServer =
  | { type: 'fan_hello'; petId: string; nickname?: string; protocol: number }
  | { type: 'fan_action'; clientId: string; action: FanAction }
  | { type: 'set_nickname'; nickname: string };

export type FanAckStatus = 'queued' | 'delivered' | 'approved' | 'answered' | 'rejected' | 'rate_limited';

// ---- server -> fan ----
export type ServerToFan =
  | {
      type: 'fan_welcome';
      fanId: string;
      nickname: string;
      petOnline: boolean;
      fanMode: FanMode;
      state?: PublicState;
      chat: PublicChat[];
      viewers: number;
    }
  | { type: 'snapshot'; state: PublicState }
  | { type: 'delta'; delta: PublicDelta }
  | { type: 'chat'; message: PublicChat }
  | { type: 'presence'; petOnline: boolean; viewers: number }
  | { type: 'fan_mode'; mode: FanMode }
  | { type: 'fan_ack'; clientId: string; eventId?: string; status: FanAckStatus; reason?: string; retryAfterMs?: number }
  | { type: 'nickname'; nickname: string }
  | { type: 'error'; message: string };

export function safeParse(raw: unknown, maxBytes = MAX_FRAME_BYTES): { type: string; [k: string]: unknown } | null {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else if (raw instanceof ArrayBuffer) text = new TextDecoder().decode(raw);
  else if (ArrayBuffer.isView(raw)) text = new TextDecoder().decode(raw as Uint8Array);
  else if (Array.isArray(raw)) return null; // fragmented Buffer[] — not supported
  else return null;
  if (text.length > maxBytes) return null;
  try {
    const v = JSON.parse(text);
    if (typeof v !== 'object' || v === null || Array.isArray(v) || typeof v.type !== 'string') return null;
    return v;
  } catch {
    return null;
  }
}
