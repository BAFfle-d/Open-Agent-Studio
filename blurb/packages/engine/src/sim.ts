/**
 * PetSim — the authoritative simulation of Blurb and its little world.
 *
 * Runs in the Electron MAIN process (not a renderer), so it keeps ticking
 * when the window is minimized or hidden — which is what lets the fan viewer
 * keep showing a live world while the owner works.
 */
import {
  BUILTIN_SHAPES,
  BUILTIN_SKINS,
  CLASSIC_SHAPE,
  DEFAULT_CAPABILITIES,
  DEFAULT_NEEDS,
  FORAGE_REGROW_SEC,
  FORAGE_YIELDS,
  OBJECT_DEFS,
  RESOURCE_COLORS,
  WORLD,
  defaultWorldObjects,
  makeId,
  paletteFromBody,
  validateProgram,
  zoneAt,
  type BlobPalette,
  type CapabilitySet,
  type CommNote,
  type DropBox,
  type DropBoxItem,
  type Emotion,
  type Gesture,
  type Needs,
  type ObjectKind,
  type ParsedTag,
  type PetState,
  type ProgramContext,
  type ProgramOp,
  type ResourceKind,
  type ShapeDesign,
  type ShapeSpec,
  type SpeechBubble,
  type ToyKind,
  type TreatKind,
  type WorldObject,
  type WorldState,
} from '@blurb/shared';
import { interactionX, moodFromNeeds, phrase, ruleProgram, scoreChoices } from './brain.js';

export type SimEvent =
  | { type: 'speech'; speech: SpeechBubble }
  | { type: 'activity'; activity: PetState['activity']; objectId?: string }
  | { type: 'burst'; kind: 'treat' | 'build' | 'pet' | 'magic'; x: number; y: number }
  | { type: 'program'; ops: ProgramOp[]; rejected: { reason: string }[]; summary: string[] }
  | { type: 'note'; note: CommNote }
  | { type: 'dropbox'; collected: DropBoxItem[] }
  | { type: 'request_program' }
  | { type: 'log'; text: string };

export interface SimSnapshot {
  version: 1;
  pet: PetState;
  world: WorldState;
  dropBox: DropBox;
  notes: CommNote[];
  outbox: CommNote[];
}

export type ProgramProvider = (ctx: ProgramContext) => Promise<unknown[] | null>;

const WALK_SPEED = 34;
const GRAVITY = 520;
const MAX_NOTES = 50;
const MAX_CUSTOM_SKINS = 6;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function newPetState(name = 'Blurb'): PetState {
  return {
    id: 'blurb',
    name,
    mode: 'windowed',
    position: { x: 170, y: WORLD.floorY },
    velocity: { x: 0, y: 0 },
    facing: 'right',
    activity: 'idle',
    activityTimer: 2,
    emotion: 'happy',
    emotionUntil: 0,
    gestureUntil: 0,
    needs: { ...DEFAULT_NEEDS },
    appearance: { skinId: 'red', shapeId: 'classic' },
    inventory: { resources: { stick: 1 } },
  };
}

export function newWorldState(): WorldState {
  return {
    width: WORLD.width,
    height: WORLD.height,
    floorY: WORLD.floorY,
    doorX: WORLD.doorX,
    objects: defaultWorldObjects(),
    timeOfDay: 12,
    clock: 0,
  };
}

export function newDropBox(): DropBox {
  return {
    skins: BUILTIN_SKINS.map((s) => ({ ...s, palette: { ...s.palette } })),
    shapes: BUILTIN_SHAPES.map((s) => ({ ...s, spec: { ...s.spec } })),
    items: [],
  };
}

export class PetSim {
  pet: PetState;
  world: WorldState;
  dropBox: DropBox;
  /** Delivered notes, visible to the owner in the comm box. */
  notes: CommNote[] = [];
  /** Notes Blurb has written but not yet walked to the comm box. */
  outbox: CommNote[] = [];
  capabilities: CapabilitySet = { ...DEFAULT_CAPABILITIES };
  simSpeed = 1;
  chattiness = 0.5;
  /** Optional: when set, computer sessions ask the LLM for a program. */
  programProvider?: ProgramProvider;
  /** Fixed hour for tests/demo; otherwise the local clock. */
  hourOverride?: number;
  rng: () => number = Math.random;

  private listeners = new Set<(e: SimEvent) => void>();
  private recent: string[] = [];
  private sinceCoding = 999;
  private pendingProgram: Promise<unknown[] | null> | null = null;
  private programResult: unknown[] | null | undefined;
  private chatterCooldown = 8;
  private lowNeedNag = 0;
  private dragLast = { x: 0, y: 0, t: 0 };

  constructor(snapshot?: SimSnapshot) {
    this.pet = snapshot?.pet ?? newPetState();
    this.world = snapshot?.world ?? newWorldState();
    this.dropBox = snapshot?.dropBox ?? newDropBox();
    this.notes = snapshot?.notes ?? [];
    this.outbox = snapshot?.outbox ?? [];
    // Never resume mid-drag or out on the desktop.
    if (this.pet.activity === 'dragged' || this.pet.activity === 'falling' || this.pet.mode === 'overlay') {
      this.pet.mode = 'windowed';
      this.pet.activity = 'idle';
      this.pet.position.y = WORLD.floorY;
      delete this.pet.desktop;
    }
    this.pet.speech = undefined;
    this.syncBadges();
  }

