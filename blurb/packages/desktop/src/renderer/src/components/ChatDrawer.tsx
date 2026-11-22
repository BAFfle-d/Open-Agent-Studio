import { useEffect, useRef, useState } from 'react';
import { EMOTION_EMOJI, type ChatMessage } from '@blurb/shared';
import { api } from '../api';

export interface LogLine {
  id: string;
  kind: 'system';
  text: string;
  createdAt: number;
}

interface Props {
  open: boolean;
  onToggle: () => void;
  messages: Array<ChatMessage | LogLine>;
  petName: string;
  brain: { status: string; message?: string };
  visionOk: boolean;
}

export function ChatDrawer({ open, onToggle, messages, petName, brain, visionOk }: Props) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    void api.chat(t);
    setText('');
  };

  return (
    <aside className={`chat-drawer ${open ? 'open' : ''}`} aria-label="Chat with Blurb">
      <button className="drawer-tab" onClick={onToggle} aria-expanded={open} title={open ? 'Hide chat' : 'Chat with Blurb'}>
        {open ? '›' : '💬'}
      </button>
      {open && (
        <div className="drawer-body">
          <header className="drawer-head">
            <strong>Chat with {petName}</strong>
            <span className={`brain-pill ${brain.status}`} title={brain.message}>
              {brain.status === 'thinking' ? 'thinking…' : brain.status === 'error' ? 'brain error' : brain.message || 'ready'}
            </span>
          </header>
          {brain.status === 'error' && brain.message && <p className="brain-error">{brain.message}</p>}
          <div className="messages" ref={listRef}>
            {messages.length === 0 && <p className="muted">Say hi! Your chats with {petName} stay on this computer.</p>}
            {messages.map((m) =>
              'kind' in m ? (
                <div key={m.id} className="msg system">{m.text}</div>
              ) : (
                <div key={m.id} className={`msg ${m.role}`}>
                  {m.role === 'pet' && <span className="who">{petName} {m.emotion ? EMOTION_EMOJI[m.emotion] : ''}</span>}
                  <span className="text">{m.text || '…'}</span>
                  {m.visibility === 'public' && m.role === 'pet' && <span className="pub" title="Shown on your public page">🌐</span>}
                </div>
              ),
            )}
          </div>
          <div className="composer">
            <textarea
              ref={inputRef}
              rows={2}
              value={text}
              placeholder={`Message ${petName}…`}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              aria-label="Message"
            />
            <div className="composer-actions">
              <button
                className="ghost"
                disabled={!visionOk}
                title={visionOk ? 'Send a screenshot with your question. It goes only to your AI provider — never to the public page.' : 'Needs a vision-capable model (Settings → Brain → vision)'}
                onClick={() => {
                  void api.askScreen(text.trim());
                  setText('');
                }}
              >
                📷 About my screen
              </button>
              <button className="primary" onClick={send} disabled={!text.trim()}>
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
