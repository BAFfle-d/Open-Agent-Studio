/**
 * The privacy boundary.
 *
 * `toPublicState` is a WHITELIST projection: it builds a fresh object from
 * named fields. Nothing is spread from internal state, so a field added to
 * PetState later cannot leak by accident — it has to be added here on purpose.
 *
 * What never crosses: desktop/overlay coordinates, window ids, display info,
 * private speech (owner chat, screen Q&A), image attachments, settings, keys,
 * memory, the comm box, or anything else not listed below.
 */
import type {
  Activity,
  Appearance,
  BlobPalette,
  Emotion,
  FanMode,
  Gesture,
  Needs,
  ObjectKind,
  PetState,
  ShapeSpec,
  WorldObject,
  WorldState,
} from './types.js';

export interface PublicObject {
  id: string;
  k: ObjectKind;
  x: number;
  c: string;
  /** Small kind-specific extras: servings, resource kind, bounce. */
  s?: number;
  r?: string;
  b?: number;
  /** Badge count (drop box items waiting, unread comm notes). */
  u?: number;
}

/** Abstract activity labels for when Blurb is out on the owner's desktop. */
export type PublicDesktopActivity = 'wandering' | 'perched' | 'playing_chase' | 'napping';

export interface PublicPet {
  name: string;
  /** 'home' = in the little world, 'out' = exploring the owner's desktop. */
  where: 'home' | 'out';
  x: number;
  y: number;
  vx: number;
  facing: 'l' | 'r';
  activity: Activity | PublicDesktopActivity;
  emotion: Emotion;
  gesture?: Gesture;
  needs: Needs;
  appearance: Appearance;
  palette: BlobPalette;
  shape: ShapeSpec;
  speech?: { id: string; text: string; emotion: Emotion; streaming?: boolean };
}

export interface PublicState {
  v: 1;
  t: number;
  timeOfDay: number;
  pet: PublicPet;
  objects: PublicObject[];
  fanMode: FanMode;
}

const DESKTOP_ACTIVITY: Partial<Record<Activity, PublicDesktopActivity>> = {
  desktop_wander: 'wandering',
  desktop_window_sit: 'perched',
  desktop_chase_cursor: 'playing_chase',
  desktop_nap: 'napping',
};

const q = (n: number) => Math.round(n);
const q1 = (n: number) => Math.round(n * 10) / 10;

export function toPublicObject(o: WorldObject): PublicObject {
  const p: PublicObject = { id: o.id, k: o.kind, x: q(o.x), c: o.color };
  if (o.data?.servings !== undefined) p.s = o.data.servings;
  if (o.data?.resource) p.r = o.data.resource;
  if (o.data?.bounce) p.b = q1(o.data.bounce);
  if (o.data?.unread) p.u = o.data.unread;
  return p;
}

export function toPublicState(
  pet: PetState,
  world: WorldState,
  look: { palette: BlobPalette; shape: ShapeSpec },
  fanMode: FanMode,
  now: number,
): PublicState {
  const out = pet.mode === 'overlay';
  const speech =
    pet.speech && pet.speech.visibility === 'public' && pet.speech.expiresAt > now
      ? { id: pet.speech.id, text: pet.speech.text, emotion: pet.speech.emotion, streaming: pet.speech.streaming || undefined }
      : undefined;
  return {
    v: 1,
    t: now,
    timeOfDay: q1(world.timeOfDay),
    pet: {
      name: pet.name,
      where: out ? 'out' : 'home',
      // While out, the public position is pinned to the doorway. The real
      // desktop position is never sent.
      x: out ? world.doorX : q(pet.position.x),
      y: out ? world.floorY : q(pet.position.y),
      vx: out ? 0 : q1(pet.velocity.x),
      facing: pet.facing === 'left' ? 'l' : 'r',
      activity: out ? DESKTOP_ACTIVITY[pet.activity] ?? 'wandering' : pet.activity,
      emotion: pet.emotion,
      gesture: !out && pet.gesture && pet.gestureUntil > now ? pet.gesture : undefined,
      needs: {
        energy: q(pet.needs.energy),
        fullness: q(pet.needs.fullness),
        curiosity: q(pet.needs.curiosity),
        boredom: q(pet.needs.boredom),
        social: q(pet.needs.social),
      },
      appearance: { skinId: pet.appearance.skinId, shapeId: pet.appearance.shapeId },
      palette: { ...look.palette },
      shape: { ...look.shape },
      speech,
    },
    objects: world.objects.map(toPublicObject),
    fanMode,
  };
}

// ---------------------------------------------------------------------------
// Delta compression
// ---------------------------------------------------------------------------

/**
 * A compact patch between two PublicStates. Pet fields are diffed one level
 * deep; objects are diffed by id. Typical idle/walk frames are ~60-120 bytes
 * versus ~2 KB for a full snapshot.
 */
export interface PublicDelta {
  t: number;
  pet?: Partial<PublicPet> & { speech?: PublicPet['speech'] | null };
  upsert?: PublicObject[];
  remove?: string[];
  timeOfDay?: number;
  fanMode?: FanMode;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function diffPublicState(prev: PublicState, next: PublicState): PublicDelta | null {
  const d: PublicDelta = { t: next.t };
  let changed = false;

  const petPatch: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(prev.pet), ...Object.keys(next.pet)]) as Set<keyof PublicPet>;
  for (const k of keys) {
    const a = prev.pet[k];
    const b = next.pet[k];
    if (!sameJson(a, b)) petPatch[k] = b === undefined ? null : b;
  }
  if (Object.keys(petPatch).length) {
    d.pet = petPatch as PublicDelta['pet'];
    changed = true;
  }

  const prevById = new Map(prev.objects.map((o) => [o.id, o]));
  const nextIds = new Set<string>();
  const upsert: PublicObject[] = [];
  for (const o of next.objects) {
    nextIds.add(o.id);
    const p = prevById.get(o.id);
    if (!p || !sameJson(p, o)) upsert.push(o);
  }
  const remove = prev.objects.filter((o) => !nextIds.has(o.id)).map((o) => o.id);
  if (upsert.length) (d.upsert = upsert), (changed = true);
  if (remove.length) (d.remove = remove), (changed = true);
  if (prev.timeOfDay !== next.timeOfDay) (d.timeOfDay = next.timeOfDay), (changed = true);
  if (prev.fanMode !== next.fanMode) (d.fanMode = next.fanMode), (changed = true);
  return changed ? d : null;
}

export function applyPublicDelta(state: PublicState, d: PublicDelta): PublicState {
  const pet = { ...state.pet } as Record<string, unknown>;
  if (d.pet) {
    for (const [k, v] of Object.entries(d.pet)) {
      if (v === null) delete pet[k];
      else pet[k] = v;
    }
  }
  let objects = state.objects;
  if (d.upsert || d.remove) {
    const byId = new Map(objects.map((o) => [o.id, o]));
    for (const id of d.remove ?? []) byId.delete(id);
    for (const o of d.upsert ?? []) byId.set(o.id, o);
    objects = [...byId.values()];
  }
  return {
    v: 1,
    t: d.t,
    timeOfDay: d.timeOfDay ?? state.timeOfDay,
    pet: pet as unknown as PublicPet,
    objects,
    fanMode: d.fanMode ?? state.fanMode,
  };
}
