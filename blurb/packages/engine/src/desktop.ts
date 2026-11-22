/**
 * DesktopSim — Blurb's behavior while the main window is minimized and it is
 * out on the owner's real desktop (overlay mode).
 *
 * Works purely on geometry the host hands it: display work areas, a list of
 * window RECTANGLES (ids only — titles are dropped before they get here), and
 * the cursor position. It cannot read, click, type, or open anything: there
 * is no API surface for that in this class or the overlay window.
 *
 * Physics rule from the brief: no flying. Blurb walks, hops, falls, and —
 * being a sticky blob — can climb the side of a window to sit on top of it.
 */
import type { CapabilitySet, PetState, Rect, Vec2 } from '@blurb/shared';
import { phrase } from './brain.js';
import type { PetSim } from './sim.js';

export interface DisplayInfo {
  id: number;
  bounds: Rect;
  workArea: Rect;
}

export interface WindowInfo {
  /** Opaque id. Never a title. */
  id: string;
  bounds: Rect;
}

export interface DesktopEnv {
  displays: DisplayInfo[];
  /** Visible top-level windows, front to back. May be just the active one. */
  windows: WindowInfo[];
  cursor: Vec2;
}

type Mode = 'enter' | 'wander' | 'climb' | 'sit' | 'chase' | 'nap' | 'fall' | 'dragged' | 'petted';

const GRAVITY = 1800;
const bottom = (r: Rect) => r.y + r.height;
const right = (r: Rect) => r.x + r.width;

export class DesktopSim {
  /** Integer sprite upscale on the desktop. */
  scale = 3;
  mode: Mode = 'enter';
  private timer = 0;
  private dir: 1 | -1 = -1;
  private target?: { windowId: string; side: 'l' | 'r'; offset: number };
  private sitOffset = 0;
  private nagTimer = 30;
  private dragVel: Vec2 = { x: 0, y: 0 };
  private dragLast?: { x: number; y: number; t: number };
  private lastEnv?: DesktopEnv;

  constructor(private sim: PetSim) {}

  get caps(): CapabilitySet {
    return this.sim.capabilities;
  }

  private get pet(): PetState {
    return this.sim.pet;
  }

  private get pos(): Vec2 {
    if (!this.pet.desktop) this.pet.desktop = { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, surface: 'air' };
    return this.pet.desktop.position;
  }

  /** Pixel size of the body on screen (approx, for edge math). */
  get bodyW() {
    // Use the shape Blurb is actually wearing (designed shapes can be wider).
    return (this.sim.look().shape.width + 10) * this.scale;
  }

  displayAt(env: DesktopEnv, x: number, y?: number): DisplayInfo | undefined {
    return (
      env.displays.find((d) => x >= d.bounds.x && x < right(d.bounds) && (y === undefined || (y >= d.bounds.y && y <= bottom(d.bounds)))) ??
      env.displays.find((d) => x >= d.bounds.x && x < right(d.bounds)) ??
      env.displays[0]
    );
  }

  groundAt(env: DesktopEnv, x: number): number {
    const d = this.displayAt(env, x);
    return d ? bottom(d.workArea) : 800;
  }

  /** Called when the main window minimizes. */
  enter(env: DesktopEnv) {
    const d = env.displays[0];
    if (!d) return;
    this.pet.desktop = {
      position: { x: right(d.workArea) - 160, y: bottom(d.workArea) },
      velocity: { x: 0, y: 0 },
      surface: 'taskbar',
      displayId: d.id,
    };
    this.mode = 'enter';
    this.timer = 2.2;
    this.sim.gesture('wave', 2.2);
    this.sim.say(phrase('hello_desktop', this.sim.rng), { emotion: 'excited', visibility: 'private', audience: 'owner' });
  }

  private setMode(m: Mode, timer: number, activity: PetState['activity']) {
    this.mode = m;
    this.timer = timer;
    this.pet.activity = activity;
  }

  private choose(env: DesktopEnv) {
    const n = this.pet.needs;
    const r = this.sim.rng;
    const opts: Array<[Mode, number]> = [];
    if (!this.caps.desktop_explore) {
      opts.push(['nap', 100]);
    } else {
      opts.push(['wander', 30 + r() * 20]);
      opts.push(['nap', n.energy < 35 ? 90 : n.energy < 60 ? 15 : 2]);
      if (this.caps.chase_cursor) opts.push(['chase', n.boredom * 0.6 + r() * 25]);
      if (this.caps.sit_on_windows && this.pickWindow(env)) opts.push(['climb', 25 + n.curiosity * 0.35 + r() * 20]);
    }
    opts.sort((a, b) => b[1] - a[1]);
    const m = opts[0][0];
    if (m === 'wander') {
      this.dir = r() < 0.5 ? -1 : 1;
      this.setMode('wander', 5 + r() * 8, 'desktop_wander');
    } else if (m === 'nap') {
      this.setMode('nap', 40 + r() * 60, 'desktop_wander');
    } else if (m === 'chase') {
      this.setMode('chase', 8 + r() * 8, 'desktop_chase_cursor');
    } else if (m === 'climb') {
      const w = this.pickWindow(env)!;
      const side: 'l' | 'r' = Math.abs(w.bounds.x - this.pos.x) < Math.abs(right(w.bounds) - this.pos.x) ? 'l' : 'r';
      this.target = { windowId: w.id, side, offset: 0 };
      this.setMode('climb', 40, 'desktop_wander');
    }
  }

