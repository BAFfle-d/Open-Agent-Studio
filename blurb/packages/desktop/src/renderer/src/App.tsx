import { useEffect, useRef, useState } from 'react';
import { ACTIVITY_LABELS, EMOTION_EMOJI, type ChatMessage, type FanMode, type PublicState } from '@blurb/shared';
import type { ModerationItem } from '@blurb/host';
import { api } from './api';
import type { DesktopEvent, InitData, WorldInfo } from '../../ipc-types';
import { ChatDrawer, type LogLine } from './components/ChatDrawer';
import { CommBoxPanel, DropBoxPanel, FansPanel } from './components/Panels';
import { Palette } from './components/Palette';
import { SettingsPanel } from './components/Settings';
import { WorldView } from './components/WorldView';

type PanelId = 'dropbox' | 'comm' | 'fans' | 'settings' | null;

const FAN_MODES: Array<[FanMode, string, string]> = [
  ['fan_chat', 'Fan chat', 'Treats, toys and moderated chat'],
  ['treats_only', 'Treats only', 'Treats and toys, no chat'],
  ['view_only', 'View only', 'Fans can only watch'],
];

export function App() {
  const [init, setInit] = useState<InitData | null>(null);
  const [world, setWorld] = useState<WorldInfo | null>(null);
  const [chat, setChat] = useState<Array<ChatMessage | LogLine>>([]);
  const [moderation, setModeration] = useState<ModerationItem[]>([]);
  const [relay, setRelay] = useState({ status: 'off', viewers: 0 });
  const [brain, setBrain] = useState<{ status: string; message?: string }>({ status: 'idle' });
  const [llama, setLlama] = useState<{ status: string; message?: string }>({ status: 'stopped' });
  const [download, setDownload] = useState<Extract<DesktopEvent, { type: 'download' }>>();
  const [pet, setPet] = useState<PublicState['pet'] | null>(null);
  const [panel, setPanel] = useState<PanelId>(null);
  const [chatOpen, setChatOpen] = useState(true);
  const [fanFeed, setFanFeed] = useState<string[]>([]);
  const burst = useRef<(k: 'treat' | 'build' | 'pet' | 'magic', x?: number, y?: number) => void>(() => {});

  useEffect(() => {
    void api.init().then((d) => {
      setInit(d);
      setWorld(d.world);
      setChat(d.ownerLog);
      setModeration(d.moderation);
      setRelay(d.relay);
      setBrain(d.brain);
    });
    let lastPet = 0;
    const offState = api.onState((s) => {
      // status bar doesn't need 30 fps
      if (performance.now() - lastPet > 400) {
        lastPet = performance.now();
        setPet(s.pet);
      }
    });
    const offEvent = api.onEvent((e) => {
      switch (e.type) {
        case 'chat':
          setChat((prev) => {
            const i = prev.findIndex((m) => m.id === e.message.id);
            if (i < 0) return [...prev, e.message].slice(-200);
            const next = [...prev];
            next[i] = e.message;
            return next;
          });
          break;
        case 'world':
          setWorld(e.world);
          break;
        case 'moderation':
          setModeration([...e.items]);
          break;
        case 'relay':
          setRelay({ status: e.status, viewers: e.viewers });
          break;
        case 'brain':
          setBrain({ status: e.status, message: e.message });
          break;
        case 'llama':
          setLlama({ status: e.status, message: e.message });
          break;
        case 'download':
          setDownload(e);
          break;
        case 'fan':
          setFanFeed((f) => [e.text, ...f].slice(0, 20));
          break;
        case 'sim': {
          const ev = e.event;
          if (ev.type === 'burst') burst.current(ev.kind, ev.x, ev.y);
          if (ev.type === 'program') {
            const parts = [
              ...ev.summary.filter(Boolean).map((s) => `✅ ${s}`),
              ...ev.rejected.map((r) => `⛔ refused: ${r.reason}`),
            ];
            if (parts.length)
              setChat((prev) => [...prev, { id: `prog-${Date.now()}`, kind: 'system' as const, text: `🖥️ Blurb ran a program — ${parts.join(' · ')}`, createdAt: Date.now() }].slice(-200));
          }
          if (ev.type === 'note' && ev.note.request)
            setChat((prev) => [...prev, { id: `note-${ev.note.id}`, kind: 'system' as const, text: `✉️ Blurb left an approval request in the comm box: “${ev.note.request!.design.name}”`, createdAt: Date.now() }]);
          break;
        }
      }
    });
    return () => {
      offState();
      offEvent();
    };
  }, []);

  if (!init || !world) return <div className="loading">Waking Blurb up…</div>;

  const settings = init.settings;
  const unreadNotes = world.notes.filter((n) => !n.read).length;
  const pendingFans = moderation.filter((m) => m.status === 'pending').length;
  const name = settings.personality.name;

  const setFanMode = (mode: FanMode) => {
    void api.setFanMode(mode);
    setInit({ ...init, settings: { ...settings, fans: { ...settings.fans, mode } } });
  };

  const saveFanSettings = async (patch: Partial<typeof settings.fans>) => {
    const saved = await api.saveSettings({ ...settings, fans: { ...settings.fans, ...patch } });
    setInit({ ...init, settings: saved });
  };

  return (
    <div className={`app ${chatOpen ? 'chat-open' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>◕‿◕</span>
          <strong>{name}</strong>
          {pet && (
            <span className="mood" title={pet.emotion}>
              {EMOTION_EMOJI[pet.emotion]} {ACTIVITY_LABELS[pet.activity] ?? pet.activity}
            </span>
          )}
        </div>
        <div className="top-actions">
          <div className="segmented" role="radiogroup" aria-label="Fan interaction mode">
            {FAN_MODES.map(([id, label, title]) => (
              <button key={id} role="radio" aria-checked={settings.fans.mode === id} className={settings.fans.mode === id ? 'active' : ''} title={title} onClick={() => setFanMode(id)}>
                {label}
              </button>
            ))}
          </div>
          <span className={`pill relay-${relay.status}`} title="Public live page">
            🌐 {relay.status === 'online' ? `Live · ${relay.viewers}` : relay.status === 'off' ? 'Offline' : relay.status}
          </span>
          <button className="icon-btn" title="Drop box" onClick={() => setPanel('dropbox')}>
            📦{world.dropBox.items.length > 0 && <span className="badge">{world.dropBox.items.length}</span>}
          </button>
          <button className="icon-btn" title="Comm box" onClick={() => (setPanel('comm'), void api.markNotesRead())}>
            ✉️{unreadNotes > 0 && <span className="badge">{unreadNotes}</span>}
          </button>
          <button className="icon-btn" title="Fans & moderation" onClick={() => setPanel('fans')}>
            🛡️{pendingFans > 0 && <span className="badge">{pendingFans}</span>}
          </button>
          <button className="icon-btn" title="Let Blurb out on the desktop (minimize)" onClick={() => void api.goOut()}>
            🖥️
          </button>
          <button className="icon-btn" title="Settings" onClick={() => setPanel('settings')}>
            ⚙️
          </button>
        </div>
      </header>

      <main className="stage">
        <WorldView onBurstRef={(fn) => (burst.current = fn)} />
        {pet && (
          <div className="statusbar">
            {(['energy', 'fullness', 'boredom', 'social', 'curiosity'] as const).map((k) => {
              const inv = k === 'boredom' || k === 'social' || k === 'curiosity';
              const v = inv ? 100 - pet.needs[k] : pet.needs[k];
              const lbl = { energy: 'Energy', fullness: 'Tummy', boredom: 'Fun', social: 'Company', curiosity: 'Curiosity' }[k];
              return (
                <div className="mini-need" key={k} title={`${lbl}: ${Math.round(v)}%`}>
                  <span>{lbl}</span>
                  <div className={`mini-bar ${k}`}>
                    <div style={{ width: `${v}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <Palette />
      </main>

      <ChatDrawer
        open={chatOpen}
        onToggle={() => setChatOpen((o) => !o)}
        messages={chat}
        petName={name}
        brain={brain}
        visionOk={settings.llm.vision && settings.llm.provider !== 'rules' && settings.capabilities.screen_questions}
      />

      {panel === 'dropbox' && <DropBoxPanel world={world} onClose={() => setPanel(null)} />}
      {panel === 'comm' && <CommBoxPanel world={world} onClose={() => setPanel(null)} />}
      {panel === 'fans' && (
        <FansPanel
          items={moderation}
          mode={settings.fans.mode}
          autoApprove={settings.fans.autoApproveChat}
          shareOwnerChat={settings.fans.shareOwnerChat}
          relay={relay}
          fanFeed={fanFeed}
          onSettings={(patch) => void saveFanSettings(patch)}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === 'settings' && (
        <SettingsPanel
          settings={settings}
          presets={init.presets}
          hasApiKey={init.hasApiKey}
          hasRelayToken={init.hasRelayToken}
          secureStorage={init.secureStorage}
          llamaServer={init.llamaServer}
          llama={llama}
          download={download}
          relay={relay}
          onSaved={(s, keys) => setInit({ ...init, settings: s, ...keys })}
          onClose={() => setPanel(null)}
        />
      )}
    </div>
  );
}
