import { loadConfig } from './config.js';
import { buildServer } from './app.js';

const cfg = loadConfig();
if (!cfg.rooms.size) {
  console.warn('[blurb-relay] No rooms configured. Set ROOM_TOKENS="blurb:<long-random-token>" (see README).');
}
const { app } = await buildServer(cfg);
await app.listen({ port: cfg.port, host: cfg.host });
console.log(`[blurb-relay] listening on http://${cfg.host}:${cfg.port}  rooms: ${[...cfg.rooms.keys()].join(', ') || '(none)'}`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