  /** A window wide enough, fully on a display, with its top below the screen top. */
  private pickWindow(env: DesktopEnv): WindowInfo | undefined {
    return env.windows.find((w) => {
      const d = this.displayAt(env, w.bounds.x + w.bounds.width / 2, w.bounds.y + 5);
      if (!d) return false;
      const topOk = w.bounds.y > d.workArea.y + 30 * this.scale && w.bounds.y < bottom(d.workArea) - 60;
      return w.bounds.width > this.bodyW * 2 && topOk;
    });
  }

  step(dt: number, env: DesktopEnv) {
    if (!env.displays.length) return;
    this.lastEnv = env;
    const p = this.pos;
    const ground = this.groundAt(env, p.x);
    const sim = this.sim;
    const r = sim.rng;
    this.timer -= dt;

    // gentle nagging when needs are low (private: it's for the owner only)
    this.nagTimer -= dt;
    if (this.nagTimer <= 0) {
      this.nagTimer = 180;
      if (this.pet.needs.fullness < 25) sim.say(phrase('hungry_desktop', r), { emotion: 'sad', visibility: 'private', audience: 'owner' });
    }

    const walk = (speed: number, bounds?: { min: number; max: number }) => {
      p.x += this.dir * speed * dt;
      this.pet.facing = this.dir < 0 ? 'left' : 'right';
      const d = this.displayAt(env, p.x);
      const minX = bounds?.min ?? Math.min(...env.displays.map((x) => x.workArea.x)) + this.bodyW / 2;
      const maxX = bounds?.max ?? Math.max(...env.displays.map((x) => right(x.workArea))) - this.bodyW / 2;
      if (p.x < minX) (p.x = minX), (this.dir = 1);
      if (p.x > maxX) (p.x = maxX), (this.dir = -1);
      return d;
    };

    switch (this.mode) {
      case 'enter':
        p.y = ground;
        if (this.timer <= 0) this.choose(env);
        break;

      case 'wander': {
        this.pet.activity = 'desktop_wander';
        walk(60);
        p.y = this.groundAt(env, p.x);
        if (r() < dt * 0.15) this.dir = this.dir === 1 ? -1 : 1;
        if (this.timer <= 0) this.choose(env);
        break;
      }

      case 'chase': {
        this.pet.activity = 'desktop_chase_cursor';
        const dx = env.cursor.x - p.x;
        if (Math.abs(dx) > 30) {
          this.dir = dx < 0 ? -1 : 1;
          walk(170);
        } else if (r() < dt * 1.5) {
          sim.gesture('hop', 0.8);
          sim.setEmotion('excited', 2);
        }
        p.y = this.onSurfaceY(env) ?? this.groundAt(env, p.x);
        sim.pet.needs.boredom = Math.max(0, sim.pet.needs.boredom - 3 * dt);
        if (this.timer <= 0) this.choose(env);
        break;
      }

      case 'nap': {
        const d = this.displayAt(env, p.x)!;
        const corner = p.x < d.workArea.x + d.workArea.width / 2 ? d.workArea.x + this.bodyW : right(d.workArea) - this.bodyW;
        if (Math.abs(corner - p.x) > 6) {
          this.pet.activity = 'desktop_wander';
          this.dir = corner < p.x ? -1 : 1;
          walk(60);
          p.y = this.groundAt(env, p.x);
        } else {
          this.pet.activity = 'desktop_nap';
          if (this.timer <= 0 || this.pet.needs.energy > 95) this.choose(env);
        }
        break;
      }

      case 'climb': {
        const w = env.windows.find((x) => x.id === this.target?.windowId);
        if (!w) {
          this.target = undefined;
          this.choose(env);
          break;
        }
        const edgeX = this.target!.side === 'l' ? w.bounds.x - this.bodyW * 0.3 : right(w.bounds) + this.bodyW * 0.3;
        if (Math.abs(edgeX - p.x) > 4 && p.y >= this.groundAt(env, p.x) - 1) {
          // walk over to the window's side
          this.pet.activity = 'desktop_wander';
          this.dir = edgeX < p.x ? -1 : 1;
          walk(80);
          p.y = this.groundAt(env, p.x);
        } else {
          // climb (sticky blob!)
          p.x = edgeX;
          this.pet.activity = 'desktop_wander';
          this.pet.facing = this.target!.side === 'l' ? 'right' : 'left';
          p.y -= 70 * dt;
          if (p.y <= w.bounds.y) {
            const inward = this.target!.side === 'l' ? this.bodyW * 0.8 : -this.bodyW * 0.8;
            this.sitOffset = edgeX + inward - w.bounds.x;
            p.y = w.bounds.y;
            p.x = w.bounds.x + this.sitOffset;
            this.pet.desktop!.windowId = w.id;
            this.pet.desktop!.surface = 'window';
            this.setMode('sit', 15 + r() * 30, 'desktop_window_sit');
          }
          if (this.timer <= 0) this.startFall();
        }
        break;
      }

      case 'sit': {
        const w = env.windows.find((x) => x.id === this.pet.desktop?.windowId);
        if (!w) {
          this.startFall();
          break;
        }
        // ride along if the window moves
        p.x = w.bounds.x + Math.min(Math.max(this.sitOffset, this.bodyW / 2), w.bounds.width - this.bodyW / 2);
        p.y = w.bounds.y;
        this.pet.activity = 'desktop_window_sit';
        if (this.timer <= 0) {
          // hop down: walk off the edge
          this.dir = this.sitOffset < w.bounds.width / 2 ? -1 : 1;
          this.sitOffset += this.dir * 60 * dt;
          if (this.sitOffset < 0 || this.sitOffset > w.bounds.width) this.startFall();
        }
        break;
      }

      case 'fall': {
        const d = this.pet.desktop!;
        d.velocity.y += GRAVITY * dt;
        const prevY = p.y;
        p.x += d.velocity.x * dt;
        p.y += d.velocity.y * dt;
        d.velocity.x *= 0.98;
        const minX = Math.min(...env.displays.map((x) => x.workArea.x)) + this.bodyW / 2;
        const maxX = Math.max(...env.displays.map((x) => right(x.workArea))) - this.bodyW / 2;
        p.x = Math.min(maxX, Math.max(minX, p.x));
        // land on a window top we crossed?
        const landing = env.windows.find(
          (w) => p.x > w.bounds.x + 10 && p.x < right(w.bounds) - 10 && prevY <= w.bounds.y && p.y >= w.bounds.y,
        );
        const g = this.groundAt(env, p.x);
        if (landing && this.caps.sit_on_windows) {
          p.y = landing.bounds.y;
          d.windowId = landing.id;
          d.surface = 'window';
          this.sitOffset = p.x - landing.bounds.x;
          d.velocity = { x: 0, y: 0 };
          this.setMode('sit', 10 + r() * 20, 'desktop_window_sit');
          sim.setEmotion('excited', 2);
        } else if (p.y >= g) {
          p.y = g;
          d.surface = 'taskbar';
          d.windowId = undefined;
          d.velocity = { x: 0, y: 0 };
          sim.gesture('hop', 0.6);
          this.setMode('wander', 2 + r() * 3, 'desktop_wander');
        }
        break;
      }

      case 'dragged':
        this.pet.activity = 'dragged';
        break;

      case 'petted':
        this.pet.activity = 'being_pet';
        sim.pet.needs.social = Math.max(0, sim.pet.needs.social - 6 * dt);
        if (this.timer <= 0) this.setMode('wander', 3, 'desktop_wander');
        break;
    }
    if (this.pet.desktop) this.pet.desktop.displayId = this.displayAt(env, p.x)?.id;
  }

