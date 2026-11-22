/**
 * The rule brain: utility scoring for "what should I do next", emotion from
 * needs, a phrase bank for chatter when no LLM is configured, and a
 * rule-based BlurbScript generator for computer sessions without an LLM.
 *
 * The LLM (when present) layers on top of this; it never replaces the
 * physics or the safety checks.
 */
import {
  BUILTIN_SKINS,
  OBJECT_DEFS,
  WORLD,
  canAfford,
  type CapabilitySet,
  type DropBox,
  type Emotion,
  type Inventory,
  type Needs,
  type ObjectKind,
  type PetState,
  type WorldObject,
} from '@blurb/shared';

export interface BrainContext {
  pet: PetState;
  objects: WorldObject[];
  dropBox: DropBox;
  capabilities: CapabilitySet;
  hasOutbox: boolean;
  hour: number;
  /** seconds since the last computer session */
  sinceCoding: number;
  rng: () => number;
}

export interface Choice {
  objectId?: string;
  x: number;
  score: number;
  reason: string;
  kind: 'use_object' | 'pick_up' | 'wander';
}

const isNight = (h: number) => h >= 22 || h < 7;

export function interactionX(o: WorldObject): number {
  const def = OBJECT_DEFS[o.kind];
  switch (o.kind) {
    case 'bed':
      return o.x + 32;
    case 'computer':
      return o.x + 21;
    case 'bookshelf':
      return o.x + def.width + 10;
    case 'tree':
      return o.x + 22;
    case 'comm_box':
      return o.x + def.width + 12;
    case 'drop_box':
      return o.x + def.width + 12;
    default:
      return o.x + def.width / 2;
  }
}

function affordableBuild(objects: WorldObject[], inv: Inventory): ObjectKind | undefined {
  const kinds = [...new Set(objects.map((o) => o.kind))].filter((k) => {
    const d = OBJECT_DEFS[k];
    return d.recipe && !d.unique && k !== 'resource' && canAfford(inv, d.recipe);
  });
  return kinds[0];
}

export function scoreChoices(ctx: BrainContext): Choice[] {
  const { pet, objects, capabilities: caps, rng } = ctx;
  const n = pet.needs;
  const out: Choice[] = [];
  const totalRes = Object.values(pet.inventory.resources).reduce((a, b) => a + (b ?? 0), 0);

  for (const o of objects) {
    const def = OBJECT_DEFS[o.kind];
    let s = -Infinity;
    let reason = '';
    switch (o.kind) {
      case 'bed':
        s = n.energy > 85 ? -Infinity : Math.pow(100 - n.energy, 1.5) / 10 + (isNight(ctx.hour) ? 30 : 0);
        reason = 'sleepy';
        break;
      case 'food_bowl':
        if ((o.data?.servings ?? 0) > 0 && n.fullness < 85) s = (100 - n.fullness) * 1.15;
        reason = 'hungry';
        break;
      case 'bookshelf':
        s = n.curiosity * 0.6 + n.boredom * 0.2;
        reason = 'curious';
        break;
      case 'computer':
        s = ctx.sinceCoding < 150 ? -Infinity : n.curiosity * 0.5 + n.boredom * 0.35;
        reason = 'wants to tinker';
        break;
      case 'ball':
      case 'yarn':
      case 'plushie':
        s = n.boredom * 0.8 + (o.data?.bounce ? 45 : 0) + (o.kind === 'plushie' ? n.social * 0.3 : 0);
        reason = 'bored';
        break;
      case 'drop_box':
        s = ctx.dropBox.items.length ? 70 + ctx.dropBox.items.length * 5 : n.curiosity * 0.08;
        reason = ctx.dropBox.items.length ? 'something in the drop box' : 'checking for mail';
        break;
      case 'comm_box':
        s = ctx.hasOutbox ? 85 : -Infinity;
        reason = 'has a note to deliver';
        break;
      case 'workbench':
        if (caps.build_copies && affordableBuild(objects, pet.inventory)) s = 25 + n.boredom * 0.45;
        reason = 'wants to build';
        break;
      case 'tree':
      case 'bush':
        if (caps.forage && (o.data?.regrowIn ?? 0) <= 0 && totalRes < 14)
          s = 12 + n.curiosity * 0.3 + n.boredom * 0.25 + (o.kind === 'bush' && n.fullness < 40 ? 20 : 0);
        reason = 'foraging';
        break;
      case 'resource':
        if (totalRes < 20) s = 30;
        reason = 'found something';
        break;
    }
    if (!def.activity && o.kind !== 'resource') continue;
    if (!Number.isFinite(s)) continue;
    const x = interactionX(o);
    const dist = Math.abs(x - pet.position.x);
    out.push({
      objectId: o.id,
      x,
      score: s - dist / 18 + rng() * 14,
      reason,
      kind: o.kind === 'resource' ? 'pick_up' : 'use_object',
    });
  }
  out.push({ x: 20 + rng() * (WORLD.width - 40), score: 14 + rng() * 10, reason: 'wandering', kind: 'wander' });
  return out.sort((a, b) => b.score - a.score);
}

export function moodFromNeeds(n: Needs): Emotion {
  if (n.energy < 18) return 'sleepy';
  if (n.fullness < 18) return 'sad';
  if (n.social > 88 || n.boredom > 88) return 'sad';
  if (n.curiosity > 78) return 'thinking';
  const wellbeing = (n.energy + n.fullness + (100 - n.boredom) + (100 - n.social) + (100 - n.curiosity)) / 5;
  return wellbeing > 66 ? 'happy' : 'neutral';
}

