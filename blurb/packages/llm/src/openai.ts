import type { ProviderId } from '@blurb/shared';
import { collect, explainError, LLMError, type GenerateOptions, type LLMMessage, type LLMProvider, type TestResult } from './provider.js';
import { readSSE } from './sse.js';

export interface OpenAICompatOptions {
  id: ProviderId;
  baseUrl: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  vision?: boolean;
  fetchImpl?: typeof fetch;
}

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

function toWire(m: LLMMessage, vision: boolean): { role: string; content: string | Part[] } {
  if (m.image && vision && m.role === 'user') {
    return {
      role: m.role,
      content: [
        { type: 'text', text: m.content },
        { type: 'image_url', image_url: { url: `data:${m.image.mime};base64,${m.image.base64}` } },
      ],
    };
  }
  return { role: m.role, content: m.content };
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  private base: string;
  private f: typeof fetch;

  constructor(private o: OpenAICompatOptions) {
    this.id = o.id;
    this.model = o.model;
    this.base = o.baseUrl.replace(/\/+$/, '');
    this.f = o.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...this.o.headers };
    if (this.o.apiKey) h.authorization = `Bearer ${this.o.apiKey}`;
    return h;
  }

  async *stream(opts: GenerateOptions): AsyncIterable<string> {
    const res = await this.f(`${this.base}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      signal: opts.signal,
      body: JSON.stringify({
        model: this.model,
        messages: opts.messages.map((m) => toWire(m, !!this.o.vision)),
        temperature: opts.temperature ?? 0.8,
        max_tokens: opts.maxTokens ?? 256,
        stream: true,
      }),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new LLMError(`HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
    for await (const ev of readSSE(res.body, opts.signal)) {
      if (ev.data === '[DONE]') return;
      let json: { choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>; error?: { message?: string } };
      try {
        json = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (json.error) throw new LLMError(json.error.message ?? 'provider error');
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  complete(opts: GenerateOptions) {
    return collect(this.stream(opts));
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await this.f(`${this.base}/models`, { headers: this.headers(), signal });
    if (!res.ok) throw new LLMError(`HTTP ${res.status}`, res.status);
    const json = (await res.json()) as { data?: Array<{ id: string }>; models?: Array<{ name: string }> };
    const ids = json.data?.map((m) => m.id) ?? json.models?.map((m) => m.name) ?? [];
    return ids.map((id) => id.replace(/^models\//, '')).sort();
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
