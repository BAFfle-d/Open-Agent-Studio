/**
 * Structured tags inside LLM output.
 *
 *   [[emotion:happy]]  -> switches the face/animation
 *   [[action:nap]]     -> asks the engine to do something (validated there)
 *
 * The parser is streaming-safe: tags split across tokens ("[[emo" + "tion:ha"
 * + "ppy]]") are held back until they resolve, so the chat bubble never
 * flashes raw tag text. Single brackets ([happy], [emotion:happy]) are also
 * accepted because small local models drift.
 */
import { EMOTIONS, type Emotion } from './types.js';

export const PET_ACTIONS = [
  'nap',
  'eat',
  'play',
  'read',
  'code',
  'forage',
  'build',
  'check_dropbox',
  'wander',
  'wave',
  'dance',
  'goto',
] as const;
export type PetActionName = (typeof PET_ACTIONS)[number];

export type ParsedTag =
  | { type: 'emotion'; emotion: Emotion }
  | { type: 'action'; action: PetActionName; arg?: string };

const MAX_TAG_LEN = 64;
const TAG_RE = /^\[\[?\s*(emotion|mood|action|feel)?\s*:?\s*([a-z_]+)(?:\s*:\s*([a-z0-9_\-]+))?\s*\]\]?$/i;

export function parseTag(raw: string): ParsedTag | null {
  const m = TAG_RE.exec(raw);
  if (!m) return null;
  const kind = (m[1] ?? '').toLowerCase();
  const name = m[2].toLowerCase();
  const arg = m[3]?.toLowerCase();
  const isEmotion = (EMOTIONS as readonly string[]).includes(name);
  const isAction = (PET_ACTIONS as readonly string[]).includes(name);
  if ((kind === 'emotion' || kind === 'mood' || kind === 'feel' || kind === '') && isEmotion) {
    return { type: 'emotion', emotion: name as Emotion };
  }
  if ((kind === 'action' || kind === '') && isAction) {
    return { type: 'action', action: name as PetActionName, arg };
  }
  return null;
}

export class TagStreamParser {
  private buf = '';
  readonly tags: ParsedTag[] = [];

  /** Feed a chunk; returns visible text that is safe to display now. */
  push(chunk: string): { text: string; tags: ParsedTag[] } {
    this.buf += chunk;
    let out = '';
    const newTags: ParsedTag[] = [];
    while (this.buf.length) {
      const open = this.buf.indexOf('[');
      if (open < 0) {
        out += this.buf;
        this.buf = '';
        break;
      }
      out += this.buf.slice(0, open);
      this.buf = this.buf.slice(open);
      // Find the end of a candidate tag.
      const close = this.findClose(this.buf);
      if (close === -1) {
        // Incomplete: hold back unless it is clearly not a tag.
        if (this.buf.length > MAX_TAG_LEN || this.buf.includes('\n')) {
          out += this.buf[0];
          this.buf = this.buf.slice(1);
          continue;
        }
        break;
      }
      const candidate = this.buf.slice(0, close);
      const tag = parseTag(candidate);
      if (tag) {
        newTags.push(tag);
        this.tags.push(tag);
        this.buf = this.buf.slice(close);
      } else {
        out += this.buf[0];
        this.buf = this.buf.slice(1);
      }
    }
    return { text: out, tags: newTags };
  }

  /** Flush whatever is left (an unterminated "[" is just text). */
  end(): { text: string; tags: ParsedTag[] } {
    const rest = this.buf;
    this.buf = '';
    return { text: rest, tags: [] };
  }

  /** Index just past the closing bracket(s), or -1 if not yet closed. */
  private findClose(s: string): number {
    const double = s.startsWith('[[');
    const idx = s.indexOf(']', double ? 2 : 1);
    if (idx < 0) return -1;
    if (double) {
      if (idx + 1 >= s.length) return -1; // need to see the 2nd "]"
      return s[idx + 1] === ']' ? idx + 2 : idx + 1;
    }
    return idx + 1;
  }
}

/** Non-streaming convenience. */
export function parseTagged(text: string): { text: string; emotion?: Emotion; actions: Extract<ParsedTag, { type: 'action' }>[] } {
  const p = new TagStreamParser();
  const a = p.push(text);
  const b = p.end();
  const emotions = p.tags.filter((t): t is Extract<ParsedTag, { type: 'emotion' }> => t.type === 'emotion');
  return {
    text: (a.text + b.text).replace(/[ \t]{2,}/g, ' ').trim(),
    emotion: emotions.length ? emotions[emotions.length - 1].emotion : undefined,
    actions: p.tags.filter((t): t is Extract<ParsedTag, { type: 'action' }> => t.type === 'action'),
  };
}

/** Remove anything tag-shaped from untrusted text so fans can't inject actions. */
export function stripControlTags(text: string): string {
  return text.replace(/\[\[[^\]]{0,80}\]\]?/g, '').replace(/\[(?:emotion|mood|action|feel)\s*:[^\]]{0,60}\]/gi, '');
}