// ---------------------------------------------------------------------------
// Phrase bank (used when the brain is in rules mode, or for tiny reactions)
// ---------------------------------------------------------------------------

export const PHRASES: Record<string, string[]> = {
  wake: ['*yawn* Good morning, world!', 'Mmf… that was a great nap.', 'Fully recharged!'],
  sleep: ['Nap time…', 'Just resting my eyes…', 'Zzz… five more minutes…'],
  eat: ['Nom nom nom!', 'Delicious!', 'Crunchy!'],
  read: ['Ooh, a book about clouds!', 'Did you know octopuses have three hearts?', 'One more chapter…'],
  code: ['Beep boop. Tinkering…', 'Let me try something…', 'Compiling dreams…'],
  play: ['Wheee!', 'Catch it, catch it!', 'Boing boing!'],
  forage: ['Ooh, found some goodies!', 'Nature provides!', 'Into the bag you go.'],
  build: ['Ta-da! I made a thing!', 'Built it myself!', 'A little workshop magic!'],
  dropbox: ['Let\'s see what\'s in the box…', 'Mail call!', 'Ooh, a delivery!'],
  note: ['I left you a note in the comm box!', 'Check the mailbox, please!'],
  hungry: ['My tummy is rumbling…', 'Is it snack time?'],
  bored: ['So bored… entertain me?', 'Hmm, what should I do…'],
  lonely: ['Hello? Anybody there?', 'I miss you!'],
  treat: ['A treat! Thank you, {name}!', 'Yum! Thanks, {name}!', '{name}, you\'re the best!'],
  toy: ['Ooh, the {toy}!', 'Play time!'],
  petted: ['Hehe, that tickles!', '*happy wiggle*', 'More pats please!'],
  dropped: ['Whoa!', 'Boing!', 'Again! Again!'],
  denied: ['Hmm, I\'m not allowed to do that.', 'That\'s not one of my powers.'],
  approved: ['My new shape got approved!! Thank you!', 'Yay, new look unlocked!'],
  rejected: ['Aw, back to the drawing board.', 'Okay, I\'ll design something better.'],
  hello_desktop: ['Ooh, the big world!', 'Out for a stroll!', 'Hi from your desktop!'],
  hungry_desktop: ['Psst… my food bowl is back home.', 'Could you open my window? Snack time!'],
};

export function phrase(key: string, rng: () => number, vars: Record<string, string> = {}): string {
  const list = PHRASES[key] ?? ['…'];
  let s = list[Math.floor(rng() * list.length)];
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

// ---------------------------------------------------------------------------
// Rule-based "coding" (no LLM): small, safe, whimsical programs
// ---------------------------------------------------------------------------

const PRETTY = ['#f48fb1', '#80d0f8', '#f5d442', '#7fe0b0', '#c3a6f0', '#ff7f6a', '#9b59d0', '#3f7fdc', '#4caf50', '#e0b23a'];

export function ruleProgram(objects: WorldObject[], dropBox: DropBox, caps: CapabilitySet, inv: Inventory, rng: () => number): unknown[] {
  const pick = <T,>(a: T[]) => a[Math.floor(rng() * a.length)];
  const options: Array<() => unknown> = [];
  const decor = objects.filter((o) => !OBJECT_DEFS[o.kind].unique && o.kind !== 'resource');
  if (caps.recolor_objects && decor.length)
    options.push(() => ({ op: 'recolor', target: pick(decor).id, color: pick(PRETTY) }));
  if (caps.change_skin && dropBox.skins.length > 1)
    options.push(() => ({ op: 'set_skin', skin: pick(dropBox.skins.length ? dropBox.skins : BUILTIN_SKINS).id }));
  const plants = objects.filter((o) => OBJECT_DEFS[o.kind].family === 'plant' && o.zone === 'yard');
  if (caps.transform_objects && plants.length)
    options.push(() => {
      const p = pick(plants);
      const into = pick((['tree', 'bush', 'flowers'] as ObjectKind[]).filter((k) => k !== p.kind));
      return { op: 'transform', target: p.id, into };
    });
  const movable = objects.filter((o) => o.zone === 'house' && !OBJECT_DEFS[o.kind].unique && o.kind !== 'rug');
  if (caps.rearrange && movable.length)
    options.push(() => {
      const o = pick(movable);
      return { op: 'move', target: o.id, x: Math.round(10 + rng() * (WORLD.doorX - 70)) };
    });
  if (caps.design_shapes && rng() < 0.25)
    options.push(() => ({
      op: 'design_shape',
      name: pick(['Starblob', 'Puddle', 'Mochi', 'Gumdrop', 'Marshmallow', 'Sprout']),
      spec: {
        width: 22 + Math.round(rng() * 14),
        height: 18 + Math.round(rng() * 10),
        peak: pick(['round', 'pointy', 'flat']),
        lean: Math.round((rng() - 0.5) * 8) / 10,
        feet: Math.floor(rng() * 5),
        ears: pick(['none', 'nubs', 'tufts']),
        gloss: rng() > 0.2,
      },
    }));
  if (caps.build_copies) {
    const k = affordableBuild(objects, inv);
    if (k) options.push(() => ({ op: 'build', kind: k, x: Math.round(20 + rng() * (WORLD.width - 60)) }));
  }
  if (!options.length) return [{ op: 'note', text: 'I sat at the computer but all my tinkering powers are switched off!' }];
  const n = 1 + Math.floor(rng() * 2);
  return Array.from({ length: n }, () => pick(options)());
}
