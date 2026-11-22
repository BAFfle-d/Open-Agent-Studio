import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@blurb/shared';
import { ChatQueue, MemoryStore, createProvider, isLocalConfig, scanForGguf, toAnthropic, type QueueItem } from '../src/index.js';

function sseResponse(events: string[], status = 200): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      // split events awkwardly across chunks to exercise the parser
      const joined = events.map((e) => `data: ${e}\n\n`).join('');
      for (let i = 0; i < joined.length; i += 7) c.enqueue(enc.encode(joined.slice(i, i + 7)));
      c.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

describe('OpenAI-compatible provider', () => {
  it('streams deltas and sends the right request', async () => {
    let seen: { url: string; body: any; headers: any } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)), headers: init.headers };
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { content: '[[emotion:happy]] Hel' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'lo!' } }] }),
        '[DONE]',
      ]);
    }) as unknown as typeof fetch;
    const p = createProvider({ ...DEFAULT_SETTINGS.llm, provider: 'ollama', model: 'llama3.2', baseUrl: 'http://localhost:11434/v1/' }, undefined, fetchImpl)!;
    let out = '';
    for await (const t of p.stream({ messages: [{ role: 'user', content: 'hi' }] })) out += t;
    expect(out).toBe('[[emotion:happy]] Hello!');
    expect(seen!.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(seen!.body).toMatchObject({ model: 'llama3.2', stream: true });
    expect(seen!.headers.authorization).toBeUndefined();
  });

  it('sends bearer keys for cloud providers and images only when vision is on', async () => {
    let body: any;
    let headers: any;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      headers = init.headers;
      return sseResponse(['[DONE]']);
    }) as unknown as typeof fetch;
    const img = { mime: 'image/png' as const, base64: 'AAAA' };
    const p = createProvider({ ...DEFAULT_SETTINGS.llm, provider: 'openai', model: 'm', baseUrl: '', vision: true }, 'sk-test', fetchImpl)!;
    await p.complete({ messages: [{ role: 'user', content: 'what is this', image: img }] });
    expect(headers.authorization).toBe('Bearer sk-test');
    expect(body.messages[0].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
    const noVision = createProvider({ ...DEFAULT_SETTINGS.llm, provider: 'openai', model: 'm', baseUrl: '', vision: false }, 'sk-test', fetchImpl)!;
    await noVision.complete({ messages: [{ role: 'user', content: 'what is this', image: img }] });
    expect(body.messages[0].content).toBe('what is this');
  });

  it('refuses to build a cloud provider without a key', () => {
    expect(createProvider({ ...DEFAULT_SETTINGS.llm, provider: 'openai', model: 'm' })).toBeNull();
    expect(createProvider({ ...DEFAULT_SETTINGS.llm, provider: 'rules' })).toBeNull();
  });

  it('reports HTTP errors without leaking the key', async () => {
    const fetchImpl = (async () => new Response('{"error":"bad key"}', { status: 401 })) as unknown as typeof fetch;
    const p = createProvider({ ...DEFAULT_SETTINGS.llm, provider: 'openrouter', model: 'x', baseUrl: '' }, 'sk-secret', fetchImpl)!;
    const r = await p.test();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/401/);
    expect(r.message).not.toContain('sk-secret');
  });
});

describe('Anthropic provider', () => {
  it('maps system + merges roles, and streams text_delta events', async () => {
    let body: any;
    let headers: any;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      headers = init.headers;
      return sseResponse([
        JSON.stringify({ type: 'message_start', message: {} }),
        JSON.stringify({ type: 'content_block_start', index: 0 }),
        JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi ' } }),
        JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'there' } }),
        JSON.stringify({ type: 'message_stop' }),
      ]);
    }) as unknown as typeof fetch;
    const p = createProvider({ ...DEFAULT_SETTINGS.llm, provider: 'anthropic', model: 'claude-haiku-5-5', baseUrl: '' }, 'k', fetchImpl)!;
    const out = await p.complete({
      messages: [
        { role: 'system', content: 'be a blob' },
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ],
    });
    expect(out).toBe('Hi there');
    expect(body.system).toBe('be a blob');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toHaveLength(2);
    expect(headers['x-api-key']).toBe('k');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('always starts with a user turn', () => {
    const r = toAnthropic([{ role: 'assistant', content: 'hello' }], true);
    expect(r.messages[0].role).toBe('user');
  });
});

