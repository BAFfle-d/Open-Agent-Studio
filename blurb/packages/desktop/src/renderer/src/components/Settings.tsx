import { useEffect, useState } from 'react';
import { CAPABILITIES, CAPABILITY_LABELS, DEFAULT_PERSONA, PROVIDER_IDS, type AppSettings, type ProviderId } from '@blurb/shared';
import type { ProviderPreset } from '@blurb/llm';
import { api } from '../api';
import type { DesktopEvent, GgufInfo } from '../../../ipc-types';
import { Panel } from './Panels';

type Tab = 'brain' | 'personality' | 'abilities' | 'behavior' | 'live' | 'memory';

interface Props {
  settings: AppSettings;
  presets: Record<ProviderId, ProviderPreset>;
  hasApiKey: boolean;
  hasRelayToken: boolean;
  secureStorage: 'os' | 'weak' | 'unavailable';
  llamaServer: string | null;
  llama: { status: string; message?: string };
  download?: Extract<DesktopEvent, { type: 'download' }>;
  relay: { status: string; viewers: number };
  onSaved: (s: AppSettings, keys?: { hasApiKey?: boolean; hasRelayToken?: boolean }) => void;
  onClose: () => void;
}

const fmtSize = (b?: number) => (b ? (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`) : '');

export function SettingsPanel(p: Props) {
  const [tab, setTab] = useState<Tab>('brain');
  const [s, setS] = useState<AppSettings>(structuredClone(p.settings));
  const [saving, setSaving] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [ggufs, setGgufs] = useState<GgufInfo[] | null>(null);
  const [hfQuery, setHfQuery] = useState('qwen2.5 1.5b instruct gguf');
  const [hfRepos, setHfRepos] = useState<Array<{ id: string; downloads: number }>>([]);
  const [hfFiles, setHfFiles] = useState<{ repo: string; files: Array<{ file: string; sizeBytes?: number }> } | null>(null);
  const [memories, setMemories] = useState<Array<{ id: string; kind: string; text: string; createdAt: number }>>([]);
  const preset = p.presets[s.llm.provider];
  const dirty = JSON.stringify(s) !== JSON.stringify(p.settings);

  const set = <K extends keyof AppSettings>(k: K, v: Partial<AppSettings[K]>) => setS((prev) => ({ ...prev, [k]: { ...(prev[k] as object), ...v } }));

  useEffect(() => {
    if (tab === 'memory') void api.memoryList().then(setMemories);
  }, [tab]);

  const save = async () => {
    setSaving(true);
    const saved = await api.saveSettings(s);
    setS(structuredClone(saved));
    p.onSaved(saved);
    setSaving(false);
    setNote({ ok: true, text: 'Saved.' });
  };

  const refreshModels = async () => {
    setNote(null);
    const r = await api.listModels(s.llm);
    if (r.ok) {
      setModels(r.models);
      setNote({ ok: true, text: `${r.models.length} models found.` });
    } else setNote({ ok: false, text: r.error ?? 'Could not list models.' });
  };

  const test = async () => {
    setNote({ ok: true, text: 'Testing…' });
    const r = await api.testBrain(s.llm);
    setNote({ ok: r.ok, text: `${r.message}${r.latencyMs ? ` (${r.latencyMs} ms)` : ''}` });
  };

  const tabs: Array<[Tab, string]> = [
    ['brain', '🧠 Brain'],
    ['personality', '💖 Personality'],
    ['abilities', '🔐 Abilities'],
    ['behavior', '⏱️ Behavior'],
    ['live', '🌐 Live page'],
    ['memory', '📒 Memory'],
  ];

  return (
    <Panel title="Settings" onClose={p.onClose} wide>
      <nav className="tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>

      {tab === 'brain' && (
        <div className="form">
          <label>
            Provider
            <select
              value={s.llm.provider}
              onChange={(e) => {
                const id = e.target.value as ProviderId;
                set('llm', { provider: id, baseUrl: p.presets[id].baseUrl, model: '' });
                setModels([]);
                setNote(null);
              }}
            >
              {PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>
                  {p.presets[id].label}
                </option>
              ))}
            </select>
          </label>
          <p className="hint">
            {preset.hint} {preset.local && s.llm.provider !== 'rules' ? '🔒 Runs on this computer.' : ''}
          </p>

          {s.llm.provider !== 'rules' && s.llm.provider !== 'llamacpp' && (
            <label>
              Base URL
              <input value={s.llm.baseUrl} onChange={(e) => set('llm', { baseUrl: e.target.value })} spellCheck={false} />
            </label>
          )}

          {preset.needsKey || s.llm.provider === 'custom' ? (
            <div className="key-row">
              <label>
                API key {p.hasApiKey && <span className="ok">● saved in your OS keychain</span>}
                <input type="password" value={keyDraft} placeholder={p.hasApiKey ? '•••••••• (enter to replace)' : 'Paste your key'} onChange={(e) => setKeyDraft(e.target.value)} autoComplete="off" />
              </label>
              <button
                disabled={!keyDraft.trim()}
                onClick={async () => {
                  const r = await api.setSecret('llm', keyDraft);
                  setKeyDraft('');
                  setNote(r.ok ? { ok: true, text: 'Key saved to the keychain.' } : { ok: false, text: r.error ?? 'Could not save key.' });
                  if (r.ok) p.onSaved({ ...p.settings, llm: { ...p.settings.llm, apiKeyRef: 'llm' } }, { hasApiKey: true });
                }}
              >
                Save key
              </button>
              {p.hasApiKey && (
                <button className="ghost" onClick={async () => (await api.clearSecret('llm'), p.onSaved(p.settings, { hasApiKey: false }))}>
                  Forget key
                </button>
              )}
            </div>
          ) : null}
          {p.secureStorage !== 'os' && (preset.needsKey || s.llm.provider === 'custom') && (
            <p className="warn">
              {p.secureStorage === 'weak'
                ? 'No system keyring found (Linux): keys are only obfuscated, not encrypted. Install gnome-keyring or KWallet for real protection.'
                : 'Secure storage is unavailable on this system; keys cannot be saved.'}
            </p>
          )}

          {s.llm.provider === 'llamacpp' && (
            <div className="gguf">
              <p className="hint">
                llama-server: {p.llamaServer ? <code>{p.llamaServer}</code> : <span className="warn-inline">not found — install llama.cpp</span>} · status:{' '}
                <strong>{p.llama.status}</strong> {p.llama.message}
              </p>
              <div className="row">
                <button onClick={async () => setGgufs(await api.scanGguf())}>Scan this computer for .gguf files</button>
              </div>
              {ggufs && (
                <ul className="file-list">
                  {!ggufs.length && <li className="muted">No .gguf files found in the usual places.</li>}
                  {ggufs.map((g) => (
                    <li key={g.path} className={s.llm.ggufPath === g.path ? 'active' : ''}>
                      <button onClick={() => set('llm', { ggufPath: g.path, model: g.name })}>
                        <strong>{g.name}</strong> <small>{fmtSize(g.sizeBytes)} · {g.source}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="row">
                <input value={hfQuery} onChange={(e) => setHfQuery(e.target.value)} placeholder="Search Hugging Face for GGUF models" />
                <button onClick={async () => setHfRepos(await api.hfSearch(hfQuery))}>Search Hugging Face</button>
              </div>
              {hfRepos.length > 0 && (
                <ul className="file-list">
                  {hfRepos.slice(0, 8).map((r) => (
                    <li key={r.id}>
                      <button onClick={async () => setHfFiles({ repo: r.id, files: await api.hfFiles(r.id) })}>
                        {r.id} <small>{r.downloads.toLocaleString()} downloads</small>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {hfFiles && (
                <ul className="file-list">
                  {hfFiles.files.map((f) => (
                    <li key={f.file}>
                      <button
                        onClick={async () => {
                          const r = await api.hfDownload(hfFiles.repo, f.file);
                          if (r.ok && r.path) set('llm', { ggufPath: r.path, model: f.file });
                          setNote(r.ok ? { ok: true, text: 'Downloaded. Save to start it.' } : { ok: false, text: r.error ?? 'Download failed' });
                        }}
                      >
                        ⬇ {f.file} <small>{fmtSize(f.sizeBytes)}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {p.download && !p.download.done && !p.download.error && (
                <progress max={p.download.total || 1} value={p.download.received} aria-label="Download progress" />
              )}
              {s.llm.ggufPath && <p className="hint">Selected: <code>{s.llm.ggufPath}</code></p>}
            </div>
          )}

          {s.llm.provider !== 'rules' && s.llm.provider !== 'llamacpp' && (
            <div className="row">
              <label className="grow">
                Model
                <input list="model-list" value={s.llm.model} onChange={(e) => set('llm', { model: e.target.value })} placeholder="Pick or type a model id" spellCheck={false} />
                <datalist id="model-list">
                  {models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </label>
              <button onClick={refreshModels}>↻ List models</button>
            </div>
          )}

          {s.llm.provider !== 'rules' && (
            <>
              <div className="row">
                <label className="grow">
                  Creativity (temperature): {s.llm.temperature.toFixed(1)}
                  <input type="range" min={0} max={1.5} step={0.1} value={s.llm.temperature} onChange={(e) => set('llm', { temperature: Number(e.target.value) })} />
                </label>
                <label className="grow">
                  Max reply length: {s.llm.maxTokens} tokens
                  <input type="range" min={64} max={800} step={16} value={s.llm.maxTokens} onChange={(e) => set('llm', { maxTokens: Number(e.target.value) })} />
                </label>
              </div>
              <label className="check">
                <input type="checkbox" checked={s.llm.vision} onChange={(e) => set('llm', { vision: e.target.checked })} /> This model can see images (enables
                “ask about my screen”)
              </label>
              <div className="row">
                <button onClick={test}>Test connection</button>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'personality' && (
        <div className="form">
          <label>
            Name
            <input value={s.personality.name} maxLength={24} onChange={(e) => set('personality', { name: e.target.value })} />
          </label>
          <label>
            Personality prompt <small>({'{name}'} is replaced with the name)</small>
            <textarea rows={8} value={s.personality.persona} onChange={(e) => set('personality', { persona: e.target.value })} />
          </label>
          <div className="row">
            <button className="ghost" onClick={() => set('personality', { persona: DEFAULT_PERSONA })}>Reset to default</button>
          </div>
          <label>
            Chattiness: {Math.round(s.personality.chattiness * 100)}%
            <input type="range" min={0} max={1} step={0.05} value={s.personality.chattiness} onChange={(e) => set('personality', { chattiness: Number(e.target.value) })} />
          </label>
          <p className="hint">Skin and shape live in the 📦 drop box.</p>
        </div>
      )}

      {tab === 'abilities' && (
        <div className="form">
          <p className="hint">
            Blurb’s “coding” is a fixed instruction set (BlurbScript), checked against these switches before anything happens. It can’t invent new
            instructions, so it can’t give itself powers you haven’t listed here — no flying, no new kinds of objects, no files or apps.
          </p>
          {CAPABILITIES.map((c) => (
            <label className="check" key={c}>
              <input type="checkbox" checked={s.capabilities[c]} onChange={(e) => set('capabilities', { [c]: e.target.checked })} /> {CAPABILITY_LABELS[c]}
            </label>
          ))}
        </div>
      )}

      {tab === 'behavior' && (
        <div className="form">
          <label>
            Time speed: {s.behavior.simSpeed}× <small>(how fast needs change)</small>
            <input type="range" min={0.25} max={20} step={0.25} value={s.behavior.simSpeed} onChange={(e) => set('behavior', { simSpeed: Number(e.target.value) })} />
          </label>
          <label>
            Autonomous thoughts every {s.behavior.thinkIntervalSec ? `${s.behavior.thinkIntervalSec}s` : '— off'} <small>(uses the AI brain)</small>
            <input type="range" min={0} max={600} step={15} value={s.behavior.thinkIntervalSec} onChange={(e) => set('behavior', { thinkIntervalSec: Number(e.target.value) })} />
          </label>
          <fieldset>
            <legend>Screen peeks (off by default)</legend>
            <label className="check">
              <input type="checkbox" checked={s.behavior.screenPeek.enabled} onChange={(e) => set('behavior', { screenPeek: { ...s.behavior.screenPeek, enabled: e.target.checked } })} /> While
              out on the desktop, Blurb may occasionally look at your screen and comment (private bubble only)
            </label>
            <label>
              Every {s.behavior.screenPeek.intervalMin} minutes
              <input type="range" min={2} max={120} step={1} value={s.behavior.screenPeek.intervalMin} onChange={(e) => set('behavior', { screenPeek: { ...s.behavior.screenPeek, intervalMin: Number(e.target.value) } })} />
            </label>
            <label className="check">
              <input type="checkbox" checked={s.behavior.screenPeek.allowCloud} onChange={(e) => set('behavior', { screenPeek: { ...s.behavior.screenPeek, allowCloud: e.target.checked } })} /> Allow
              peeks with a cloud model (screenshots would leave this computer)
            </label>
          </fieldset>
        </div>
      )}

      {tab === 'live' && (
        <div className="form">
          <p className="hint">
            Publish Blurb’s little world to your relay server so fans can watch at its web address. Only the abstract world state is sent: positions,
            mood, activity, objects, and replies to fans. Status: <strong>{p.relay.status}</strong> · {p.relay.viewers} watching.
          </p>
          <label className="check">
            <input type="checkbox" checked={s.relay.enabled} onChange={(e) => set('relay', { enabled: e.target.checked })} /> Go live
          </label>
          <label>
            Relay WebSocket URL
            <input value={s.relay.url} onChange={(e) => set('relay', { url: e.target.value })} spellCheck={false} placeholder="wss://your-server.example/ws" />
          </label>
          <label>
            Pet id
            <input value={s.relay.petId} onChange={(e) => set('relay', { petId: e.target.value })} spellCheck={false} />
          </label>
          <div className="key-row">
            <label>
              Owner token {p.hasRelayToken && <span className="ok">● saved</span>}
              <input type="password" value={tokenDraft} onChange={(e) => setTokenDraft(e.target.value)} placeholder="Token from ROOM_TOKENS on the server" autoComplete="off" />
            </label>
            <button
              disabled={tokenDraft.trim().length < 8}
              onClick={async () => {
                const r = await api.setSecret('relay', tokenDraft);
                setTokenDraft('');
                if (r.ok) p.onSaved({ ...p.settings, relay: { ...p.settings.relay, tokenRef: 'relay' } }, { hasRelayToken: true });
                setNote(r.ok ? { ok: true, text: 'Token saved.' } : { ok: false, text: r.error ?? 'Could not save token.' });
              }}
            >
              Save token
            </button>
          </div>
          {s.relay.url.startsWith('ws://') && !/localhost|127\.0\.0\.1/.test(s.relay.url) && (
            <p className="warn">This URL is unencrypted (ws://). Use wss:// for anything beyond your own network.</p>
          )}
          <p className="hint">
            Heads-up: like any server you connect to, the relay can see the network address your connection comes from. Blurb never sends it to fans,
            and the relay doesn’t log it — but if that matters to you, host the relay yourself or connect through a VPN.
          </p>
        </div>
      )}

      {tab === 'memory' && (
        <div className="form">
          <p className="hint">Everything Blurb remembers, stored only on this computer. Delete anything you like.</p>
          <ul className="memories">
            {memories.map((m) => (
              <li key={m.id}>
                <span className={`kind ${m.kind}`}>{m.kind.replace('_', ' ')}</span> {m.text}
                <button className="icon-btn" aria-label="Forget" onClick={async () => (await api.memoryDelete(m.id), setMemories(await api.memoryList()))}>
                  ✕
                </button>
              </li>
            ))}
            {!memories.length && <li className="muted">Nothing yet.</li>}
          </ul>
          {memories.length > 0 && (
            <button className="danger" onClick={async () => confirm('Forget everything?') && (await api.memoryClear(), setMemories([]))}>
              Forget everything
            </button>
          )}
        </div>
      )}

      <footer className="panel-foot">
        {note && <span className={note.ok ? 'ok' : 'err'}>{note.text}</span>}
        <span className="grow" />
        {tab !== 'memory' && (
          <button className="primary" onClick={save} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
      </footer>
    </Panel>
  );
}
