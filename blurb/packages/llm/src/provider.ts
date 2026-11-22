/**
 * One interface for every brain Blurb can have.
 *
 * Everything except Anthropic speaks the OpenAI chat-completions dialect
 * (Ollama, LM Studio, llama.cpp's llama-server, OpenAI, Gemini's OpenAI
 * endpoint, OpenRouter, any custom server). Anthropic gets a native adapter
 * because its OpenAI-compat layer is a testing shim, not the real API.
 */
import type { ProviderId } from '@blurb/shared';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Optional image (screen question). Only sent to providers that support vision. */
  image?: { mime: 'image/png' | 'image/jpeg'; base64: string };
}

export interface GenerateOptions {
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface TestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

export interface LLMProvider {
  readonly id: ProviderId;
  readonly model: string;
  /** Yields text deltas as they arrive. */
  stream(opts: GenerateOptions): AsyncIterable<string>;
  complete(opts: GenerateOptions): Promise<string>;
  listModels(signal?: AbortSignal): Promise<string[]>;
  test(): Promise<TestResult>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

export async function collect(it: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const t of it) out += t;
  return out;
}

/** Friendly message for common failures. Never includes keys or headers. */
export function explainError(e: unknown, baseUrl: string): string {
  if (e instanceof LLMError) {
    if (e.status === 401 || e.status === 403) return 'The server rejected the API key (401/403). Check the key in Settings.';
    if (e.status === 404) return 'Endpoint or model not found (404). Check the base URL and model name.';
    if (e.status === 429) return 'Rate limited by the provider (429). Blurb will try again later.';
    return e.message;
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|network/i.test(msg)) {
    return `Couldn't reach ${new URL(baseUrl).host}. Is the server running?`;
  }
  if (/abort/i.test(msg)) return 'Request cancelled.';
  return msg.slice(0, 300);
}