  /** y of the surface Blurb is on, if it is sitting on a window. */
  private onSurfaceY(env: DesktopEnv): number | undefined {
    const w = env.windows.find((x) => x.id === this.pet.desktop?.windowId);
    if (!w || this.pet.desktop?.surface !== 'window') return undefined;
    if (this.pos.x < w.bounds.x || this.pos.x > right(w.bounds)) {
      this.startFall();
      return undefined;
    }
    return w.bounds.y;
  }

  private startFall() {
    const d = this.pet.desktop!;
    d.surface = 'air';
    d.windowId = undefined;
    d.velocity = { x: this.dir * 40, y: -120 };
    this.mode = 'fall';
    this.pet.activity = 'falling';
  }

  // ---- owner interactions in overlay ----

  dragStart() {
    this.mode = 'dragged';
    this.pet.activity = 'dragged';
    this.sim.setEmotion(this.sim.rng() < 0.5 ? 'excited' : 'confused', 30);
    this.dragLast = undefined;
  }

  /** Global screen coords of the sprite's feet. */
  dragMove(x: number, y: number) {
    if (this.mode !== 'dragged') return;
    const now = Date.now();
    if (this.dragLast) {
      const dt = Math.max(1, now - this.dragLast.t) / 1000;
      this.dragVel = { x: (x - this.dragLast.x) / dt, y: (y - this.dragLast.y) / dt };
    }
    this.dragLast = { x, y, t: now };
    this.pos.x = x;
    this.pos.y = y;
    if (Math.abs(this.dragVel.x) > 20) this.pet.facing = this.dragVel.x < 0 ? 'left' : 'right';
  }

  dragEnd() {
    if (this.mode !== 'dragged') return;
    this.startFall();
    this.pet.desktop!.velocity = { x: Math.max(-400, Math.min(400, this.dragVel.x * 0.4)), y: Math.min(0, this.dragVel.y * 0.3) };
    this.sim.pet.emotionUntil = Date.now() + 1500;
  }

  petStart() {
    this.mode = 'petted';
    this.timer = 2.5;
    this.sim.setEmotion('love', 4);
  }

  /** For tests/inspection. */
  get env() {
    return this.lastEnv;
  }
}
