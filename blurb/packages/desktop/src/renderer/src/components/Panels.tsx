import type { ReactNode } from 'react';
import { OBJECT_DEFS, RESOURCE_KINDS, type FanMode, type ObjectKind } from '@blurb/shared';
import type { ModerationItem } from '@blurb/host';
import { api } from '../api';
import type { WorldInfo } from '../../../ipc-types';
import { BlobThumb, ObjectThumb } from './Thumbs';

export function Panel({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="panel-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className={`panel ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <header className="panel-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="panel-body">{children}</div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function DropBoxPanel({ world, onClose }: { world: WorldInfo; onClose: () => void }) {
  const { dropBox, appearance, inventory } = world;
  const giftables: ObjectKind[] = ['ball', 'yarn', 'plushie', 'flowers', 'bush', 'plant_pot', 'lamp', 'bed', 'bookshelf', 'workbench'];
  return (
    <Panel title="📦 Drop box" onClose={onClose} wide>
      <p className="muted">
        Skins and approved shapes live here — Blurb can wear any of them at will. Items you drop in wait until Blurb comes to collect them.
      </p>
      <h3>Skins</h3>
      <div className="tile-grid">
        {dropBox.skins.map((s) => (
          <button key={s.id} className={`tile ${appearance.skinId === s.id ? 'active' : ''}`} onClick={() => void api.setSkin(s.id)} title={`Wear ${s.name}`}>
            <BlobThumb palette={s.palette} shape={world.look.shape} size={80} />
            <span>{s.name}</span>
            {s.origin === 'pet' && <small>made by Blurb</small>}
          </button>
        ))}
      </div>
      <h3>Shapes</h3>
      <div className="tile-grid">
        {dropBox.shapes.map((s) => (
          <button key={s.id} className={`tile ${appearance.shapeId === s.id ? 'active' : ''}`} onClick={() => void api.setShape(s.id)} title={`Wear ${s.name}`}>
            <BlobThumb palette={world.look.palette} shape={s.spec} size={80} />
            <span>{s.name}</span>
            {s.origin === 'pet' && <small>designed by Blurb</small>}
          </button>
        ))}
      </div>
      <h3>Waiting to be collected</h3>
      {dropBox.items.length ? (
        <ul className="chips">
          {dropBox.items.map((i) => (
            <li key={i.id} className="chip">
              {i.count}× {i.resource ?? (i.objectKind ? OBJECT_DEFS[i.objectKind].label : 'treat')} <small>from {i.fromName ?? i.from}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Empty.</p>
      )}
      <h3>Put something in</h3>
      <div className="give-row">
        <button onClick={() => void api.dropToBox({ kind: 'treat', count: 1 })}>🍪 Treat</button>
        {RESOURCE_KINDS.map((r) => (
          <button key={r} onClick={() => void api.dropToBox({ kind: 'resource', resource: r, count: 3 })} title={`3 × ${r}`}>
            <ObjectThumb kind={`resource:${r}`} size={22} /> 3 {r}
          </button>
        ))}
      </div>
      <div className="give-row">
        {giftables.map((k) => (
          <button key={k} onClick={() => void api.dropToBox({ kind: 'object', objectKind: k, count: 1 })} title={OBJECT_DEFS[k].label}>
            <ObjectThumb kind={k} size={22} /> {OBJECT_DEFS[k].label}
          </button>
        ))}
      </div>
      <h3>Blurb’s bag</h3>
      <ul className="chips">
        {Object.entries(inventory.resources)
          .filter(([, n]) => (n ?? 0) > 0)
          .map(([k, n]) => (
            <li key={k} className="chip">
              <ObjectThumb kind={`resource:${k}` as `resource:stick`} size={18} /> {n} {k}
            </li>
          ))}
        {!Object.values(inventory.resources).some((n) => (n ?? 0) > 0) && <li className="muted">Empty — Blurb forages trees and bushes for more.</li>}
      </ul>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

export function CommBoxPanel({ world, onClose }: { world: WorldInfo; onClose: () => void }) {
  const notes = world.notes;
  return (
    <Panel title="✉️ Comm box" onClose={onClose}>
      {world.outbox > 0 && <p className="muted">Blurb is on the way with {world.outbox} more note{world.outbox > 1 ? 's' : ''}…</p>}
      {!notes.length && <p className="muted">No notes yet. When Blurb designs something at the computer, its approval request shows up here.</p>}
      <div className="notes">
        {notes.map((n) => (
          <article key={n.id} className={`note ${n.read ? '' : 'unread'}`}>
            <time>{new Date(n.createdAt).toLocaleString()}</time>
            <p>{n.text}</p>
            {n.request && (
              <div className="approval">
                <BlobThumb palette={world.look.palette} shape={world.look.shape} size={64} />
                <span className="arrow" aria-label="becomes">→</span>
                <BlobThumb palette={world.look.palette} shape={n.request.design.spec} size={96} pose={{ arm: 'wave1' }} />
                <div className="approval-actions">
                  <strong>{n.request.design.name}</strong>
                  {n.request.status === 'pending' ? (
                    <div className="row">
                      <button className="primary" onClick={() => void api.decideShape(n.id, true)}>Approve</button>
                      <button onClick={() => void api.decideShape(n.id, false)}>Decline</button>
                    </div>
                  ) : (
                    <span className={`status ${n.request.status}`}>{n.request.status}</span>
                  )}
                </div>
              </div>
            )}
          </article>
        ))}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

export function FansPanel({
  items,
  mode,
  autoApprove,
  shareOwnerChat,
  relay,
  fanFeed,
  onSettings,
  onClose,
}: {
  items: ModerationItem[];
  mode: FanMode;
  autoApprove: boolean;
  shareOwnerChat: boolean;
  relay: { status: string; viewers: number };
  fanFeed: string[];
  onSettings: (patch: { autoApproveChat?: boolean; shareOwnerChat?: boolean }) => void;
  onClose: () => void;
}) {
  const pending = items.filter((i) => i.status === 'pending');
  return (
    <Panel title="🛡️ Fans & moderation" onClose={onClose}>
      <p className="muted">
        Live page: <strong>{relay.status}</strong> · {relay.viewers} watching. Fans only ever receive Blurb’s little world — never your screen, windows, or IP.
      </p>
      <div className="toggles">
        <label>
          <input type="checkbox" checked={autoApprove} onChange={(e) => onSettings({ autoApproveChat: e.target.checked })} /> Auto-approve fan chat
          (it still passes the profanity & injection filters)
        </label>
        <label>
          <input type="checkbox" checked={shareOwnerChat} onChange={(e) => onSettings({ shareOwnerChat: e.target.checked })} /> Show Blurb’s replies to me on the
          public page (screen questions are always private)
        </label>
      </div>
      <h3>Waiting for you ({pending.length})</h3>
      {mode !== 'fan_chat' && <p className="muted">Fan chat is closed in the current mode.</p>}
      {!pending.length && <p className="muted">Nothing to review.</p>}
      <ul className="mod-list">
        {pending.map((i) => (
          <li key={i.event.id}>
            <div>
              <strong>{i.event.nickname}</strong>
              <p>{i.event.action.type === 'chat' ? i.event.action.text : ''}</p>
            </div>
            <div className="row">
              <button className="primary" onClick={() => void api.moderate(i.event.id, true)}>Let through</button>
              <button onClick={() => void api.moderate(i.event.id, false)}>Reject</button>
            </div>
          </li>
        ))}
      </ul>
      <h3>Recent</h3>
      <ul className="feed">
        {items
          .filter((i) => i.status !== 'pending')
          .slice(0, 8)
          .map((i) => (
            <li key={i.event.id}>
              <span className={`status ${i.status}`}>{i.status}</span> {i.event.nickname}: {i.event.action.type === 'chat' ? i.event.action.text : ''}
            </li>
          ))}
        {fanFeed.slice(0, 8).map((t, n) => (
          <li key={`f${n}`}>🎁 {t}</li>
        ))}
      </ul>
    </Panel>
  );
}
