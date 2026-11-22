/**
 * WorldRenderer — draws a PublicState-shaped view into a canvas.
 * Used by the desktop window AND the fan viewer, so both see the same world.
 *
 * The world is drawn at its native 480x270 into an offscreen buffer, then
 * scaled up nearest-neighbor. Text (speech bubbles, labels) is drawn at
 * display resolution afterwards so it stays crisp.
 */
import { WORLD, type ObjectKind, type PublicObject, type PublicState } from '@blurb/shared';
import { OBJECT_DRAWERS, objectBounds, objectZ, type ObjectDrawInfo } from './objects.js';
import { drawPet, makeCanvas, type PetLook } from './pet.js';
import { Emitter, Particles } from './particles.js';
import type { Ctx } from './pixel.js';
import { rect } from './pixel.js';
import { drawBackdrop, drawNightShade, nightFactor } from './scene.js';

export interface RenderOptions {
  /** Object under the cursor, gets a soft outline. */
  hoverId?: string;
  /** Owner is dragging something in: draw a ghost preview. */
  ghost?: { kind: ObjectKind; x: number; color?: string };
  /** Local override while the owner drags Blurb (avoids IPC latency). */
  petOverride?: { x: number; y: number };
  showName?: boolean;
  /** Extra label for the "out on the desktop" postcard. */
  outLabel?: string;
  /** Text bubble placeholder while waiting for first token. */
}

const OUT_LABELS: Record<string, string> = {
  wandering: 'strolling along the taskbar',
  perched: 'perched on top of a window',
  playing_chase: 'chasing the cursor',
  napping: 'napping in a corner',
};

export class WorldRenderer {
  readonly world = makeCanvas(WORLD.width, WORLD.height);
  private wctx = this.world.getContext('2d') as Ctx;
  private ctx: CanvasRenderingContext2D;
  private state?: PublicState;
  private stateAt = 0;
  private petX = 0;
  private petY = 0;
  private lastFrame = 0;
  private particles = new Particles();
  private emitter = new Emitter(this.particles);
  private lastEmotion = '';
  private petBody = { x: 0, y: 0, w: 0, h: 0 };
  readonly seed = Math.random() * 10;
  scale = 2;
  offX = 0;
  offY = 0;
  private dpr = 1;

