import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { DEFAULT_SETTINGS, PROTOCOL_VERSION, applyPublicDelta, type AppSettings, type PublicState } from '@blurb/shared';
import { buildServer, loadConfig } from '../../server/src/index.js';
import { PetHost, type WSLike } from '../src/index.js';

const TOKEN = 'e2e-token-abcdefgh';
let port = 0;
let closeServer: () => Promise<void>;

beforeAll(async () => {
  const { app } = await buildServer(loadConfig({ ROOM_TOKENS: `blurb:${TOKEN}`, MAX_CONNS_PER_IP: '50' } as NodeJS.ProcessEnv));
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as { port: number }).port;
  closeServer = () => app.close();
});
afterAll(() => closeServer());

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 4000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await wait(20);
  }
}

describe('host ↔ relay ↔ fan, end to end', () => {
  it('mirrors the world, handles fans, and never leaks private chat', async () => {
    const settings: AppSettings = structuredClone(DEFAULT_SETTINGS);
    settings.relay = { enabled: true, url: `ws://127.0.0.1:${port}/ws`, petId: 'blurb', tokenRef: 'relay' };
    settings.fans = { mode: 'fan_chat', autoApproveChat: true, shareOwnerChat: false };
    const host = await PetHost.load(settings, {
      dataDir: mkdtempSync(path.join(os.tmpdir(), 'blurb-host-')),
      getSecret: async (ref) => (ref === 'relay' ? TOKEN : undefined),
      createSocket: (url) => new WebSocket(url) as unknown as WSLike,
    });
    host.sim.hourOverride = 13;
    host.start();
    const fan = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    try {
    await until(() => host.relay?.status === 'online');

    // a fan connects and records every raw frame it receives
    const raw: string[] = [];
    let state: PublicState | undefined;
    fan.on('message', (d) => {
      const s = d.toString();
      raw.push(s);
      const m = JSON.parse(s);
      if (m.type === 'fan_welcome' && m.state) state = m.state;
      if (m.type === 'snapshot') state = m.state;
      if (m.type === 'delta' && state) state = applyPublicDelta(state, m.delta);
    });
    if (fan.readyState !== WebSocket.OPEN) await new Promise((r) => fan.on('open', r));
    fan.send(JSON.stringify({ type: 'fan_hello', petId: 'blurb', nickname: 'Sunny', protocol: PROTOCOL_VERSION }));
    await until(() => !!state);
    expect(state!.pet.name).toBe('Blurb');

    // owner chats privately (rule brain) — must not reach the fan
    host.ownerSay('hello my secret pineapple password');
    await wait(400);

    // fan gives a treat → bowl fills, mirrored to fan
    const bowlBefore = state!.objects.find((o) => o.k === 'food_bowl')!.s ?? 0;
    fan.send(JSON.stringify({ type: 'fan_action', clientId: 'a', action: { type: 'treat', treat: 'cookie' } }));
    await until(() => (state!.objects.find((o) => o.k === 'food_bowl')!.s ?? 0) > bowlBefore || raw.some((r) => r.includes('"eating"')));

    // fan chats → auto-approved → answered publicly
    fan.send(JSON.stringify({ type: 'fan_action', clientId: 'b', action: { type: 'chat', text: 'hello Blurb!' } }));
    await until(() => raw.some((r) => r.includes('"type":"chat"') && r.includes('"role":"pet"')));
    await until(() => raw.some((r) => r.includes('"status":"answered"')));

    // overlay mode: fan sees "out", with no screen coordinates
    host.setMode('overlay');
    await until(() => state!.pet.where === 'out');
    await wait(300);

    const all = raw.join('\n');
    expect(all).not.toContain('pineapple');
    expect(all).not.toContain('desktop":');
    expect(all).not.toContain(TOKEN);
    expect(host.ownerLog.some((m) => m.text.includes('pineapple'))).toBe(true);
    } finally {
      fan.close();
      await host.stop();
    }
  }, 15_000);
});
