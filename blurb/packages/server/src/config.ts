import { createHash, timingSafeEqual } from 'node:crypto';

export interface ServerConfig {
  port: number;
  host: string;
  /** petId -> sha256(token) */
  rooms: Map<string, Buffer>;
  /** Serve the built fan web app from here (optional). */
  webDist?: string;
  /** Honor X-Forwarded-For (only behind a proxy you control). */
  trustProxy: boolean;
  maxViewersPerRoom: number;
  maxConnsPerIp: number;
  extraBlocked: string[];
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest();

export function checkToken(cfg: ServerConfig, petId: string, token: unknown): boolean {
  const want = cfg.rooms.get(petId);
  if (!want || typeof token !== 'string' || token.length < 8 || token.length > 256) return false;
  return timingSafeEqual(want, sha256(token));
}

/**
 * ROOM_TOKENS="blurb:some-long-random-token,other:another-token"
 * Generate a token with: node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rooms = new Map<string, Buffer>();
  for (const pair of (env.ROOM_TOKENS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf(':');
    if (i <= 0) continue;
    const petId = pair.slice(0, i).trim();
    const token = pair.slice(i + 1).trim();
    if (/^[a-z0-9_-]{1,32}$/i.test(petId) && token.length >= 8) rooms.set(petId, sha256(token));
  }
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '0.0.0.0',
    rooms,
    webDist: env.WEB_DIST,
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    maxViewersPerRoom: Number(env.MAX_VIEWERS ?? 500),
    maxConnsPerIp: Number(env.MAX_CONNS_PER_IP ?? 6),
    extraBlocked: (env.BLOCKLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}
