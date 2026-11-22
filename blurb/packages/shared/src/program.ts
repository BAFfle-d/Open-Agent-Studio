/**
 * BlurbScript — the only "code" Blurb can write.
 *
 * When Blurb sits at its computer, the LLM is asked for a short JSON program.
 * That program is DATA, not code: it is parsed, every instruction is checked
 * against a fixed whitelist + the owner's capability toggles, and only then
 * applied by the engine. There is no eval, no new instruction can be invented,
 * and an instruction that would add an ability (flying, new object kinds,
 * file access…) simply does not exist in this grammar.
 *
 * This is the guarantee behind "Blurb can tinker but can't give itself new
 * powers": it isn't a prompt rule the model could talk itself out of, it's
 * a closed instruction set.
 */
import { OBJECT_DEFS, WORLD } from './catalog.js';
import { clampShape, normalizeColor } from './palettes.js';
import type {
  CapabilitySet,
  DropBox,
  Inventory,
  ObjectKind,
  ResourceKind,
  ShapeSpec,
  WorldObject,
} from './types.js';
import { OBJECT_KINDS } from './types.js';

export type ProgramOp =
  | { op: 'recolor'; target: string; color: string }
  | { op: 'transform'; target: string; into: ObjectKind }
  | { op: 'move'; target: string; x: number }
  | { op: 'build'; kind: ObjectKind; x: number; color?: string }
  | { op: 'set_skin'; skin: string }
  | { op: 'set_shape'; shape: string }
  | { op: 'design_shape'; name: string; spec: ShapeSpec }
  | { op: 'note'; text: string };

export const PROGRAM_OPS = [
  'recolor',
  'transform',
  'move',
  'build',
  'set_skin',
  'set_shape',
  'design_shape',
  'note',
] as const;

export const MAX_PROGRAM_OPS = 6;

export interface ProgramContext {
  objects: WorldObject[];
  dropBox: DropBox;
  capabilities: CapabilitySet;
  inventory: Inventory;
}

export interface RejectedOp {
  raw: unknown;
  reason: string;
}

export interface ValidatedProgram {
  ops: ProgramOp[];
  rejected: RejectedOp[];
}

/** Human-readable reference given to the LLM. Keep in sync with validateOp. */
export function describeProgramLanguage(ctx: ProgramContext): string {
  const allowed: string[] = [];
  const c = ctx.capabilities;
  if (c.recolor_self || c.recolor_objects)
    allowed.push(`{"op":"recolor","target":"<objectId${c.recolor_self ? ' or self' : ''}>","color":"#rrggbb"}`);
  if (c.transform_objects)
    allowed.push(`{"op":"transform","target":"<objectId>","into":"<kind in same family: tree|bush|flowers or ball|yarn|plushie>"}`);
  if (c.rearrange) allowed.push(`{"op":"move","target":"<objectId>","x":<0-${WORLD.width}>}`);
  if (c.build_copies) allowed.push(`{"op":"build","kind":"<kind that already exists>","x":<number>} (costs resources)`);
  if (c.change_skin) allowed.push(`{"op":"set_skin","skin":"<skin id from drop box>"}`);
  if (c.change_shape) allowed.push(`{"op":"set_shape","shape":"<approved shape id from drop box>"}`);
  if (c.design_shapes)
    allowed.push(
      `{"op":"design_shape","name":"<name>","spec":{"width":18-40,"height":14-32,"peak":"round|pointy|flat","lean":-0.6..0.6,"feet":0-4,"ears":"none|nubs|tufts","gloss":true|false}} (owner must approve)`,
    );
  allowed.push(`{"op":"note","text":"<short note for your owner>"}`);
  return allowed.join('\n');
}

