/**
 * Local memory store: a small JSON file in the app's data folder.
 *
 * Why JSON and not SQLite: the data is tiny (hundreds of short notes), and
 * avoiding a native module means no electron-rebuild step for users.
 * Retrieval is keyword overlap + recency + weight — no embeddings, no network.
 * The owner can view, delete, or wipe every entry from Settings.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type MemoryKind = 'owner_fact' | 'conversation' | 'fan' | 'event';

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  text: string;
  createdAt: number;
  weight: number;
}

export interface StoredChat {
  role: 'user' | 'assistant';
  content: string;
  at: number;
}

interface FileShape {
  version: 1;
  entries: MemoryEntry[];
  ownerChat: StoredChat[];
}

const STOP = new Set('a an the and or but of to in on at for with is are was were be been it its i you me my your we our they them this that these those do did does have has had not no yes so very just about from as by what when where who how why can could would should will'.split(' '));

export function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

const MAX_ENTRIES = 400;
const MAX_CHAT = 60;

export class MemoryStore {
  private data: FileShape = { version: 1, entries: [], ownerChat: [] };
  private saveTimer?: ReturnType<typeof setTimeout>;

  constructor(private file: string) {}

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<FileShape>;
      this.data = {
        version: 1,
        entries: Array.isArray(raw.entries) ? raw.entries.filter((e) => typeof e?.text === 'string') : [],
        ownerChat: Array.isArray(raw.ownerChat) ? raw.ownerChat : [],
      };
    } catch {
      /* first run */
    }
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 500);
  }

  async flush() {
    clearTimeout(this.saveTimer);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 1), 'utf8');
    await fs.rename(tmp, this.file);
  }

  add(kind: MemoryKind, text: string, weight = 1): MemoryEntry | null {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!clean) return null;
    // de-dupe near-identical notes
    const k = keywords(clean);
    const dup = this.data.entries.find((e) => {
      const ek = keywords(e.text);
      const inter = [...k].filter((w) => ek.has(w)).length;
      return inter / Math.max(1, Math.min(k.size, ek.size)) > 0.85;
    });
    if (dup) {
      dup.weight = Math.min(5, dup.weight + 0.5);
      dup.createdAt = Date.now();
      this.scheduleSave();
      return dup;
    }
    const e: MemoryEntry = { id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, kind, text: clean, createdAt: Date.now(), weight };
    this.data.entries.push(e);
    if (this.data.entries.length > MAX_ENTRIES) {
      this.data.entries.sort((a, b) => b.weight * b.createdAt - a.weight * a.createdAt);
      this.data.entries.length = MAX_ENTRIES;
    }
    this.scheduleSave();
    return e;
  }

  recall(query: string, k = 5, kinds?: MemoryKind[]): MemoryEntry[] {
    const q = keywords(query);
    const now = Date.now();
    return this.data.entries
      .filter((e) => !kinds || kinds.includes(e.kind))
      .map((e) => {
        const ek = keywords(e.text);
        const overlap = [...q].filter((w) => ek.has(w)).length;
        const ageDays = (now - e.createdAt) / 86_400_000;
        const recency = 1 / (1 + ageDays / 7);
        return { e, score: overlap * 2 + recency + e.weight * 0.3 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((x) => x.e);
  }

  list(): MemoryEntry[] {
    return [...this.data.entries].sort((a, b) => b.createdAt - a.createdAt);
  }

  remove(id: string) {
    this.data.entries = this.data.entries.filter((e) => e.id !== id);
    this.scheduleSave();
  }

  clear() {
    this.data = { version: 1, entries: [], ownerChat: [] };
    this.scheduleSave();
  }

  pushOwnerChat(role: 'user' | 'assistant', content: string) {
    this.data.ownerChat.push({ role, content: content.slice(0, 4000), at: Date.now() });
    if (this.data.ownerChat.length > MAX_CHAT) this.data.ownerChat.splice(0, this.data.ownerChat.length - MAX_CHAT);
    this.scheduleSave();
  }

  ownerChat(): StoredChat[] {
    return [...this.data.ownerChat];
  }

  /** Number of owner messages since the last summary marker (for auto-summarize). */
  unsummarizedCount(since: number): number {
    return this.data.ownerChat.filter((m) => m.at > since).length;
  }
}
