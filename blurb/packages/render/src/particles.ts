/** Tiny pixel particles: z's, hearts, question marks, sparkles, crumbs, code. */
import type { Ctx } from './pixel.js';
import { dot, rect } from './pixel.js';

export type ParticleKind = 'z' | 'heart' | 'question' | 'dots' | 'sparkle' | 'crumb' | 'code' | 'leaf' | 'note' | 'star';

interface Particle {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
}

const GLYPHS: Partial<Record<ParticleKind, string[]>> = {
  z: ['###', '..#', '.#.', '#..', '###'],
  heart: ['#.#.', '####', '####', '.##.'],
  question: ['.##.', '#..#', '..#.', '.#..', '....', '.#..'],
  note: ['.##', '.#.', '.#.', '##.', '##.'],
  star: ['.#.', '###', '.#.'],
  code: ['.#...#.', '#..#..#', '.#.#.#.'],
};

export class Particles {
  private list: Particle[] = [];

  spawn(kind: ParticleKind, x: number, y: number, color = '#ffffff', n = 1) {
    for (let i = 0; i < n; i++) {
      const r = Math.random();
      const p: Particle = { kind, x, y, vx: 0, vy: -8, life: 0, max: 2, color };
      switch (kind) {
        case 'z':
          Object.assign(p, { vx: 4 + r * 3, vy: -7, max: 2.6 });
          break;
        case 'heart':
          Object.assign(p, { vx: (r - 0.5) * 14, vy: -14, max: 1.4 });
          break;
        case 'sparkle':
        case 'star':
          Object.assign(p, { vx: (r - 0.5) * 30, vy: -10 - r * 14, max: 0.8 });
          break;
        case 'crumb':
          Object.assign(p, { vx: (r - 0.5) * 24, vy: -18, max: 0.7 });
          break;
        case 'leaf':
          Object.assign(p, { vx: (r - 0.5) * 10, vy: 6 + r * 4, max: 2.2 });
          break;
        case 'question':
        case 'dots':
          Object.assign(p, { vx: 0, vy: -4, max: 1.8 });
          break;
        case 'code':
        case 'note':
          Object.assign(p, { vx: (r - 0.5) * 6, vy: -9, max: 1.6 });
          break;
      }
      this.list.push(p);
    }
    if (this.list.length > 120) this.list.splice(0, this.list.length - 120);
  }

  update(dt: number) {
    for (const p of this.list) {
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === 'crumb') p.vy += 60 * dt;
      if (p.kind === 'leaf') p.vx = Math.sin(p.life * 4) * 8;
      if (p.kind === 'z') p.vx *= 0.98;
    }
    this.list = this.list.filter((p) => p.life < p.max);
  }

  draw(ctx: Ctx) {
    for (const p of this.list) {
      const a = 1 - p.life / p.max;
      ctx.globalAlpha = Math.max(0, Math.min(1, a * 1.5));
      const g = GLYPHS[p.kind];
      if (g) {
        g.forEach((row, ry) => {
          for (let rx = 0; rx < row.length; rx++) if (row[rx] === '#') dot(ctx, p.x + rx, p.y + ry, p.color);
        });
      } else if (p.kind === 'dots') {
        const n = 1 + (Math.floor(p.life * 4) % 3);
        for (let i = 0; i < n; i++) rect(ctx, p.x + i * 3, p.y, 2, 2, p.color);
      } else if (p.kind === 'leaf') {
        rect(ctx, p.x, p.y, 2, 1, p.color);
        dot(ctx, p.x + 1, p.y + 1, p.color);
      } else {
        rect(ctx, p.x, p.y, 1, 1, p.color);
      }
    }
    ctx.globalAlpha = 1;
  }

  clear() {
    this.list = [];
  }
}

/** Ambient particle emission for an activity/emotion, called each frame. */
export class Emitter {
  private acc = new Map<string, number>();
  constructor(private particles: Particles) {}

  tick(dt: number, activity: string, emotion: string, headX: number, headY: number, mouthY: number) {
    const every = (key: string, sec: number, fn: () => void) => {
      const v = (this.acc.get(key) ?? 0) + dt;
      if (v >= sec) {
        fn();
        this.acc.set(key, 0);
      } else this.acc.set(key, v);
    };
    const asleep = activity === 'sleeping' || activity === 'desktop_nap' || activity === 'napping';
    if (asleep) every('z', 1.1, () => this.particles.spawn('z', headX + 6, headY - 2, '#e8f0ff'));
    else if (emotion === 'love' || activity === 'being_pet')
      every('heart', 0.45, () => this.particles.spawn('heart', headX - 2 + Math.random() * 8, headY - 2, '#ff5c8a'));
    else if (emotion === 'confused') every('q', 2.2, () => this.particles.spawn('question', headX + 8, headY - 8, '#ffffff'));
    else if (emotion === 'thinking' && activity !== 'coding') every('dots', 2, () => this.particles.spawn('dots', headX + 8, headY - 6, '#ffffff'));
    else if (emotion === 'excited') every('sp', 0.35, () => this.particles.spawn('star', headX + (Math.random() - 0.5) * 24, headY, '#fff3a0'));
    if (activity === 'eating') every('crumb', 0.25, () => this.particles.spawn('crumb', headX, mouthY, '#d98b3a', 2));
    if (activity === 'coding') every('code', 0.9, () => this.particles.spawn('code', headX - 4, headY - 4, '#5ef38c'));
    if (activity === 'foraging') every('leaf', 0.3, () => this.particles.spawn('leaf', headX + (Math.random() - 0.5) * 30, headY - 30, '#5cb85c'));
    if (activity === 'building') every('spark', 0.4, () => this.particles.spawn('sparkle', headX + 10, headY + 6, '#ffe066', 3));
    if (activity === 'playing') every('note', 1.2, () => this.particles.spawn('note', headX + 10, headY - 6, '#ffffff'));
  }
}
