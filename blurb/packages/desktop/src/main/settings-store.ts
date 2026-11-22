/** settings.json in userData. Contains no secrets (only keychain ref names). */
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  CAPABILITIES,
  DEFAULT_SETTINGS,
  PROVIDER_IDS,
  type AppSettings,
  type CapabilitySet,
  type FanMode,
  type ProviderId,
} from '@blurb/shared';

const file = () => path.join(app.getPath('userData'), 'settings.json');

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const str = (v: unknown, max: number, d: string) => (typeof v === 'string' ? v.slice(0, max) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** Merge untrusted input (from disk or the renderer) onto defaults, field by field. */
export function sanitizeSettings(input: unknown): AppSettings {
  const i = (input ?? {}) as Partial<AppSettings>;
  const d = DEFAULT_SETTINGS;
  const llm = (i.llm ?? {}) as Partial<AppSettings['llm']>;
  const per = (i.personality ?? {}) as Partial<AppSettings['personality']>;
  const rel = (i.relay ?? {}) as Partial<AppSettings['relay']>;
  const fans = (i.fans ?? {}) as Partial<AppSettings['fans']>;
  const beh = (i.behavior ?? {}) as Partial<AppSettings['behavior']>;
  const peek = (beh.screenPeek ?? {}) as Partial<AppSettings['behavior']['screenPeek']>;
  const caps = {} as CapabilitySet;
  for (const c of CAPABILITIES) caps[c] = bool((i.capabilities as CapabilitySet | undefined)?.[c], d.capabilities[c]);
  const provider = (PROVIDER_IDS as readonly string[]).includes(llm.provider as string) ? (llm.provider as ProviderId) : d.llm.provider;
  const mode: FanMode = fans.mode === 'fan_chat' || fans.mode === 'treats_only' || fans.mode === 'view_only' ? fans.mode : d.fans.mode;
  return {
    llm: {
      provider,
      baseUrl: str(llm.baseUrl, 300, d.llm.baseUrl),
      model: str(llm.model, 200, ''),
      apiKeyRef: llm.apiKeyRef === 'llm' ? 'llm' : undefined,
      temperature: num(llm.temperature, 0, 2, d.llm.temperature),
      maxTokens: Math.round(num(llm.maxTokens, 32, 2048, d.llm.maxTokens)),
      ggufPath: typeof llm.ggufPath === 'string' ? llm.ggufPath.slice(0, 1000) : undefined,
      vision: bool(llm.vision, false),
    },
    personality: {
      name: str(per.name, 24, d.personality.name).trim() || 'Blurb',
      persona: str(per.persona, 4000, d.personality.persona),
      chattiness: num(per.chattiness, 0, 1, d.personality.chattiness),
    },
    capabilities: caps,
    relay: {
      enabled: bool(rel.enabled, false),
      url: str(rel.url, 300, d.relay.url),
      petId: str(rel.petId, 32, d.relay.petId).replace(/[^a-z0-9_-]/gi, '') || 'blurb',
      tokenRef: rel.tokenRef === 'relay' ? 'relay' : undefined,
    },
    fans: {
      mode,
      autoApproveChat: bool(fans.autoApproveChat, d.fans.autoApproveChat),
      shareOwnerChat: bool(fans.shareOwnerChat, d.fans.shareOwnerChat),
    },
    behavior: {
      simSpeed: num(beh.simSpeed, 0.25, 30, d.behavior.simSpeed),
      thinkIntervalSec: Math.round(num(beh.thinkIntervalSec, 0, 3600, d.behavior.thinkIntervalSec)),
      screenPeek: {
        enabled: bool(peek.enabled, false),
        intervalMin: num(peek.intervalMin, 2, 240, 15),
        allowCloud: bool(peek.allowCloud, false),
      },
    },
  };
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    return sanitizeSettings(JSON.parse(await fs.readFile(file(), 'utf8')));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export async function saveSettings(s: AppSettings): Promise<void> {
  const f = file();
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(`${f}.tmp`, JSON.stringify(s, null, 2), 'utf8');
  await fs.rename(`${f}.tmp`, f);
}