describe('isLocalConfig', () => {
  it('treats localhost custom servers as local, cloud as not', () => {
    expect(isLocalConfig({ ...DEFAULT_SETTINGS.llm, provider: 'custom', baseUrl: 'http://127.0.0.1:9000/v1' })).toBe(true);
    expect(isLocalConfig({ ...DEFAULT_SETTINGS.llm, provider: 'custom', baseUrl: 'https://example.com/v1' })).toBe(false);
    expect(isLocalConfig({ ...DEFAULT_SETTINGS.llm, provider: 'openai', baseUrl: 'https://api.openai.com/v1' })).toBe(false);
  });
});

describe('ChatQueue', () => {
  it('owner messages preempt in-flight fan replies', async () => {
    const log: string[] = [];
    const q = new ChatQueue<string>(async (item, signal) => {
      log.push(`start ${item.payload}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, item.priority === 0 ? 5 : 50);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          log.push(`abort ${item.payload}`);
          resolve();
        });
      });
      if (!signal.aborted) log.push(`done ${item.payload}`);
    });
    const mk = (id: string, priority: number): QueueItem<string> => ({ id, priority, enqueuedAt: Date.now(), payload: id });
    q.push(mk('fan1', 10));
    q.push(mk('fan2', 10));
    await new Promise((r) => setTimeout(r, 10));
    q.push(mk('owner', 0));
    await new Promise((r) => setTimeout(r, 200));
    expect(log).toEqual(['start fan1', 'abort fan1', 'start owner', 'done owner', 'start fan1', 'done fan1', 'start fan2', 'done fan2']);
  });

  it('bounds the fan queue', () => {
    const q = new ChatQueue<string>(() => new Promise(() => {}), { maxFanQueue: 2, fanTtlMs: 1000 });
    const mk = (id: string): QueueItem<string> => ({ id, priority: 10, enqueuedAt: Date.now(), payload: id });
    expect(q.push(mk('a'))).toBe(true); // starts running immediately
    expect(q.push(mk('b'))).toBe(true);
    expect(q.push(mk('c'))).toBe(true);
    expect(q.push(mk('d'))).toBe(false);
  });
});

describe('MemoryStore', () => {
  it('recalls relevant notes and dedupes', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'blurb-mem-'));
    const m = new MemoryStore(path.join(dir, 'memory.json'));
    m.add('owner_fact', 'Owner loves strawberry ice cream');
    m.add('owner_fact', 'Owner has a dog named Biscuit');
    m.add('owner_fact', 'Owner loves strawberry ice cream!');
    expect(m.list()).toHaveLength(2);
    expect(m.recall('what is my dog called? Biscuit', 1)[0].text).toMatch(/Biscuit/);
    await m.flush();
    const m2 = new MemoryStore(path.join(dir, 'memory.json'));
    await m2.load();
    expect(m2.list()).toHaveLength(2);
  });
});

describe('GGUF scan', () => {
  it('finds primary gguf files, follows HF-cache symlinks, skips shards/projectors', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'blurb-gguf-'));
    const big = Buffer.alloc(11 * 1024 * 1024);
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    writeFileSync(path.join(root, 'a', 'tiny-model-Q4_K_M.gguf'), big);
    writeFileSync(path.join(root, 'a', 'b', 'big-00001-of-00002.gguf'), big);
    writeFileSync(path.join(root, 'a', 'b', 'big-00002-of-00002.gguf'), big);
    writeFileSync(path.join(root, 'a', 'mmproj-f16.gguf'), big);
    writeFileSync(path.join(root, 'a', 'small.gguf'), Buffer.alloc(100));
    mkdirSync(path.join(root, 'snap'));
    symlinkSync(path.join(root, 'a', 'tiny-model-Q4_K_M.gguf'), path.join(root, 'snap', 'linked.gguf'));
    const found = await scanForGguf([{ dir: root, source: 'test' }]);
    expect(found.map((f) => f.name).sort()).toEqual(['big-00001-of-00002.gguf', 'tiny-model-Q4_K_M.gguf']);
  });
});
