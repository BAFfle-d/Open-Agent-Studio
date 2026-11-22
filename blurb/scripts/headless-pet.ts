/**
 * Run Blurb with no UI: the real PetHost (sim + brain + fan handling)
 * publishing to a relay. Handy for development, demos, and running a pet
 * 24/7 on a small server.
 *
 *   ROOM_TOKENS=blurb:devtoken123 npm run dev:server   # terminal 1
 *   PET_TOKEN=devtoken123 npm run headless              # terminal 2
 *   open http://localhost:5173 (npm run dev:web) or the relay's own page
 *
 * Optional brain:
 *   LLM_PROVIDER=ollama LLM_MODEL=llama3.2 npm run headless
 *   LLM_PROVIDER=anthropic LLM_MODEL=claude-haiku-5-5 LLM_API_KEY=... npm run headless
 */
import path from 'node:path';
import WebSocket from 'ws';
import { DEFAULT_SETTINGS, PROVIDER_IDS, type AppSettings, type FanMode, type ProviderId } from '@blurb/shared';
import { PROVIDER_PRESETS } from '@blurb/llm';
import { PetHost, type WSLike } from '@blurb/host';

const env = process.env;
const provider = (PROVIDER_IDS as readonly string[]).includes(env.LLM_PROVIDER ?? '') ? (env.LLM_PROVIDER as ProviderId) : 'rules';
const settings: AppSettings = structuredClone(DEFAULT_SETTINGS);
settings.llm = {
  ...settings.llm,
  provider,
  baseUrl: env.LLM_BASE_URL ?? PROVIDER_PRESETS[provider].baseUrl,
  model: env.LLM_MODEL ?? '',
  apiKeyRef: env.LLM_API_KEY ? 'llm' : undefined,
};
settings.relay = { enabled: true, url: env.RELAY_URL ?? 'ws://localhost:8787/ws', petId: env.PET_ID ?? 'blurb', tokenRef: 'relay' };
settings.fans = {
  mode: (env.FAN_MODE as FanMode) ?? 'fan_chat',
  autoApproveChat: env.AUTO_APPROVE !== '0',
  shareOwnerChat: false,
};
settings.behavior.simSpeed = Number(env.SIM_SPEED ?? 1);
if (env.PET_NAME) settings.personality.name = env.PET_NAME;

if (!env.PET_TOKEN) {
  console.error('Set PET_TOKEN to the token configured on the relay (ROOM_TOKENS="blurb:<token>").');
  process.exit(1);
}

const host = await PetHost.load(settings, {
  dataDir: env.DATA_DIR ?? path.resolve('scripts/out/headless-data'),
  getSecret: async (ref) => (ref === 'relay' ? env.PET_TOKEN : ref === 'llm' ? env.LLM_API_KEY : undefined),
  createSocket: (url) => new WebSocket(url) as unknown as WSLike,
});
if (env.HOUR) host.sim.hourOverride = Number(env.HOUR);

host.on((e) => {
  if (e.type === 'relay') console.log(`[relay] ${e.status} (${e.viewers} viewers)`);
  if (e.type === 'fan') console.log(`[fan] ${e.text}`);
  if (e.type === 'brain' && e.status === 'error') console.log(`[brain] ${e.message}`);
  if (e.type === 'moderation') {
    const p = e.items.filter((i) => i.status === 'pending');
    if (p.length) console.log(`[moderation] ${p.length} message(s) waiting (AUTO_APPROVE=0)`);
  }
  if (e.type === 'sim' && e.event.type === 'speech' && e.event.speech.visibility === 'public') console.log(`[${settings.personality.name}] ${e.event.speech.text}`);
  if (e.type === 'sim' && e.event.type === 'log') console.log(`  · ${e.event.text}`);
});
host.start();
console.log(`Blurb is running headless → ${settings.relay.url} (pet "${settings.relay.petId}", brain: ${provider})`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => void host.stop().then(() => process.exit(0)));
}
