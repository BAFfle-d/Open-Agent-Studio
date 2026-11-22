/** The house + yard backdrop, with a real-time day/night cycle. */
import { WORLD, hexToRgb, rgbToHex } from '@blurb/shared';
import { type Ctx, dark, disc, dot, ellipse, hash01, light, rect } from './pixel.js';

const { width: W, height: H, floorY: FLOOR, ceilingY: CEIL, doorX: DOOR } = WORLD;

type Key = [hour: number, top: string, bottom: string];
const SKY: Key[] = [
  [0, '#0a0f2c', '#1a2350'],
  [4.5, '#0d1335', '#25306a'],
  [6, '#f28a6a', '#ffd6a0'],
  [7.5, '#78c8f8', '#cdeeff'],
  [16.5, '#6ec0f8', '#d2f0ff'],
  [18.5, '#ff8a65', '#ffd180'],
  [20, '#3b2a6a', '#b06a8a'],
  [21.5, '#0d1335', '#25306a'],
  [24, '#0a0f2c', '#1a2350'],
];

function lerpHex(a: string, b: string, t: number) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}

export function skyColors(hour: number): [string, string] {
  const h = ((hour % 24) + 24) % 24;
  for (let i = 0; i < SKY.length - 1; i++) {
    const [h0, t0, b0] = SKY[i];
    const [h1, t1, b1] = SKY[i + 1];
    if (h >= h0 && h <= h1) {
      const t = (h - h0) / (h1 - h0 || 1);
      return [lerpHex(t0, t1, t), lerpHex(b0, b1, t)];
    }
  }
  return [SKY[0][1], SKY[0][2]];
}

/** 0 = full day, 1 = full night. */
export function nightFactor(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  if (h < 4.5 || h >= 21) return 1;
  if (h < 6.5) return 1 - (h - 4.5) / 2;
  if (h < 18.5) return 0;
  return (h - 18.5) / 2.5;
}

function drawSky(ctx: Ctx, x: number, y: number, w: number, h: number, hour: number, t: number) {
  const [top, bottom] = skyColors(hour);
  const bands = 12;
  for (let i = 0; i < bands; i++) {
    rect(ctx, x, y + (h * i) / bands, w, h / bands + 1, lerpHex(top, bottom, i / (bands - 1)));
  }
  const night = nightFactor(hour);
  if (night > 0.3) {
    for (let i = 0; i < 40; i++) {
      const sx = hash01(i * 3.3) * W;
      const sy = hash01(i * 7.1) * (FLOOR - 40);
      if (sx < x || sx > x + w || sy < y || sy > y + h) continue;
      const tw = Math.sin(t * 2 + i) > 0.6 ? 1 : 0.6;
      ctx.globalAlpha = (night - 0.3) * tw;
      dot(ctx, sx, sy, '#ffffff');
      ctx.globalAlpha = 1;
    }
  }
}

function celestial(ctx: Ctx, hour: number) {
  const h = ((hour % 24) + 24) % 24;
  const isDay = h >= 6 && h < 19;
  const span = isDay ? (h - 6) / 13 : ((h + 24 - 19) % 24) / 11;
  const cx = DOOR + 20 + span * (W - DOOR - 40);
  const cy = 70 - Math.sin(span * Math.PI) * 48;
  if (isDay) {
    disc(ctx, cx, cy, 9, '#fff3b0');
    disc(ctx, cx, cy, 7, '#ffe066');
  } else {
    disc(ctx, cx, cy, 7, '#f2f0e6');
    disc(ctx, cx + 3, cy - 2, 6, skyColors(hour)[0]);
  }
}

function clouds(ctx: Ctx, t: number, night: number) {
  const c = night > 0.5 ? '#3a4270' : '#ffffff';
  for (let i = 0; i < 4; i++) {
    const speed = 2 + i * 0.7;
    const x = ((hash01(i) * W + t * speed) % (W + 80)) - 40;
    const y = 18 + hash01(i * 9) * 50;
    ctx.globalAlpha = 0.85;
    ellipse(ctx, x, y, 12, 4, c);
    ellipse(ctx, x + 9, y - 3, 8, 4, c);
    ellipse(ctx, x - 8, y + 1, 7, 3, c);
    ctx.globalAlpha = 1;
  }
}