  // -------------------------------------------------------------------------
  // events
  // -------------------------------------------------------------------------

  on(fn: (e: SimEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: SimEvent) {
    for (const fn of this.listeners) fn(e);
  }

  /** Human-readable recent events, fed to the LLM as context. */
  log(text: string) {
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    this.recent.push(`${stamp} ${text}`);
    if (this.recent.length > 14) this.recent.shift();
    this.emit({ type: 'log', text });
  }

  recentEvents(): string[] {
    return [...this.recent];
  }

  snapshot(): SimSnapshot {
    return structuredClone({
      version: 1 as const,
      pet: { ...this.pet, speech: undefined },
      world: this.world,
      dropBox: this.dropBox,
      notes: this.notes,
      outbox: this.outbox,
    });
  }

  // -------------------------------------------------------------------------
  // appearance
  // -------------------------------------------------------------------------

  look(): { palette: BlobPalette; shape: ShapeSpec } {
    const skin = this.dropBox.skins.find((s) => s.id === this.pet.appearance.skinId) ?? BUILTIN_SKINS[0];
    const shape = this.dropBox.shapes.find((s) => s.id === this.pet.appearance.shapeId);
    return { palette: skin.palette, shape: shape?.spec ?? CLASSIC_SHAPE };
  }

  // -------------------------------------------------------------------------
  // speech & emotion
  // -------------------------------------------------------------------------

  say(text: string, opts: { emotion?: Emotion; visibility?: 'public' | 'private'; audience?: SpeechBubble['audience']; ms?: number } = {}) {
    const now = Date.now();
    const emotion = opts.emotion ?? this.pet.emotion;
    const speech: SpeechBubble = {
      id: makeId('say'),
      text,
      emotion,
      visibility: opts.visibility ?? 'public',
      audience: opts.audience ?? 'everyone',
      createdAt: now,
      expiresAt: now + (opts.ms ?? 2800 + text.length * 70),
    };
    this.pet.speech = speech;
    if (opts.emotion) this.setEmotion(opts.emotion, 6);
    this.emit({ type: 'speech', speech });
    return speech;
  }

  /** Streaming speech: begin → append* → end. */
  beginSpeech(visibility: 'public' | 'private', audience: SpeechBubble['audience']): string {
    const now = Date.now();
    const id = makeId('say');
    this.pet.speech = { id, text: '', emotion: this.pet.emotion, visibility, audience, createdAt: now, expiresAt: now + 60_000, streaming: true };
    return id;
  }

  appendSpeech(id: string, text: string) {
    if (this.pet.speech?.id !== id) return;
    this.pet.speech.text += text;
    this.pet.speech.expiresAt = Date.now() + 60_000;
  }

  endSpeech(id: string) {
    const s = this.pet.speech;
    if (s?.id !== id) return;
    s.streaming = false;
    s.text = s.text.trim();
    s.expiresAt = Date.now() + 3000 + s.text.length * 70;
    if (!s.text) this.pet.speech = undefined;
    else this.emit({ type: 'speech', speech: { ...s } });
  }

  setEmotion(emotion: Emotion, seconds = 6) {
    this.pet.emotion = emotion;
    this.pet.emotionUntil = Date.now() + seconds * 1000;
  }

  gesture(g: Gesture, seconds = 2.5) {
    this.pet.gesture = g;
    this.pet.gestureUntil = Date.now() + seconds * 1000;
  }

  private maybeSay(key: string, vars: Record<string, string> = {}, emotion?: Emotion, force = false) {
    if (!force && (this.chatterCooldown > 0 || this.rng() > 0.35 + this.chattiness * 0.6)) return;
    this.chatterCooldown = 10 + (1 - this.chattiness) * 30;
    this.say(phrase(key, this.rng, vars), { emotion });
  }

  // -------------------------------------------------------------------------
  // main tick
  // -------------------------------------------------------------------------

  tick(dt: number, now = Date.now()) {
    dt = Math.min(dt, 0.25);
    const p = this.pet;
    this.world.clock += dt;
    const d = new Date(now);
    this.world.timeOfDay = this.hourOverride ?? d.getHours() + d.getMinutes() / 60;
    this.sinceCoding += dt;
    this.chatterCooldown = Math.max(0, this.chatterCooldown - dt);

    if (p.speech && !p.speech.streaming && p.speech.expiresAt < now) p.speech = undefined;
    if (p.gesture && p.gestureUntil < now) p.gesture = undefined;

    this.decayNeeds(dt);
    this.tickObjects(dt);

    if (p.mode === 'overlay') {
      // Desktop motion is driven by DesktopSim; only mood is handled here.
      if (p.emotionUntil < now) p.emotion = moodFromNeeds(p.needs);
      return;
    }

    switch (p.activity) {
      case 'dragged':
        break;
      case 'falling':
        p.velocity.y += GRAVITY * dt;
        p.position.x = clamp(p.position.x + p.velocity.x * dt, 8, WORLD.width - 8);
        p.position.y = Math.max(30, p.position.y + p.velocity.y * dt);
        if (p.position.y >= WORLD.floorY) {
          p.position.y = WORLD.floorY;
          p.velocity = { x: 0, y: 0 };
          this.setActivity('idle', 1.2);
          this.setEmotion(this.rng() < 0.6 ? 'excited' : 'confused', 3);
          this.maybeSay('dropped', {}, undefined, this.rng() < 0.5);
        }
        break;
      case 'walking':
        this.tickWalk(dt);
        break;
      case 'idle':
        p.activityTimer -= dt;
        if (p.activityTimer <= 0) this.decide();
        break;
      case 'being_pet':
        p.needs.social = clamp(p.needs.social - 6 * dt, 0, 100);
        p.needs.boredom = clamp(p.needs.boredom - 2 * dt, 0, 100);
        p.activityTimer -= dt;
        if (p.activityTimer <= 0) this.setActivity('idle', 1.5);
        break;
      default:
        this.tickActivity(dt);
    }

    if (p.emotionUntil < now) p.emotion = moodFromNeeds(p.needs);
    this.nag(dt);
  }

  private decayNeeds(dt: number) {
    const n = this.pet.needs;
    const k = dt * this.simSpeed * (this.pet.mode === 'overlay' ? 0.6 : 1);
    const asleep = this.pet.activity === 'sleeping' || this.pet.activity === 'desktop_nap';
    if (!asleep) n.energy -= 0.03 * k;
    else if (this.pet.activity === 'desktop_nap') n.energy += 0.6 * k;
    n.fullness -= 0.02 * k;
    n.curiosity += 0.04 * k;
    n.boredom += (asleep ? 0.005 : 0.05) * k;
    n.social += 0.03 * k;
    for (const key of Object.keys(n) as Array<keyof Needs>) n[key] = clamp(n[key], 0, 100);
  }

  private tickObjects(dt: number) {
    for (const o of this.world.objects) {
      if (o.data?.bounce) {
        o.data.bounce = Math.max(0, o.data.bounce - dt);
        if (!o.data.bounce) delete o.data.bounce;
      }
      if (o.data?.regrowIn) {
        o.data.regrowIn = Math.max(0, o.data.regrowIn - dt * this.simSpeed);
      }
    }
    // Occasionally something interesting washes up in the yard.
    if (this.rng() < dt / 90 && this.world.objects.filter((o) => o.kind === 'resource').length < 5) {
      const kinds: ResourceKind[] = ['pebble', 'stick', 'fluff', 'fluff', 'leaf'];
      const r = kinds[Math.floor(this.rng() * kinds.length)];
      this.addObject('resource', WORLD.doorX + 10 + this.rng() * (WORLD.width - WORLD.doorX - 24), 'world', {
        data: { resource: r },
        color: RESOURCE_COLORS[r],
      });
    }
  }

  private nag(dt: number) {
    this.lowNeedNag -= dt;
    if (this.lowNeedNag > 0) return;
    const n = this.pet.needs;
    const bowl = this.world.objects.find((o) => o.kind === 'food_bowl' && (o.data?.servings ?? 0) > 0);
    if (n.fullness < 25 && !bowl) {
      this.say(phrase('hungry', this.rng), { emotion: 'sad' });
      this.log('Blurb is hungry and the food bowl is empty');
      this.lowNeedNag = 120;
    } else if (n.social > 85) {
      this.maybeSay('lonely', {}, 'sad', true);
      this.lowNeedNag = 180;
    } else this.lowNeedNag = 20;
  }

  // -------------------------------------------------------------------------
  // decisions & movement
  // -------------------------------------------------------------------------

  private setActivity(a: PetState['activity'], timer = 0, objectId?: string) {
    this.pet.activity = a;
    this.pet.activityTimer = timer;
    if (a !== 'walking') this.pet.velocity.x = 0;
    this.emit({ type: 'activity', activity: a, objectId });
  }

  decide() {
    const choices = scoreChoices({
      pet: this.pet,
      objects: this.world.objects,
      dropBox: this.dropBox,
      capabilities: this.capabilities,
      hasOutbox: this.outbox.length > 0,
      hour: this.world.timeOfDay,
      sinceCoding: this.sinceCoding,
      rng: this.rng,
    });
    const c = choices[0];
    if (!c) return this.setActivity('idle', 3);
    this.goTo(c.x, c.kind, c.objectId, c.reason);
  }

  goTo(x: number, kind: 'use_object' | 'pick_up' | 'wander' | 'go_to', objectId?: string, reason = '') {
    const p = this.pet;
    p.goal = { kind, objectId, x: clamp(x, 10, WORLD.width - 10), reason };
    this.setActivity('walking');
  }

  /** Ask Blurb to use a specific object (owner click, chat action). */
  requestUse(objectId: string, reason = 'asked to'): boolean {
    const o = this.world.objects.find((x) => x.id === objectId);
    if (!o || this.pet.mode === 'overlay') return false;
    if (this.pet.activity === 'dragged' || this.pet.activity === 'falling') return false;
    this.goTo(interactionX(o), o.kind === 'resource' ? 'pick_up' : 'use_object', o.id, reason);
    return true;
  }

  private tickWalk(dt: number) {
    const p = this.pet;
    const g = p.goal;
    if (!g) return this.setActivity('idle', 1);
    // If the target object moved/vanished, re-aim or give up.
    if (g.objectId) {
      const o = this.world.objects.find((x) => x.id === g.objectId);
      if (!o) {
        p.goal = undefined;
        return this.setActivity('idle', 1);
      }
      g.x = interactionX(o);
    }
    const dx = g.x - p.position.x;
    if (Math.abs(dx) < 1.5) {
      p.position.x = g.x;
      p.velocity.x = 0;
      return this.arrive();
    }
    const dir = Math.sign(dx);
    p.facing = dir < 0 ? 'left' : 'right';
    p.velocity.x = dir * WALK_SPEED;
    p.position.x += p.velocity.x * dt;
    if (Math.sign(g.x - p.position.x) !== dir) p.position.x = g.x;
  }

  private arrive() {
    const p = this.pet;
    const g = p.goal;
    p.goal = undefined;
    if (!g || g.kind === 'wander' || g.kind === 'go_to' || !g.objectId) return this.setActivity('idle', 2 + this.rng() * 4);
    const o = this.world.objects.find((x) => x.id === g.objectId);
    if (!o) return this.setActivity('idle', 1);
    if (g.kind === 'pick_up') return this.pickUp(o);
    this.startUsing(o);
  }

  private startUsing(o: WorldObject) {
    const def = OBJECT_DEFS[o.kind];
    if (!def.activity) return this.setActivity('idle', 2);
    const p = this.pet;
    p.facing = o.x + def.width / 2 < p.position.x ? 'left' : 'right';
    switch (def.activity) {
      case 'eating': {
        if ((o.data?.servings ?? 0) <= 0) {
          this.maybeSay('hungry', {}, 'sad', true);
          return this.setActivity('idle', 2);
        }
        o.data = { ...o.data, servings: (o.data?.servings ?? 1) - 1 };
        this.maybeSay('eat', {}, 'happy', true);
        this.log('ate a snack');
        break;
      }
      case 'sleeping':
        p.position.y = WORLD.floorY - 9; // on the mattress
        this.maybeSay('sleep', {}, 'sleepy');
        this.log('went to bed');
        break;
      case 'reading':
        this.log('started reading');
        break;
      case 'coding':
        this.sinceCoding = 0;
        this.programResult = undefined;
        this.pendingProgram = null;
        this.maybeSay('code', {}, 'thinking', true);
        this.log('sat down at the computer');
        if (this.programProvider) {
          const ctx = this.programContext();
          this.pendingProgram = this.programProvider(ctx)
            .then((r) => (this.programResult = r))
            .catch(() => (this.programResult = null));
          this.emit({ type: 'request_program' });
        }
        break;
      case 'playing':
        o.data = { ...o.data, bounce: 4 };
        this.maybeSay('play', {}, 'excited');
        break;
      case 'checking_dropbox':
        this.maybeSay('dropbox', {}, 'excited', this.dropBox.items.length > 0);
        break;
      case 'foraging':
        if (!this.capabilities.forage || (o.data?.regrowIn ?? 0) > 0) return this.setActivity('idle', 2);
        break;
      case 'building':
        if (!this.capabilities.build_copies) return this.setActivity('idle', 2);
        break;
    }
    this.setActivity(def.activity, def.duration ?? 5, o.id);
    p.goal = { kind: 'use_object', objectId: o.id, x: p.position.x, reason: 'using' };
  }

  private tickActivity(dt: number) {
    const p = this.pet;
    const o = p.goal?.objectId ? this.world.objects.find((x) => x.id === p.goal!.objectId) : undefined;
    if (!o) {
      p.position.y = WORLD.floorY;
      return this.setActivity('idle', 1);
    }
    const def = OBJECT_DEFS[o.kind];
    if (def.effect) {
      const k = dt * Math.max(1, this.simSpeed * 0.5);
      for (const [need, rate] of Object.entries(def.effect)) {
        const key = need as keyof Needs;
        p.needs[key] = clamp(p.needs[key] + (rate ?? 0) * k, 0, 100);
      }
    }
    p.activityTimer -= dt;
    const done =
      p.activityTimer <= 0 ||
      (p.activity === 'sleeping' && p.needs.energy >= 99) ||
      (p.activity === 'eating' && p.needs.fullness >= 100);
    if (p.activity === 'coding' && p.activityTimer <= 0 && this.pendingProgram && this.programResult === undefined) {
      // Waiting on the LLM; keep typing for up to 25 more seconds.
      if (p.activityTimer > -25) return;
    }
    if (done) this.finishActivity(o);
  }

  private finishActivity(o: WorldObject) {
    const p = this.pet;
    const a = p.activity;
    p.position.y = WORLD.floorY;
    p.goal = undefined;
    switch (a) {
      case 'sleeping':
        this.maybeSay('wake', {}, 'happy');
        this.log('woke up from a nap');
        break;
      case 'reading':
        this.maybeSay('read', {}, 'happy');
        break;
      case 'foraging':
        this.forage(o);
        break;
      case 'building':
        this.buildAtBench();
        break;
      case 'coding': {
        const raw = this.programResult ?? ruleProgram(this.world.objects, this.dropBox, this.capabilities, p.inventory, this.rng);
        this.pendingProgram = null;
        this.programResult = undefined;
        this.runProgram(raw);
        break;
      }
      case 'checking_dropbox':
        this.collectDropBox();
        break;
      case 'writing_note':
        this.deliverOutbox();
        break;
    }
    this.setActivity('idle', 1.5 + this.rng() * 3);
  }

  // -------------------------------------------------------------------------
  // resources, building, drop box, comm box
  // -------------------------------------------------------------------------

  private addResource(r: ResourceKind, n: number) {
    const inv = this.pet.inventory.resources;
    inv[r] = Math.min(40, (inv[r] ?? 0) + n);
  }

  private pickUp(o: WorldObject) {
    const r = o.data?.resource ?? 'pebble';
    this.addResource(r, 1);
    this.removeObject(o.id);
    this.log(`picked up a ${r}`);
    this.setEmotion('happy', 3);
    this.setActivity('idle', 1);
  }

  private forage(o: WorldObject) {
    const yields = FORAGE_YIELDS[o.kind] ?? [];
    const got: string[] = [];
    for (const [r, lo, hi] of yields) {
      const n = lo + Math.floor(this.rng() * (hi - lo + 1));
      if (n > 0) {
        this.addResource(r, n);
        got.push(`${n} ${r}${n > 1 ? 's' : ''}`);
      }
    }
    o.data = { ...o.data, regrowIn: FORAGE_REGROW_SEC };
    if (got.length) {
      this.log(`foraged ${got.join(' and ')} from the ${o.kind}`);
      this.maybeSay('forage', {}, 'happy');
    }
  }

  private buildAtBench() {
    const raw = ruleProgram(this.world.objects, this.dropBox, { ...this.capabilities, recolor_objects: false, change_skin: false, transform_objects: false, rearrange: false, design_shapes: false }, this.pet.inventory, this.rng);
    const builds = raw.filter((r) => (r as { op?: string }).op === 'build');
    if (builds.length) this.runProgram(builds.slice(0, 1), { quiet: true });
  }

  addObject(kind: ObjectKind, x: number, origin: WorldObject['origin'], extra: Partial<WorldObject> = {}): WorldObject | null {
    if (this.world.objects.length >= WORLD.maxObjects) return null;
    const def = OBJECT_DEFS[kind];
    const cx = clamp(Math.round(x), 0, WORLD.width - def.width);
    const o: WorldObject = {
      id: makeId(kind),
      kind,
      x: cx,
      y: WORLD.floorY,
      color: def.defaultColor,
      zone: zoneAt(cx + def.width / 2),
      origin,
      ...extra,
    };
    this.world.objects.push(o);
    return o;
  }

  removeObject(id: string) {
    this.world.objects = this.world.objects.filter((o) => o.id !== id);
  }

  private collectDropBox() {
    const items = this.dropBox.items;
    if (!items.length) {
      // Nothing new — maybe try on a different skin for fun.
      if (this.capabilities.change_skin && this.rng() < 0.3 && this.dropBox.skins.length > 1) {
        const others = this.dropBox.skins.filter((s) => s.id !== this.pet.appearance.skinId);
        const s = others[Math.floor(this.rng() * others.length)];
        this.pet.appearance.skinId = s.id;
        this.emit({ type: 'burst', kind: 'magic', x: this.pet.position.x, y: this.pet.position.y - 20 });
        this.say(`Trying on ${s.name}!`, { emotion: 'excited' });
        this.log(`changed into the ${s.name} skin`);
      }
      return;
    }
    const collected = [...items];
    this.dropBox.items = [];
    const box = this.world.objects.find((o) => o.kind === 'drop_box');
    for (const it of collected) {
      if (it.kind === 'resource' && it.resource) this.addResource(it.resource, it.count);
      if (it.kind === 'treat') this.addServings(it.count);
      if (it.kind === 'object' && it.objectKind) {
        for (let i = 0; i < it.count; i++) this.addObject(it.objectKind, (box?.x ?? 190) + 28 + i * 14, it.from);
      }
    }
    const desc = collected.map((i) => `${i.count} ${i.resource ?? i.objectKind ?? 'treat'}`).join(', ');
    this.log(`collected from the drop box: ${desc}`);
    this.emit({ type: 'dropbox', collected });
    this.say(`Ooh! ${desc}!`, { emotion: 'excited' });
    this.syncBadges();
  }

  private addServings(n: number) {
    const bowl = this.world.objects.find((o) => o.kind === 'food_bowl');
    if (!bowl) return;
    bowl.data = { ...bowl.data, servings: Math.min(9, (bowl.data?.servings ?? 0) + n) };
  }

  private writeNote(text: string, request?: CommNote['request']) {
    const note: CommNote = { id: makeId('note'), createdAt: Date.now(), text, request, read: false };
    this.outbox.push(note);
    this.log(request ? `wrote an approval request for "${request.design.name}"` : 'wrote a note');
  }

  private deliverOutbox() {
    if (!this.outbox.length) return;
    for (const n of this.outbox) {
      this.notes.unshift(n);
      this.emit({ type: 'note', note: n });
    }
    this.outbox = [];
    this.notes = this.notes.slice(0, MAX_NOTES);
    this.syncBadges();
    this.maybeSay('note', {}, 'happy', true);
  }

  private syncBadges() {
    const unread = this.notes.filter((n) => !n.read).length;
    for (const o of this.world.objects) {
      if (o.kind === 'comm_box') o.data = { ...o.data, unread: unread || undefined };
      if (o.kind === 'drop_box') o.data = { ...o.data, unread: this.dropBox.items.length || undefined };
    }
  }

  markNotesRead() {
    for (const n of this.notes) n.read = true;
    this.syncBadges();
  }

  /** Owner decides on a shape design waiting in the comm box. */
  decideShape(noteId: string, approve: boolean): boolean {
    const note = this.notes.find((n) => n.id === noteId);
    const req = note?.request;
    if (!note || !req || req.status !== 'pending') return false;
    req.status = approve ? 'approved' : 'rejected';
    req.decidedAt = Date.now();
    note.read = true;
    if (approve) {
      this.dropBox.shapes.push({ ...req.design, origin: 'pet' });
      this.say(phrase('approved', this.rng), { emotion: 'excited' });
      this.gesture('dance', 3);
      this.log(`owner approved the shape "${req.design.name}"`);
      if (this.capabilities.change_shape) {
        this.pet.appearance.shapeId = req.design.id;
        this.emit({ type: 'burst', kind: 'magic', x: this.pet.position.x, y: this.pet.position.y - 20 });
      }
    } else {
      this.say(phrase('rejected', this.rng), { emotion: 'sad' });
      this.log(`owner declined the shape "${req.design.name}"`);
    }
    this.syncBadges();
    return true;
  }

  // -------------------------------------------------------------------------
  // BlurbScript execution
  // -------------------------------------------------------------------------

  programContext(): ProgramContext {
    return {
      objects: this.world.objects,
      dropBox: this.dropBox,
      capabilities: this.capabilities,
      inventory: this.pet.inventory,
    };
  }

  runProgram(raw: unknown, opts: { quiet?: boolean } = {}) {
    const { ops, rejected } = validateProgram(raw, this.programContext());
    const summary: string[] = [];
    for (const op of ops) summary.push(this.applyOp(op));
    for (const r of rejected) this.log(`tried something not allowed: ${r.reason}`);
    this.emit({ type: 'program', ops, rejected: rejected.map((r) => ({ reason: r.reason })), summary });
    if (!opts.quiet) {
      if (ops.length) {
        this.say(summary[summary.length - 1] ?? 'Done!', { emotion: 'excited' });
        this.gesture('hop', 1.2);
      } else if (rejected.length) {
        this.say(`${phrase('denied', this.rng)} (${rejected[0].reason})`, { emotion: 'confused' });
      }
    }
    return { ops, rejected, summary };
  }

  private applyOp(op: ProgramOp): string {
    const find = (id: string) => this.world.objects.find((o) => o.id === id);
    const burst = (x: number, y = WORLD.floorY - 20, kind: 'build' | 'magic' = 'magic') => this.emit({ type: 'burst', kind, x, y });
    switch (op.op) {
      case 'recolor': {
        if (op.target === 'self') {
          const id = `custom-${op.color.slice(1)}`;
          if (!this.dropBox.skins.some((s) => s.id === id)) {
            const custom = this.dropBox.skins.filter((s) => s.origin === 'pet');
            if (custom.length >= MAX_CUSTOM_SKINS) {
              const oldest = custom[0].id;
              this.dropBox.skins = this.dropBox.skins.filter((s) => s.id !== oldest || s.id === this.pet.appearance.skinId);
            }
            this.dropBox.skins.push({ id, name: `Custom ${op.color}`, palette: paletteFromBody(op.color), origin: 'pet' });
          }
          this.pet.appearance.skinId = id;
          burst(this.pet.position.x, this.pet.position.y - 20);
          this.log(`recolored itself ${op.color}`);
          return `New color! ${op.color}`;
        }
        const o = find(op.target);
        if (!o) return '';
        o.color = op.color;
        burst(o.x + OBJECT_DEFS[o.kind].width / 2);
        this.log(`painted the ${o.kind} ${op.color}`);
        return `I painted the ${OBJECT_DEFS[o.kind].label.toLowerCase()}!`;
      }
      case 'transform': {
        const o = find(op.target);
        if (!o) return '';
        const from = o.kind;
        o.kind = op.into;
        o.x = clamp(o.x, 0, WORLD.width - OBJECT_DEFS[op.into].width);
        if (o.color === OBJECT_DEFS[from].defaultColor) o.color = OBJECT_DEFS[op.into].defaultColor;
        delete o.data?.regrowIn;
        burst(o.x + OBJECT_DEFS[o.kind].width / 2);
        this.log(`turned a ${from} into a ${op.into}`);
        return `Poof! The ${from} is now a ${op.into}!`;
      }
      case 'move': {
        const o = find(op.target);
        if (!o) return '';
        o.x = op.x;
        o.zone = zoneAt(op.x + OBJECT_DEFS[o.kind].width / 2);
        this.log(`moved the ${o.kind}`);
        return `Rearranged the ${OBJECT_DEFS[o.kind].label.toLowerCase()}.`;
      }
      case 'build': {
        const def = OBJECT_DEFS[op.kind];
        for (const [k, n] of Object.entries(def.recipe ?? {})) {
          const key = k as ResourceKind;
          this.pet.inventory.resources[key] = (this.pet.inventory.resources[key] ?? 0) - (n ?? 0);
        }
        const o = this.addObject(op.kind, op.x, 'pet', op.color ? { color: op.color } : {});
        if (!o) return '';
        burst(o.x + def.width / 2, WORLD.floorY - 10, 'build');
        this.log(`built a ${op.kind}`);
        return phrase('build', this.rng);
      }
      case 'set_skin': {
        this.pet.appearance.skinId = op.skin;
        burst(this.pet.position.x, this.pet.position.y - 20);
        const s = this.dropBox.skins.find((x) => x.id === op.skin);
        this.log(`changed into the ${s?.name ?? op.skin} skin`);
        return `How do I look in ${s?.name ?? op.skin}?`;
      }
      case 'set_shape': {
        this.pet.appearance.shapeId = op.shape;
        burst(this.pet.position.x, this.pet.position.y - 20);
        this.log(`changed shape to ${op.shape}`);
        return 'Shape shift!';
      }
      case 'design_shape': {
        const design: ShapeDesign = { id: makeId('shape'), name: op.name, spec: op.spec, origin: 'pet' };
        this.writeNote(`I designed a new shape called "${op.name}"! Can I add it to my drop box?`, {
          kind: 'shape',
          status: 'pending',
          design,
        });
        return `I designed "${op.name}"! I'll ask for approval.`;
      }
      case 'note':
        this.writeNote(op.text);
        return 'I wrote you a note!';
    }
  }

  // -------------------------------------------------------------------------
  // tag actions (from LLM output)
  // -------------------------------------------------------------------------

  /**
   * Apply [[action:...]] tags. `source` limits what is allowed:
   * fan-context replies may only emote and do harmless gestures.
   */
  applyTags(tags: ParsedTag[], source: 'owner' | 'self' | 'fan') {
    for (const t of tags) {
      if (t.type === 'emotion') {
        this.setEmotion(t.emotion, 8);
        continue;
      }
      if (source === 'fan' && !['wave', 'dance'].includes(t.action)) continue;
      if (this.pet.mode === 'overlay' && !['wave', 'dance'].includes(t.action)) continue;
      const byKind = (kinds: ObjectKind[]) => {
        const cands = this.world.objects.filter((o) => kinds.includes(o.kind));
        cands.sort((a, b) => Math.abs(interactionX(a) - this.pet.position.x) - Math.abs(interactionX(b) - this.pet.position.x));
        return cands[0];
      };
      const use = (o?: WorldObject) => o && this.requestUse(o.id, 'decided to');
      switch (t.action) {
        case 'wave':
          this.gesture('wave', 2.5);
          break;
        case 'dance':
          this.gesture('dance', 3);
          break;
        case 'nap':
          use(byKind(['bed']));
          break;
        case 'eat':
          use(byKind(['food_bowl']));
          break;
        case 'play':
          use(byKind(['ball', 'yarn', 'plushie']));
          break;
        case 'read':
          use(byKind(['bookshelf']));
          break;
        case 'code':
          use(byKind(['computer']));
          break;
        case 'forage':
          use(byKind(['tree', 'bush']));
          break;
        case 'build':
          use(byKind(['workbench']));
          break;
        case 'check_dropbox':
          use(byKind(['drop_box']));
          break;
        case 'wander':
          this.goTo(20 + this.rng() * (WORLD.width - 40), 'wander');
          break;
        case 'goto': {
          const target = this.world.objects.find((o) => o.id === t.arg || o.kind === t.arg);
          use(target);
          break;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // owner & fan interactions
  // -------------------------------------------------------------------------

  dragStart() {
    if (this.pet.mode !== 'windowed') return;
    this.pet.goal = undefined;
    this.setActivity('dragged');
    this.setEmotion(this.rng() < 0.5 ? 'excited' : 'confused', 30);
    this.dragLast = { x: this.pet.position.x, y: this.pet.position.y, t: Date.now() };
  }

  dragMove(x: number, y: number) {
    if (this.pet.activity !== 'dragged') return;
    const now = Date.now();
    const dt = Math.max(1, now - this.dragLast.t) / 1000;
    this.pet.velocity = { x: (x - this.dragLast.x) / dt, y: (y - this.dragLast.y) / dt };
    this.dragLast = { x, y, t: now };
    this.pet.position.x = clamp(x, 8, WORLD.width - 8);
    this.pet.position.y = clamp(y, 30, WORLD.floorY);
    if (Math.abs(this.pet.velocity.x) > 5) this.pet.facing = this.pet.velocity.x < 0 ? 'left' : 'right';
  }

  dragEnd() {
    if (this.pet.activity !== 'dragged') return;
    // A fling gets a little toss, never a launch: Blurb can't fly.
    this.pet.velocity = { x: clamp(this.pet.velocity.x * 0.4, -120, 120), y: clamp(this.pet.velocity.y * 0.3, -160, 0) };
    this.pet.emotionUntil = Date.now() + 2000;
    this.setActivity('falling');
    this.log('owner picked Blurb up and dropped it');
  }

  petStart() {
    const a = this.pet.activity;
    if (a === 'dragged' || a === 'falling') return;
    if (a === 'sleeping' && this.pet.needs.energy < 60) {
      this.setEmotion('love', 3);
      this.emit({ type: 'burst', kind: 'pet', x: this.pet.position.x, y: this.pet.position.y - 20 });
      return; // keep snoozing, but happily
    }
    this.pet.position.y = WORLD.floorY;
    this.pet.goal = undefined;
    this.setActivity('being_pet', 2.5);
    this.setEmotion('love', 4);
    this.emit({ type: 'burst', kind: 'pet', x: this.pet.position.x, y: this.pet.position.y - 20 });
    this.maybeSay('petted', {}, 'love');
  }

  petContinue() {
    if (this.pet.activity === 'being_pet') this.pet.activityTimer = Math.max(this.pet.activityTimer, 1.5);
  }

  giveTreat(treat: TreatKind, fromName: string, from: 'owner' | 'fan') {
    this.addServings(1);
    const bowl = this.world.objects.find((o) => o.kind === 'food_bowl');
    this.emit({ type: 'burst', kind: 'treat', x: (bowl?.x ?? 226) + 9, y: WORLD.floorY - 10 });
    this.log(`${from === 'owner' ? 'owner' : `visitor ${fromName}`} gave a ${treat.replace('_', ' ')}`);
    this.pet.needs.social = clamp(this.pet.needs.social - 8, 0, 100);
    if (this.pet.activity === 'sleeping') return;
    this.say(phrase('treat', this.rng, { name: fromName }), { emotion: 'excited', visibility: 'public', audience: from === 'fan' ? 'fan' : 'owner' });
    if (this.pet.mode === 'windowed' && this.pet.needs.fullness < 90 && this.pet.activity !== 'dragged' && bowl)
      this.requestUse(bowl.id, 'treat!');
  }

  triggerToy(toy: ToyKind, fromName: string) {
    const o = this.world.objects.find((x) => x.kind === toy);
    if (!o) return false;
    o.data = { ...o.data, bounce: 5 };
    this.log(`visitor ${fromName} played with the ${toy}`);
    this.pet.needs.social = clamp(this.pet.needs.social - 4, 0, 100);
    if (this.pet.mode === 'windowed' && this.pet.activity !== 'sleeping' && this.pet.activity !== 'dragged') {
      this.setEmotion('excited', 4);
      if (this.rng() < 0.7) this.requestUse(o.id, 'toy!');
    }
    return true;
  }

  /** Owner drops something straight into the world. */
  ownerPlace(kind: ObjectKind | `resource:${ResourceKind}`, x: number): WorldObject | null {
    if (kind.startsWith('resource:')) {
      const r = kind.split(':')[1] as ResourceKind;
      const o = this.addObject('resource', x, 'owner', { data: { resource: r }, color: RESOURCE_COLORS[r] });
      if (o) this.log(`owner dropped a ${r}`);
      return o;
    }
    const def = OBJECT_DEFS[kind as ObjectKind];
    if (!def || def.unique) return null;
    const o = this.addObject(kind as ObjectKind, x - def.width / 2, 'owner');
    if (o) {
      this.emit({ type: 'burst', kind: 'build', x: o.x + def.width / 2, y: WORLD.floorY - 10 });
      this.log(`owner placed a ${kind}`);
      this.setEmotion('excited', 3);
    }
    return o;
  }

  /** Owner puts something in the drop box for Blurb to collect. */
  addToDropBox(item: Omit<DropBoxItem, 'id' | 'addedAt'>) {
    const merged = this.dropBox.items.find((i) => i.kind === item.kind && i.resource === item.resource && i.objectKind === item.objectKind && i.from === item.from);
    if (merged) merged.count = Math.min(99, merged.count + item.count);
    else this.dropBox.items.push({ ...item, id: makeId('drop'), addedAt: Date.now() });
    this.syncBadges();
    this.log(`something new arrived in the drop box`);
  }

  ownerMoveObject(id: string, x: number) {
    const o = this.world.objects.find((v) => v.id === id);
    if (!o) return false;
    const def = OBJECT_DEFS[o.kind];
    const nx = clamp(Math.round(x - def.width / 2), 0, WORLD.width - def.width);
    o.x = nx;
    o.zone = zoneAt(nx + def.width / 2);
    return true;
  }

  ownerRecolor(id: string, color: string) {
    const o = this.world.objects.find((v) => v.id === id);
    if (!o) return false;
    o.color = color;
    return true;
  }

  ownerRemove(id: string) {
    const o = this.world.objects.find((v) => v.id === id);
    if (!o || OBJECT_DEFS[o.kind].unique) return false;
    this.removeObject(id);
    return true;
  }

  setSkin(skinId: string) {
    if (!this.dropBox.skins.some((s) => s.id === skinId)) return false;
    this.pet.appearance.skinId = skinId;
    this.emit({ type: 'burst', kind: 'magic', x: this.pet.position.x, y: this.pet.position.y - 20 });
    return true;
  }

  setShape(shapeId: string) {
    if (!this.dropBox.shapes.some((s) => s.id === shapeId)) return false;
    this.pet.appearance.shapeId = shapeId;
    this.emit({ type: 'burst', kind: 'magic', x: this.pet.position.x, y: this.pet.position.y - 20 });
    return true;
  }

  setMode(mode: 'windowed' | 'overlay') {
    if (this.pet.mode === mode) return;
    this.pet.mode = mode;
    this.pet.goal = undefined;
    if (mode === 'overlay') {
      this.setActivity('desktop_wander');
      this.log('slipped out onto the desktop');
    } else {
      delete this.pet.desktop;
      this.pet.position = { x: WORLD.doorX - 14, y: WORLD.floorY };
      this.pet.facing = 'left';
      this.setActivity('idle', 1);
      this.gesture('wave', 2);
      this.log('came back home');
    }
  }
}