/** Pull the first JSON array out of free-form LLM text. */
export function extractProgramJson(text: string): unknown[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = fenced ? [fenced[1], text] : [text];
  for (const cand of candidates) {
    const start = cand.indexOf('[');
    if (start < 0) continue;
    // Walk to the matching bracket (strings respected) to avoid greedy regex.
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < cand.length; i++) {
      const ch = cand[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(cand.slice(start, i + 1));
            return Array.isArray(parsed) ? parsed : null;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function findObject(ctx: ProgramContext, id: unknown): WorldObject | undefined {
  return typeof id === 'string' ? ctx.objects.find((o) => o.id === id) : undefined;
}

function sanitizeNote(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
}

export function canAfford(inv: Inventory, recipe: Partial<Record<ResourceKind, number>>): boolean {
  return Object.entries(recipe).every(([k, n]) => (inv.resources[k as ResourceKind] ?? 0) >= (n ?? 0));
}

/**
 * Validate one raw instruction. `pending` tracks state changes made by earlier
 * ops in the same program (resources spent, objects added) so a program can't
 * double-spend.
 */
export function validateOp(
  raw: unknown,
  ctx: ProgramContext,
  pending: { spent: Partial<Record<ResourceKind, number>>; added: number },
): ProgramOp | RejectedOp {
  const reject = (reason: string): RejectedOp => ({ raw, reason });
  if (!isObj(raw)) return reject('not an instruction object');
  const op = raw.op;
  if (typeof op !== 'string' || !(PROGRAM_OPS as readonly string[]).includes(op)) {
    return reject(`unknown instruction "${String(op)}" — I can only use the instructions I was given`);
  }
  const caps = ctx.capabilities;

  switch (op) {
    case 'recolor': {
      const color = normalizeColor(raw.color);
      if (!color) return reject('not a color');
      if (raw.target === 'self') {
        if (!caps.recolor_self) return reject('recoloring myself is turned off');
        return { op, target: 'self', color };
      }
      if (!caps.recolor_objects) return reject('recoloring things is turned off');
      const o = findObject(ctx, raw.target);
      if (!o) return reject('no such object');
      return { op, target: o.id, color };
    }
    case 'transform': {
      if (!caps.transform_objects) return reject('transforming things is turned off');
      const o = findObject(ctx, raw.target);
      if (!o) return reject('no such object');
      const into = raw.into;
      if (typeof into !== 'string' || !(OBJECT_KINDS as readonly string[]).includes(into))
        return reject('not a kind of thing that exists');
      const from = OBJECT_DEFS[o.kind];
      const to = OBJECT_DEFS[into as ObjectKind];
      if (!from.family || from.family !== to.family)
        return reject(`a ${from.label.toLowerCase()} can't become a ${to.label.toLowerCase()} (different family)`);
      if (!to.zones.includes(o.zone)) return reject(`a ${to.label.toLowerCase()} doesn't belong in the ${o.zone}`);
      return { op, target: o.id, into: into as ObjectKind };
    }
    case 'move': {
      if (!caps.rearrange) return reject('rearranging is turned off');
      const o = findObject(ctx, raw.target);
      if (!o) return reject('no such object');
      if (typeof raw.x !== 'number' || !Number.isFinite(raw.x)) return reject('x must be a number');
      const def = OBJECT_DEFS[o.kind];
      const x = Math.round(Math.min(WORLD.width - def.width, Math.max(0, raw.x)));
      const zone = x + def.width / 2 < WORLD.doorX ? 'house' : 'yard';
      if (!def.zones.includes(zone)) return reject(`a ${def.label.toLowerCase()} has to stay in the ${def.zones.join('/')}`);
      return { op, target: o.id, x };
    }
    case 'build': {
      if (!caps.build_copies) return reject('building is turned off');
      const kind = raw.kind;
      if (typeof kind !== 'string' || !(OBJECT_KINDS as readonly string[]).includes(kind))
        return reject('not a kind of thing that exists');
      const def = OBJECT_DEFS[kind as ObjectKind];
      if (!def.recipe || def.unique) return reject(`a ${def.label.toLowerCase()} can't be built`);
      if (!ctx.objects.some((o) => o.kind === kind))
        return reject(`I can only build copies of things that already exist`);
      if (ctx.objects.length + pending.added >= WORLD.maxObjects) return reject('the world is full');
      const remaining: Inventory = {
        resources: Object.fromEntries(
          Object.entries(ctx.inventory.resources).map(([k, n]) => [k, (n ?? 0) - (pending.spent[k as ResourceKind] ?? 0)]),
        ),
      };
      if (!canAfford(remaining, def.recipe)) {
        const need = Object.entries(def.recipe)
          .map(([k, n]) => `${n} ${k}`)
          .join(', ');
        return reject(`not enough resources (need ${need})`);
      }
      for (const [k, n] of Object.entries(def.recipe)) {
        pending.spent[k as ResourceKind] = (pending.spent[k as ResourceKind] ?? 0) + (n ?? 0);
      }
      pending.added++;
      const rawX = typeof raw.x === 'number' && Number.isFinite(raw.x) ? raw.x : WORLD.doorX + 40;
      let x = Math.round(Math.min(WORLD.width - def.width, Math.max(0, rawX)));
      // Snap into an allowed zone.
      const zone = x + def.width / 2 < WORLD.doorX ? 'house' : 'yard';
      if (!def.zones.includes(zone)) x = def.zones[0] === 'house' ? WORLD.doorX - def.width - 8 : WORLD.doorX + 12;
      const color = raw.color !== undefined ? normalizeColor(raw.color) ?? undefined : undefined;
      return { op, kind: kind as ObjectKind, x, color };
    }
    case 'set_skin': {
      if (!caps.change_skin) return reject('changing skins is turned off');
      if (typeof raw.skin !== 'string' || !ctx.dropBox.skins.some((s) => s.id === raw.skin))
        return reject('that skin is not in my drop box');
      return { op, skin: raw.skin };
    }
    case 'set_shape': {
      if (!caps.change_shape) return reject('changing shape is turned off');
      if (typeof raw.shape !== 'string' || !ctx.dropBox.shapes.some((s) => s.id === raw.shape))
        return reject('that shape is not approved yet');
      return { op, shape: raw.shape };
    }
    case 'design_shape': {
      if (!caps.design_shapes) return reject('designing shapes is turned off');
      if (!isObj(raw.spec)) return reject('a shape needs a spec');
      const name = typeof raw.name === 'string' ? sanitizeNote(raw.name).slice(0, 32) : '';
      return { op, name: name || 'Mystery Blob', spec: clampShape(raw.spec as Partial<ShapeSpec>) };
    }
    case 'note': {
      if (typeof raw.text !== 'string' || !raw.text.trim()) return reject('empty note');
      return { op, text: sanitizeNote(raw.text) };
    }
  }
  return reject('unknown instruction');
}

export function validateProgram(raw: unknown, ctx: ProgramContext): ValidatedProgram {
  const out: ValidatedProgram = { ops: [], rejected: [] };
  if (!Array.isArray(raw)) {
    out.rejected.push({ raw, reason: 'a program must be a list of instructions' });
    return out;
  }
  const pending = { spent: {} as Partial<Record<ResourceKind, number>>, added: 0 };
  raw.slice(0, MAX_PROGRAM_OPS).forEach((r) => {
    const v = validateOp(r, ctx, pending);
    if ('reason' in v) out.rejected.push(v);
    else out.ops.push(v);
  });
  for (const extra of raw.slice(MAX_PROGRAM_OPS)) out.rejected.push({ raw: extra, reason: 'program too long' });
  return out;
}
