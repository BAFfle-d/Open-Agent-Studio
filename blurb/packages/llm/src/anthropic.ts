/** Native Anthropic Messages API adapter (streaming). */
import { collect, explainError, LLMError, type GenerateOptions, type LLMMessage, type LLMProvider, type TestResult } from './provider.js';
import { readSSE } from './sse.js';

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  vision?: boolean;
  fetchImpl?: typeof fetch;
}

type Block = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** System messages go top-level; consecutive same-role turns are merged. */
export function toAnthropic(messages: LLMMessage[], vision: boolean): { system: string; messages: Array<{ role: 'user' | 'assistant'; content: Block[] }> } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const out: Array<{ role: 'user' | 'assistant'; content: Block[] }> = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const blocks: Block[] = [];
    if (m.image && vision && m.role === 'user') {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: m.image.mime, data: m.image.base64 } });
    }
    blocks.push({ type: 'text', text: m.content || '…' });
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content.push(...blocks);
    else out.push({ role: m.role, content: blocks });
  }
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(start)' }] });
  return { system, messages: out };
}

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic' as const;
  readonly model: string;
  private base: string;
  private f: typeof fetch;

  constructor(private o: AnthropicOptions) {
    this.model = o.model;
    this.base = (o.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/+$/, '');
    this.f = o.fetchImpl ?? fetch;
  }

  private headers() {
    return {
      'content-type': 'application/json',
      'x-api-key': this.o.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  async *stream(opts: GenerateOptions): AsyncIterable<string> {
    const { system, messages } = toAnthropic(opts.messages, this.o.vision ?? true);
    const res = await this.f(`${this.base}/messages`, {
      method: 'POST',
      headers: this.headers(),
      signal: opts.signal,
      body: JSON.stringify({
        model: this.model,
        system: system || undefined,
        messages,
        max_tokens: opts.maxTokens ?? 256,
        temperature: opts.temperature ?? 0.8,
        stream: true,
      }),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new LLMError(`HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
    for await (const ev of readSSE(res.body, opts.signal)) {
      let json: { type?: string; delta?: { type?: string; text?: string }; error?: { message?: string } };
      try {
        json = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (json.type === 'error') throw new LLMError(json.error?.message ?? 'Anthropic error');
      if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta' && json.delta.text) yield json.delta.text;
      if (json.type === 'message_stop') return;
    }
  }

  complete(opts: GenerateOptions) {
    return collect(this.stream(opts));
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await this.f(`${this.base}/models?limit=100`, { headers: this.headers(), signal });
    if (!res.ok) throw new LLMError(`HTTP ${res.status}`, res.status);
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    return (json.data ?? []).map((m) => m.id);
  }

  async test(): Promise<TestResult> {
    const t0 = Date.now();
    try {
      if (!this.model) {
        const models = await this.listModels();
        return { ok: true, message: `Connected. ${models.length} models available — pick one.`, latencyMs: Date.now() - t0 };
      }
      const reply = await this.complete({ messages: [{ role: 'user', content: 'Reply with just the word: ready' }], maxTokens: 8, temperature: 0 });
      return { ok: true, message: `Connected to ${this.model}: "${reply.trim().slice(0, 40)}"`, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, message: explainError(e, this.base) };
    }
  }
}