  constructor(private canvas: HTMLCanvasElement) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('2D canvas not available');
    this.ctx = c;
  }

  setState(s: PublicState) {
    const first = !this.state;
    if (this.state && s.pet.emotion !== this.state.pet.emotion) this.onEmotionChange(s.pet.emotion);
    this.state = s;
    this.stateAt = performance.now();
    if (first) {
      this.petX = s.pet.x;
      this.petY = s.pet.y;
    }
  }

  getState() {
    return this.state;
  }

  /** Call when the element's CSS size changes. */
  resize(cssW: number, cssH: number, dpr = globalThis.devicePixelRatio || 1) {
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cssW * dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * dpr));
    const s = Math.min(this.canvas.width / WORLD.width, this.canvas.height / WORLD.height);
    const si = Math.floor(s);
    this.scale = si >= 2 && si / s > 0.82 ? si : s;
    this.offX = Math.round((this.canvas.width - WORLD.width * this.scale) / 2);
    this.offY = Math.round((this.canvas.height - WORLD.height * this.scale) / 2);
  }

  /** CSS-pixel point (relative to the canvas) → world coords. */
  toWorld(cssX: number, cssY: number) {
    return {
      x: (cssX * this.dpr - this.offX) / this.scale,
      y: (cssY * this.dpr - this.offY) / this.scale,
    };
  }

  hitPet(wx: number, wy: number): boolean {
    const b = this.petBody;
    return wx >= b.x - 2 && wx <= b.x + b.w + 2 && wy >= b.y - 2 && wy <= b.y + b.h + 2;
  }

  hitObject(wx: number, wy: number): PublicObject | undefined {
    if (!this.state) return undefined;
    const sorted = [...this.state.objects].sort((a, b) => objectZ(b.k) - objectZ(a.k));
    return sorted.find((o) => {
      if (o.k === 'rug') return false;
      const r = objectBounds(o);
      return wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h;
    });
  }

  private onEmotionChange(emotion: string) {
    const hx = this.petX;
    const hy = this.petY - 26;
    if (emotion === 'love') this.particles.spawn('heart', hx, hy, '#ff5c8a', 3);
    if (emotion === 'excited') this.particles.spawn('star', hx, hy, '#fff3a0', 5);
    if (emotion === 'confused') this.particles.spawn('question', hx + 8, hy - 6, '#ffffff');
  }

  /** Burst effects triggered by the host (treat arrives, item built…). */
  burst(kind: 'treat' | 'build' | 'pet' | 'magic', x?: number, y?: number) {
    const px = x ?? this.petX;
    const py = y ?? this.petY - 20;
    if (kind === 'treat') this.particles.spawn('sparkle', px, py, '#ffe066', 8);
    if (kind === 'build') this.particles.spawn('star', px, py, '#ffffff', 10);
    if (kind === 'pet') this.particles.spawn('heart', px, py, '#ff5c8a', 2);
    if (kind === 'magic') this.particles.spawn('sparkle', px, py, '#c3a6f0', 14);
  }

  frame(now: number, opts: RenderOptions = {}) {
    const t = now / 1000;
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0.016;
    this.lastFrame = now;
    const s = this.state;
    const w = this.wctx;
    w.imageSmoothingEnabled = false;
    w.clearRect(0, 0, WORLD.width, WORLD.height);
    const hour = s?.timeOfDay ?? 12;
    drawBackdrop(w, hour, t);

    const night = nightFactor(hour);
    const info: ObjectDrawInfo = { t, night, hoverId: opts.hoverId };
    const objects = s ? [...s.objects].sort((a, b) => objectZ(a.k) - objectZ(b.k) || a.x - b.x) : [];

    // Which object is Blurb using? (nearest interactive object while busy)
    if (s && s.pet.where === 'home' && !['idle', 'walking', 'dragged', 'falling', 'being_pet', 'chatting'].includes(s.pet.activity)) {
      let best: PublicObject | undefined;
      let bd = 40;
      for (const o of objects) {
        const b = objectBounds(o);
        const d = Math.abs(b.x + b.w / 2 - s.pet.x);
        if (d < bd) (bd = d), (best = o);
      }
      info.activeId = best?.id;
    }

    for (const o of objects) OBJECT_DRAWERS[o.k](w, o, info);

    if (opts.hoverId) {
      const o = objects.find((x) => x.id === opts.hoverId);
      if (o) {
        const b = objectBounds(o);
        w.strokeStyle = 'rgba(255,255,255,0.8)';
        w.setLineDash([2, 2]);
        w.lineWidth = 1;
        w.strokeRect(b.x - 1.5, b.y - 1.5, b.w + 3, b.h + 3);
        w.setLineDash([]);
      }
    }
    if (opts.ghost) {
      w.globalAlpha = 0.55;
      OBJECT_DRAWERS[opts.ghost.kind](w, { id: 'ghost', k: opts.ghost.kind, x: Math.round(opts.ghost.x), c: opts.ghost.color ?? '#ffffff' }, info);
      w.globalAlpha = 1;
    }

    // ---- pet ----
    let bubbleAnchor: { x: number; y: number } | null = null;
    if (s) {
      const p = s.pet;
      const look: PetLook = {
        activity: p.activity,
        emotion: p.emotion,
        gesture: p.gesture,
        facing: p.facing,
        palette: p.palette,
        shape: p.shape,
        vx: p.vx,
      };
      if (p.where === 'home') {
        // Smooth toward the authoritative position, extrapolating with velocity.
        const since = Math.min(0.25, (now - this.stateAt) / 1000);
        const tx = opts.petOverride?.x ?? p.x + p.vx * since;
        const ty = opts.petOverride?.y ?? p.y;
        const k = opts.petOverride ? 1 : Math.min(1, dt * 14);
        this.petX += (tx - this.petX) * k;
        this.petY += (ty - this.petY) * k;
        if (Math.abs(tx - this.petX) > 80) (this.petX = tx), (this.petY = ty);
        const drawn = drawPet(w, look, Math.round(this.petX), Math.round(this.petY), t, 1, this.seed);
        this.petBody = drawn.body;
        bubbleAnchor = { x: drawn.body.x + drawn.body.w / 2, y: drawn.body.y };
        this.emitter.tick(dt, p.activity, p.emotion, drawn.body.x + drawn.body.w / 2, drawn.body.y, drawn.body.y + drawn.body.h * 0.6);
      } else {
        this.petBody = { x: -999, y: -999, w: 0, h: 0 };
        bubbleAnchor = this.drawPostcard(w, look, t);
      }
      if (p.emotion !== this.lastEmotion) this.lastEmotion = p.emotion;
    }

    drawNightShade(w, hour, objects.filter((o) => o.k === 'lamp').map((o) => o.x));
    this.particles.update(dt);
    this.particles.draw(w);

    // ---- compose to display ----
    const c = this.ctx;
    c.imageSmoothingEnabled = false;
    c.fillStyle = '#0d0a12';
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    c.drawImage(this.world as CanvasImageSource, this.offX, this.offY, WORLD.width * this.scale, WORLD.height * this.scale);

    if (s && bubbleAnchor) {
      const ax = this.offX + bubbleAnchor.x * this.scale;
      const ay = this.offY + bubbleAnchor.y * this.scale;
      if (s.pet.where === 'out') {
        drawLabel(c, `${s.pet.name} is out on the desktop — ${opts.outLabel ?? OUT_LABELS[s.pet.activity] ?? 'exploring'}`, ax, ay - 6 * this.dpr, this.dpr);
      } else if (opts.showName) {
        drawLabel(c, s.pet.name, ax, this.offY + (this.petBody.y + this.petBody.h + 8) * this.scale, this.dpr, true);
      }
      if (s.pet.speech?.text || s.pet.speech?.streaming) {
        drawBubble(c, s.pet.speech.text || '…', ax, ay - 4 * this.dpr, this.canvas.width, this.dpr, !!s.pet.speech.streaming);
      }
    }
  }

  /** While Blurb is out on the owner's desktop, show an abstract postcard. */
  private drawPostcard(w: Ctx, look: PetLook, t: number) {
    const x = 322;
    const y = 96;
    const pw = 136;
    const ph = 84;
    rect(w, x - 2, y - 2, pw + 4, ph + 4, '#2a1f3a');
    rect(w, x, y, pw, ph, '#f4efe6');
    // a generic, made-up desktop — nothing from the real screen
    for (let i = 0; i < 8; i++) rect(w, x + 4, y + 4 + i * 8, pw - 8, 8, i % 2 ? '#3d6fb6' : '#4479c2');
    rect(w, x + 14, y + 14, 50, 32, '#e9e4d8');
    rect(w, x + 14, y + 14, 50, 5, '#9aa6b8');
    rect(w, x + 72, y + 24, 52, 28, '#e9e4d8');
    rect(w, x + 72, y + 24, 52, 5, '#b89ac8');
    rect(w, x + 4, y + ph - 12, pw - 8, 8, '#1e2433');
    let px = x + pw / 2;
    let py = y + ph - 12;
    if (look.activity === 'perched') (px = x + 98), (py = y + 24);
    else if (look.activity === 'napping') (px = x + pw - 22), (py = y + ph - 12);
    else if (look.activity === 'playing_chase') {
      px = x + 30 + ((t * 30) % (pw - 60));
      const cx = px + 18;
      rect(w, cx, py - 10, 1, 5, '#ffffff');
      rect(w, cx, py - 10, 3, 3, '#ffffff');
    } else px = x + 20 + ((t * 12) % (pw - 40));
    const drawn = drawPet(w, { ...look, facing: 'r', vx: 20 }, px, py, t, 1, this.seed);
    return { x: drawn.body.x + drawn.body.w / 2, y: Math.min(drawn.body.y, y) };
  }
}

