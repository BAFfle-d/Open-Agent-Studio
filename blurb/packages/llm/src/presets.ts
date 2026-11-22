import type { LLMConfig, ProviderId } from '@blurb/shared';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatibleProvider } from './openai.js';
import type { LLMProvider } from './provider.js';

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  baseUrl: string;
  needsKey: boolean;
  /** Runs on this machine: nothing leaves it. */
  local: boolean;
  hint: string;
}

/** Port Blurb uses when it launches llama.cpp's llama-server for a .gguf. */
export const LLAMACPP_PORT = 8089;

export const PROVIDER_PRESETS: Record<ProviderId, ProviderPreset> = {
  rules: { id: 'rules', label: 'No AI (rule brain)', baseUrl: '', needsKey: false, local: true, hint: 'Blurb runs on built-in behaviors and phrases. Free, private, offline.' },
  ollama: { id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', needsKey: false, local: true, hint: 'Install Ollama, then e.g. `ollama pull llama3.2`.' },
  lmstudio: { id: 'lmstudio', label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', needsKey: false, local: true, hint: 'Start the local server in LM Studio’s Developer tab.' },
  llamacpp: { id: 'llamacpp', label: 'GGUF file (llama.cpp)', baseUrl: `http://127.0.0.1:${LLAMACPP_PORT}/v1`, needsKey: false, local: true, hint: 'Pick a .gguf found on disk or download one from Hugging Face. Needs llama.cpp’s `llama-server` installed.' },
  openai: { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true, local: false, hint: 'Uses your API key; messages go to OpenAI.' },
  anthropic: { id: 'anthropic', label: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com/v1', needsKey: true, local: false, hint: 'Uses your API key; messages go to Anthropic.' },
  gemini: { id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true, local: false, hint: 'Uses Gemini’s OpenAI-compatible endpoint with your API key.' },
  openrouter: { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, local: false, hint: 'One key, many models. Messages go to OpenRouter and the chosen model’s host.' },
  custom: { id: 'custom', label: 'Custom (OpenAI-compatible)', baseUrl: 'http://localhost:8000/v1', needsKey: false, local: false, hint: 'Any server that speaks /v1/chat/completions.' },
};

/** True when requests stay on this machine (used to gate screen peeks). */
export function isLocalConfig(cfg: LLMConfig): boolean {
  if (PROVIDER_PRESETS[cfg.provider]?.local) return true;
  try {
    const h = new URL(cfg.baseUrl).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

/** Build a provider. Returns null for the rule brain or an incomplete config. */
export function createProvider(cfg: LLMConfig, apiKey?: string, fetchImpl?: typeof fetch): LLMProvider | null {
  if (cfg.provider === 'rules') return null;
  const preset = PROVIDER_PRESETS[cfg.provider];
  if (preset.needsKey && !apiKey) return null;
  if (cfg.provider === 'anthropic') {
    return new AnthropicProvider({ apiKey: apiKey!, model: cfg.model, baseUrl: cfg.baseUrl || preset.baseUrl, vision: cfg.vision, fetchImpl });
  }
  const headers: Record<string, string> = {};
  if (cfg.provider === 'openrouter') headers['X-Title'] = 'Blurb Desktop Pet';
  return new OpenAICompatibleProvider({
    id: cfg.provider,
    baseUrl: cfg.baseUrl || preset.baseUrl,
    model: cfg.model,
    apiKey,
    headers,
    vision: cfg.vision,
    fetchImpl,
  });
}