function yard(ctx: Ctx, hour: number, t: number) {
  const night = nightFactor(hour);
  celestial(ctx, hour);
  clouds(ctx, t, night);
  // hills
  const hill = night > 0.5 ? '#1e3b3a' : '#7ccf8a';
  for (let x = DOOR; x < W; x++) {
    const hgt = 18 + Math.sin(x * 0.03) * 8 + Math.sin(x * 0.011 + 2) * 6;
    rect(ctx, x, FLOOR - hgt, 1, hgt, hill);
  }
  // fence
  const fence = night > 0.5 ? '#6b6058' : '#e9dcc5';
  for (let x = DOOR + 6; x < W; x += 9) {
    rect(ctx, x, FLOOR - 24, 5, 24, dark(fence, 0.1));
    rect(ctx, x + 1, FLOOR - 25, 3, 24, fence);
  }
  rect(ctx, DOOR, FLOOR - 19, W - DOOR, 3, fence);
  rect(ctx, DOOR, FLOOR - 9, W - DOOR, 3, fence);
  // ground
  rect(ctx, DOOR, FLOOR, W - DOOR, H - FLOOR, '#8b5e3c');
  rect(ctx, DOOR, FLOOR, W - DOOR, 4, '#5cb85c');
  rect(ctx, DOOR, FLOOR, W - DOOR, 1, '#7fd07f');
  for (let i = 0; i < 70; i++) {
    const gx = DOOR + hash01(i * 1.9) * (W - DOOR);
    dot(ctx, gx, FLOOR - 1, '#5cb85c');
    dot(ctx, gx + 2, FLOOR + 6 + hash01(i) * 16, '#7a5230');
  }
}

function house(ctx: Ctx, hour: number, t: number) {
  const wall = '#f3e3c3';
  const stripe = '#ebd6ae';
  // back wall
  rect(ctx, 0, CEIL, DOOR, FLOOR - CEIL, wall);
  for (let x = 6; x < DOOR; x += 10) rect(ctx, x, CEIL, 3, FLOOR - CEIL, stripe);
  // wainscot
  rect(ctx, 0, FLOOR - 30, DOOR, 30, '#c99a6b');
  rect(ctx, 0, FLOOR - 30, DOOR, 2, '#a97a4b');
  for (let x = 8; x < DOOR - 10; x += 24) {
    rect(ctx, x, FLOOR - 24, 18, 18, '#b88a5b');
    rect(ctx, x + 1, FLOOR - 23, 16, 16, '#c99a6b');
  }
  rect(ctx, 0, FLOOR - 4, DOOR, 4, '#7a5230');

  // windows
  for (const [wx, wy] of [[84, 126], [236, 124]] as Array<[number, number]>) {
    rect(ctx, wx - 2, wy - 2, 38, 34, '#7a5230');
    drawSky(ctx, wx, wy, 34, 30, hour, t);
    rect(ctx, wx + 16, wy, 2, 30, '#f4efe6');
    rect(ctx, wx, wy + 14, 34, 2, '#f4efe6');
    rect(ctx, wx - 4, wy + 30, 42, 3, '#8d5a3b');
    // curtains
    rect(ctx, wx - 3, wy - 3, 6, 30, '#e8a0b8');
    rect(ctx, wx + 31, wy - 3, 6, 30, '#e8a0b8');
    rect(ctx, wx - 3, wy - 3, 6, 2, '#d0809a');
  }
  // a little framed portrait of Blurb on the wall
  rect(ctx, 182, 140, 20, 18, '#e0b23a');
  rect(ctx, 184, 142, 16, 14, '#fff6e0');
  ellipse(ctx, 192, 151, 5, 4, '#ff0a28');
  dot(ctx, 190, 150, '#3a0008');
  dot(ctx, 194, 150, '#3a0008');

  clock(ctx, 150, 120, hour);
  // a little wall shelf with a plant and a jar
  rect(ctx, 228, 114, 44, 3, '#8d5a3b');
  rect(ctx, 232, 108, 6, 6, '#d2734a');
  ellipse(ctx, 235, 106, 4, 2, '#4caf50');
  rect(ctx, 252, 107, 6, 7, '#bfe6f5');
  rect(ctx, 252, 106, 6, 1, '#e0b23a');
  rect(ctx, 262, 109, 3, 5, '#e8303a');
  rect(ctx, 265, 108, 3, 6, '#3f7fdc');

  // walls + ceiling beam
  rect(ctx, 0, CEIL - 4, DOOR + 6, 6, '#7a5230');
  rect(ctx, 0, CEIL - 4, 4, FLOOR - CEIL + 4, '#8d5a3b');
  // door frame (open doorway to the yard)
  rect(ctx, DOOR - 4, CEIL - 4, 8, FLOOR - CEIL - 48, '#8d5a3b');
  rect(ctx, DOOR - 6, FLOOR - 52, 12, 4, '#7a5230');
  rect(ctx, DOOR - 4, FLOOR - 48, 2, 48, '#7a5230');
  // roof
  const roof = '#c0504d';
  for (let i = 0; i < 40; i++) {
    const y = CEIL - 5 - i;
    const inset = i * 1.6;
    if (inset * 2 > DOOR) break;
    rect(ctx, -6 + inset, y, DOOR + 18 - inset * 2, 1, i % 4 === 0 ? dark(roof, 0.1) : roof);
  }
  // chimney
  rect(ctx, 220, 50, 14, 24, '#9a5a40');
  rect(ctx, 218, 48, 18, 4, '#7a3a28');
  // floor
  rect(ctx, 0, FLOOR, DOOR, H - FLOOR, '#b07a4a');
  for (let y = FLOOR + 6; y < H; y += 7) rect(ctx, 0, y, DOOR, 1, '#8d5a3b');
  for (let i = 0; i < 18; i++) {
    const y = FLOOR + 1 + Math.floor(i / 6) * 7;
    rect(ctx, (i * 53 + Math.floor(i / 6) * 25) % DOOR, y, 1, 6, '#8d5a3b');
  }
  rect(ctx, 0, FLOOR, DOOR, 1, light('#b07a4a', 0.08));
}