// ---------------------------------------------------------------------------
// Display-resolution text
// ---------------------------------------------------------------------------

const FONT = 'ui-rounded, "SF Pro Rounded", "Nunito", system-ui, sans-serif';

function wrap(c: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (c.measureText(test).width > maxW && line) {
      lines.push(line);
      line = word;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines.slice(0, 6);
}

export function drawBubble(
  c: CanvasRenderingContext2D,
  text: string,
  ax: number,
  ay: number,
  canvasW: number,
  dpr: number,
  streaming = false,
) {
  const fs = 14 * dpr;
  c.font = `600 ${fs}px ${FONT}`;
  const pad = 10 * dpr;
  const maxW = Math.min(300 * dpr, canvasW * 0.6);
  const lines = wrap(c, streaming ? `${text}▍` : text, maxW);
  const lh = fs * 1.3;
  const bw = Math.max(...lines.map((l) => c.measureText(l).width)) + pad * 2;
  const bh = lines.length * lh + pad * 1.4;
  let bx = ax - bw / 2;
  bx = Math.max(8 * dpr, Math.min(canvasW - bw - 8 * dpr, bx));
  const by = Math.max(4 * dpr, ay - bh - 12 * dpr);
  const r = 10 * dpr;
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.35)';
  c.shadowBlur = 6 * dpr;
  c.fillStyle = '#fffaf2';
  c.strokeStyle = '#2a1f3a';
  c.lineWidth = 2.5 * dpr;
  c.beginPath();
  c.roundRect(bx, by, bw, bh, r);
  c.fill();
  c.shadowBlur = 0;
  c.stroke();
  // tail
  const tx = Math.max(bx + r * 1.5, Math.min(bx + bw - r * 1.5, ax));
  c.beginPath();
  c.moveTo(tx - 7 * dpr, by + bh - 1);
  c.lineTo(tx, by + bh + 10 * dpr);
  c.lineTo(tx + 7 * dpr, by + bh - 1);
  c.closePath();
  c.fill();
  c.stroke();
  c.fillRect(tx - 6 * dpr, by + bh - 3 * dpr, 12 * dpr, 4 * dpr);
  c.fillStyle = '#2a1f3a';
  c.textBaseline = 'top';
  lines.forEach((l, i) => c.fillText(l, bx + pad, by + pad * 0.7 + i * lh));
  c.restore();
}

function drawLabel(c: CanvasRenderingContext2D, text: string, x: number, y: number, dpr: number, small = false) {
  c.save();
  c.font = `700 ${(small ? 11 : 12) * dpr}px ${FONT}`;
  const w = c.measureText(text).width + 12 * dpr;
  const h = (small ? 16 : 20) * dpr;
  const bx = Math.max(4 * dpr, x - w / 2);
  c.fillStyle = 'rgba(20,14,30,0.78)';
  c.beginPath();
  c.roundRect(bx, y - h, w, h, h / 2);
  c.fill();
  c.fillStyle = '#ffffff';
  c.textBaseline = 'middle';
  c.fillText(text, bx + 6 * dpr, y - h / 2);
  c.restore();
}
