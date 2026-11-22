import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ACTIVITY_LABELS,
  EMOTION_EMOJI,
  LIMITS,
  TOYS,
  TREATS,
  type FanAction,
  type Needs,
  type PublicChat,
  type ToyKind,
  type TreatKind,
} from '@blurb/shared';
import { LiveView } from './components/LiveView';
import { FanClient, type Ack, type FanView } from './net';

function relayUrl() {
  const env = import.meta.env.VITE_RELAY_URL as string | undefined;
  if (env) return env;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

function petIdFromUrl() {
  const q = new URLSearchParams(location.search).get('pet');
  const m = /^\/p\/([a-z0-9_-]{1,32})/i.exec(location.pathname);
  return (q ?? m?.[1] ?? 'blurb').toLowerCase();
}

function storedNick() {
  try {
    return localStorage.getItem('blurb.nickname') ?? undefined;
  } catch {
    return undefined;
  }
}

const NEED_META: Array<{ key: keyof Needs; label: string; invert: boolean; color: string }> = [
  { key: 'energy', label: 'Energy', invert: false, color: 'var(--c-energy)' },
  { key: 'fullness', label: 'Tummy', invert: false, color: 'var(--c-food)' },
  { key: 'curiosity', label: 'Curiosity', invert: true, color: 'var(--c-curious)' },
  { key: 'boredom', label: 'Fun', invert: true, color: 'var(--c-fun)' },
  { key: 'social', label: 'Company', invert: true, color: 'var(--c-social)' },
];

export function App() {
  const petId = useMemo(petIdFromUrl, []);
  const client = useMemo(() => new FanClient(relayUrl(), petId, storedNick()), [petId]);
  const [view, setView] = useState<FanView>(client.view);
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [burst, setBurst] = useState<{ kind: 'treat' | 'magic'; n: number }>({ kind: 'treat', n: 0 });
  const [text, setText] = useState('');
  const [nickDraft, setNickDraft] = useState('');
  const [, force] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const off1 = client.on(setView);
    const off2 = client.onAck((a: Ack) => {
      const show = (t: string, tone: 'ok' | 'warn' = 'ok') => {
        setToast({ text: t, tone });
        clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), 3500);
      };
      if (a.status === 'delivered') show('Delivered! 💌');
      else if (a.status === 'queued') show('Sent! Waiting for Blurb’s owner to let it through…');
      else if (a.status === 'approved') show('Your message was approved ✨');
      else if (a.status === 'answered') show('Blurb answered you! 💬');
      else if (a.status === 'rate_limited') {
        setCooldownUntil(Date.now() + (a.retryAfterMs ?? 5000));
        show(a.reason ?? 'Slow down a little!', 'warn');
      } else if (a.status === 'rejected') show(a.reason ?? 'That didn’t go through.', 'warn');
    });
    client.start();
    const tick = setInterval(() => force((n) => n + 1), 1000);
    return () => {
      off1();
      off2();
      client.stop();
      clearInterval(tick);
    };
  }, [client]);

  const s = view.state;
  const pet = s?.pet;
  const cooling = cooldownUntil > Date.now();
  const canAct = view.connected && view.petOnline && view.fanMode !== 'view_only' && !cooling;
  const canChat = canAct && view.fanMode === 'fan_chat';

  const act = (a: FanAction) => {
    if (!canAct) return;
    client.send(a);
    if (a.type !== 'chat') setBurst((b) => ({ kind: 'treat', n: b.n + 1 }));
  };

  const modeText =
    !view.petOnline ? 'Blurb is offline right now — the world is paused.' :
    view.fanMode === 'view_only' ? 'View-only right now. Just enjoy the show!' :
    view.fanMode === 'treats_only' ? 'Treats & toys are open. Chat is paused.' :
    'Treats, toys and chat are open!';

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden>◕‿◕</span>
          <h1>{pet?.name ?? 'Blurb'} <span className="live">LIVE</span></h1>
        </div>
        <div className="meta">
          <span className={`dot ${view.connected && view.petOnline ? 'on' : 'off'}`} />
          {view.connected ? (view.petOnline ? 'Online' : 'Offline') : 'Connecting…'}
          <span className="sep">·</span>👀 {view.viewers}
        </div>
      </header>

      <main className="layout">
        <section className="stage card">
          <div className="canvas-wrap">
            <LiveView subscribe={(fn) => client.onState(fn)} initial={s} burst={burst} />
            {!s && <div className="placeholder">{view.error ?? 'Waiting for the first frame…'}</div>}
          </div>
          {pet && (
            <div className="status-row">
              <span className="mood" title={pet.emotion}>{EMOTION_EMOJI[pet.emotion]}</span>
              <span>
                <strong>{pet.name}</strong> is {ACTIVITY_LABELS[pet.activity] ?? pet.activity.replaceAll('_', ' ')}
                {pet.where === 'out' && ' (out on the desktop)'}
              </span>
            </div>
          )}
        </section>

        <aside className="side">
          {pet && (
            <section className="card">
              <h2>How {pet.name} is doing</h2>
              <div className="needs">
                {NEED_META.map((n) => {
                  const raw = pet.needs[n.key];
                  const v = n.invert ? 100 - raw : raw;
                  return (
                    <div className="need" key={n.key}>
                      <span>{n.label}</span>
                      <div className="bar" role="meter" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100} aria-label={n.label}>
                        <div style={{ width: `${v}%`, background: n.color }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <section className="card">
            <h2>Say hi</h2>
            <p className={`mode ${view.fanMode}`}>{modeText}</p>
            <div className="btn-grid">
              {(Object.keys(TREATS) as TreatKind[]).map((t) => (
                <button key={t} disabled={!canAct} onClick={() => act({ type: 'treat', treat: t })}>
                  <span className="emoji">{TREATS[t].emoji}</span>
                  {TREATS[t].label}
                </button>
              ))}
              {(Object.keys(TOYS) as ToyKind[]).map((t) => (
                <button key={t} disabled={!canAct} onClick={() => act({ type: 'toy', toy: t })}>
                  <span className="emoji">{TOYS[t].emoji}</span>
                  {TOYS[t].label}
                </button>
              ))}
            </div>
            <form
              className="chat-form"
              onSubmit={(e) => {
                e.preventDefault();
                const t = text.trim();
                if (!t || !canChat) return;
                client.send({ type: 'chat', text: t });
                setText('');
              }}
            >
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={LIMITS.fanChatMaxLen}
                placeholder={canChat ? `Message ${pet?.name ?? 'Blurb'}…` : 'Chat is closed'}
                disabled={!canChat}
                aria-label="Chat message"
              />
              <button type="submit" disabled={!canChat || !text.trim()}>Send</button>
            </form>
            {cooling && <p className="hint">Cooling down… {Math.ceil((cooldownUntil - Date.now()) / 1000)}s</p>}
            <details className="nick">
              <summary>You are <strong>{view.nickname || '…'}</strong> — change</summary>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (nickDraft.trim()) client.setNickname(nickDraft.trim());
                  setNickDraft('');
                }}
              >
                <input value={nickDraft} onChange={(e) => setNickDraft(e.target.value)} maxLength={LIMITS.nicknameMaxLen} placeholder="New nickname" aria-label="Nickname" />
                <button type="submit">Save</button>
              </form>
            </details>
          </section>

          <section className="card chat-card">
            <h2>Chat</h2>
            <ChatLog chat={view.chat} />
          </section>
        </aside>
      </main>
      {toast && <div className={`toast ${toast.tone}`} role="status">{toast.text}</div>}
      <footer className="foot">Visitors only ever see Blurb’s little world. Nothing from the owner’s computer is shared.</footer>
    </div>
  );
}

function ChatLog({ chat }: { chat: PublicChat[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' });
  }, [chat.length]);
  if (!chat.length) return <p className="hint">No messages yet. Be the first to say hi!</p>;
  return (
    <div className="chat-log" ref={ref}>
      {chat.map((m) => (
        <div key={m.id} className={`msg ${m.role}`}>
          <span className="who">{m.role === 'pet' ? `${m.author} ${m.emotion ? EMOTION_EMOJI[m.emotion] : ''}` : m.author}</span>
          <span className="text">{m.text}</span>
        </div>
      ))}
    </div>
  );
}