/** Everything behind objects and the pet. */
export function drawBackdrop(ctx: Ctx, hour: number, t: number) {
  // one continuous sky behind everything (no seam above the roof)
  drawSky(ctx, 0, 0, W, FLOOR, hour, t);
  yard(ctx, hour, t);
  house(ctx, hour, t);
}

/** Wall clock showing the real local time. */
function clock(ctx: Ctx, cx: number, cy: number, hour: number) {
  disc(ctx, cx, cy, 8, '#7a5230');
  disc(ctx, cx, cy, 7, '#fff6e0');
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    dot(ctx, cx + Math.sin(a) * 6, cy - Math.cos(a) * 6, i % 3 === 0 ? '#3a2a1a' : '#c9b89a');
  }
  const hand = (frac: number, len: number, color: string) => {
    const a = frac * Math.PI * 2;
    for (let r = 0; r <= len; r += 0.5) dot(ctx, cx + Math.sin(a) * r, cy - Math.cos(a) * r, color);
  };
  hand((hour % 12) / 12, 3.5, '#3a2a1a');
  hand(hour % 1, 5.5, '#c0504d');
  dot(ctx, cx, cy, '#3a2a1a');
}

/** Darkness pass applied after objects + pet are drawn. */
export function drawNightShade(ctx: Ctx, hour: number, lampXs: number[]) {
  const night = nightFactor(hour);
  if (night <= 0) return;
  ctx.fillStyle = `rgba(10,14,40,${0.42 * night})`;
  ctx.fillRect(0, 0, W, H);
  // warm pools around lamps (drawn after darkness so they read as light)
  for (const lx of lampXs) {
    const g = (ctx as CanvasRenderingContext2D).createRadialGradient?.(lx + 6, FLOOR - 38, 2, lx + 6, FLOOR - 20, 60);
    if (!g) continue;
    g.addColorStop(0, `rgba(255,210,130,${0.28 * night})`);
    g.addColorStop(1, 'rgba(255,210,130,0)');
    ctx.fillStyle = g;
    ctx.fillRect(lx - 60, FLOOR - 100, 130, 110);
  }
}
