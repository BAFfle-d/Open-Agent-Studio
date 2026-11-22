/**
 * Pixel-art drawings for every world object. Each is parameterized by the
 * object's color, so recolors (owner or Blurb) just work.
 */
import { OBJECT_DEFS, RESOURCE_COLORS, WORLD, type ObjectKind, type PublicObject, type ResourceKind } from '@blurb/shared';
import { type Ctx, dark, disc, dot, ellipse, hash01, ink, light, mix, outlinedRect, rect, strHash } from './pixel.js';

export interface ObjectDrawInfo {
  t: number;
  /** 0 = day, 1 = deep night. */
  night: number;
  /** id of the object Blurb is currently using, if any (animates it). */
  activeId?: string;
  hoverId?: string;
}

const FLOOR = WORLD.floorY;

type Drawer = (ctx: Ctx, o: PublicObject, info: ObjectDrawInfo) => void;

const bed: Drawer = (ctx, o) => {
  const x = o.x;
  const wood = '#8d5a3b';
  // headboard
  outlinedRect(ctx, x, FLOOR - 22, 8, 22, wood, ink(wood));
  rect(ctx, x + 2, FLOOR - 19, 4, 1, light(wood));
  // footboard
  outlinedRect(ctx, x + 50, FLOOR - 14, 6, 14, wood, ink(wood));
  // frame
  outlinedRect(ctx, x + 6, FLOOR - 8, 46, 6, dark(wood, 0.05), ink(wood));
  // legs
  rect(ctx, x + 8, FLOOR - 2, 2, 2, ink(wood));
  rect(ctx, x + 46, FLOOR - 2, 2, 2, ink(wood));
  // mattress
  outlinedRect(ctx, x + 7, FLOOR - 13, 44, 6, '#f4efe6', '#b9ae9c');
  // pillow
  outlinedRect(ctx, x + 8, FLOOR - 17, 12, 5, '#ffffff', '#c9c0b0');
  // blanket (object color)
  outlinedRect(ctx, x + 19, FLOOR - 14, 32, 8, o.c, ink(o.c));
  rect(ctx, x + 20, FLOOR - 13, 30, 1, light(o.c));
  for (let i = 0; i < 4; i++) rect(ctx, x + 23 + i * 7, FLOOR - 11, 3, 3, dark(o.c, 0.08));
};

const foodBowl: Drawer = (ctx, o) => {
  const x = o.x;
  const servings = o.s ?? 0;
  if (servings > 0) {
    for (let i = 0; i < Math.min(5, servings * 2 + 1); i++) {
      disc(ctx, x + 5 + i * 2.2, FLOOR - 7 - (i % 2), 1, i % 2 ? '#d98b3a' : '#b8682a');
    }
  }
  ellipse(ctx, x + 9, FLOOR - 4, 9, 3, ink(o.c));
  ellipse(ctx, x + 9, FLOOR - 4, 8, 2, o.c);
  rect(ctx, x + 2, FLOOR - 6, 14, 1, light(o.c));
  rect(ctx, x + 3, FLOOR - 1, 12, 1, ink(o.c));
};

const BOOK_COLORS = ['#e8303a', '#3f7fdc', '#f5d442', '#4caf50', '#9b59d0', '#f39c34', '#26a69a', '#f48fb1'];
const bookshelf: Drawer = (ctx, o) => {
  const x = o.x;
  const top = FLOOR - 58;
  outlinedRect(ctx, x, top, 34, 58, o.c, ink(o.c));
  rect(ctx, x + 2, top + 2, 30, 54, dark(o.c, 0.2));
  for (let shelf = 0; shelf < 3; shelf++) {
    const sy = top + 4 + shelf * 18;
    let bx = x + 3;
    let i = shelf * 5;
    while (bx < x + 30) {
      const bw = 2 + Math.floor(hash01(i + strHash(o.id) * 100) * 3);
      const bh = 10 + Math.floor(hash01(i * 3.1) * 4);
      if (bx + bw > x + 31) break;
      const c = BOOK_COLORS[i % BOOK_COLORS.length];
      rect(ctx, bx, sy + 14 - bh, bw, bh, c);
      rect(ctx, bx, sy + 14 - bh, bw, 1, light(c));
      rect(ctx, bx + bw - 1, sy + 14 - bh, 1, bh, dark(c));
      bx += bw + (hash01(i * 7.7) > 0.8 ? 2 : 0);
      i++;
    }
    rect(ctx, x + 1, sy + 14, 32, 2, o.c);
    rect(ctx, x + 1, sy + 14, 32, 1, light(o.c));
  }
};

const computer: Drawer = (ctx, o, info) => {
  const x = o.x;
  const wood = '#a0703c';
  // desk
  outlinedRect(ctx, x, FLOOR - 18, 42, 4, wood, ink(wood));
  rect(ctx, x + 2, FLOOR - 14, 3, 14, dark(wood));
  rect(ctx, x + 37, FLOOR - 14, 3, 14, dark(wood));
  // monitor (case uses the object color)
  outlinedRect(ctx, x + 8, FLOOR - 36, 26, 17, o.c, ink(o.c));
  const on = info.activeId === o.id;
  const screen = on ? '#0b2a1a' : '#1d2433';
  rect(ctx, x + 10, FLOOR - 34, 22, 12, screen);
  if (on) {
    // scrolling code
    const scroll = Math.floor(info.t * 4);
    for (let r = 0; r < 5; r++) {
      const line = r + scroll;
      const len = 4 + Math.floor(hash01(line) * 14);
      const indent = Math.floor(hash01(line * 1.7) * 3) * 2;
      const c = ['#5ef38c', '#80d0f8', '#f5d442', '#f48fb1'][line % 4];
      rect(ctx, x + 11 + indent, FLOOR - 33 + r * 2, Math.min(len, 20 - indent), 1, c);
    }
    if (Math.floor(info.t * 2) % 2) rect(ctx, x + 11, FLOOR - 23, 2, 1, '#ffffff');
  } else {
    rect(ctx, x + 11, FLOOR - 33, 6, 1, light(screen, 0.12));
  }
  rect(ctx, x + 19, FLOOR - 20, 4, 2, ink(o.c));
  // keyboard
  rect(ctx, x + 12, FLOOR - 20, 16, 2, '#e9e4d8');
  rect(ctx, x + 12, FLOOR - 19, 16, 1, '#b7b0a0');
};

const ball: Drawer = (ctx, o, info) => {
  const bounce = o.b ?? 0;
  const hop = bounce > 0 ? Math.abs(Math.sin(info.t * 9)) * Math.min(14, bounce * 3) : 0;
  const cx = o.x + 5;
  const cy = FLOOR - 5 - hop;
  if (hop > 1) ellipse(ctx, cx, FLOOR - 1, 4, 1, 'rgba(0,0,0,0.25)');
  disc(ctx, cx, cy, 5, ink(o.c));
  disc(ctx, cx, cy, 4, o.c);
  rect(ctx, cx - 4, cy, 9, 1, '#ffffff');
  dot(ctx, cx - 2, cy - 2, light(o.c, 0.3));
};

const yarn: Drawer = (ctx, o, info) => {
  const roll = (o.b ?? 0) > 0 ? Math.sin(info.t * 6) * 3 : 0;
  const cx = o.x + 5 + roll;
  disc(ctx, cx, FLOOR - 5, 4, ink(o.c));
  disc(ctx, cx, FLOOR - 5, 3, o.c);
  for (let i = -2; i <= 2; i += 2) rect(ctx, cx - 3, FLOOR - 5 + i, 6, 1, light(o.c));
  rect(ctx, cx + 3, FLOOR - 1, 6, 1, o.c);
  dot(ctx, cx + 9, FLOOR - 2, o.c);
};

const plushie: Drawer = (ctx, o, info) => {
  const squeak = (o.b ?? 0) > 0 ? Math.abs(Math.sin(info.t * 10)) : 0;
  const x = o.x;
  const h = Math.round(squeak);
  // ears
  disc(ctx, x + 3, FLOOR - 13 + h, 2, ink(o.c));
  disc(ctx, x + 9, FLOOR - 13 + h, 2, ink(o.c));
  disc(ctx, x + 3, FLOOR - 13 + h, 1, o.c);
  disc(ctx, x + 9, FLOOR - 13 + h, 1, o.c);
  // head + body
  disc(ctx, x + 6, FLOOR - 9 + h, 4, ink(o.c));
  disc(ctx, x + 6, FLOOR - 9 + h, 3, o.c);
  ellipse(ctx, x + 6, FLOOR - 3, 5, 3, ink(o.c));
  ellipse(ctx, x + 6, FLOOR - 3, 4, 2, o.c);
  dot(ctx, x + 5, FLOOR - 10 + h, '#2a1a10');
  dot(ctx, x + 7, FLOOR - 10 + h, '#2a1a10');
  dot(ctx, x + 6, FLOOR - 8 + h, '#2a1a10');
  rect(ctx, x + 5, FLOOR - 4, 3, 2, light(o.c, 0.25));
};

const dropBox: Drawer = (ctx, o, info) => {
  const x = o.x;
  outlinedRect(ctx, x, FLOOR - 16, 22, 16, o.c, ink(o.c));
  rect(ctx, x + 1, FLOOR - 15, 20, 2, light(o.c));
  rect(ctx, x + 1, FLOOR - 4, 20, 3, dark(o.c));
  // lid
  outlinedRect(ctx, x - 1, FLOOR - 20, 24, 5, dark(o.c, 0.05), ink(o.c));
  rect(ctx, x + 6, FLOOR - 18, 10, 1, ink(o.c)); // slot
  // arrow
  const bob = Math.floor(info.t * 2) % 2;
  rect(ctx, x + 10, FLOOR - 13 + bob, 2, 4, '#ffffff');
  rect(ctx, x + 8, FLOOR - 10 + bob, 6, 1, '#ffffff');
  rect(ctx, x + 9, FLOOR - 9 + bob, 4, 1, '#ffffff');
  rect(ctx, x + 10, FLOOR - 8 + bob, 2, 1, '#ffffff');
  if (o.u) badge(ctx, x + 20, FLOOR - 22, o.u);
};

const commBox: Drawer = (ctx, o, info) => {
  const x = o.x;
  const post = '#7a5230';
  rect(ctx, x + 6, FLOOR - 18, 3, 18, post);
  rect(ctx, x + 6, FLOOR - 18, 1, 18, light(post));
  // mailbox
  outlinedRect(ctx, x, FLOOR - 30, 14, 12, o.c, ink(o.c));
  rect(ctx, x + 1, FLOOR - 29, 12, 2, light(o.c));
  rect(ctx, x + 2, FLOOR - 24, 10, 1, ink(o.c));
  // flag: up when there are unread notes
  const unread = o.u ?? 0;
  if (unread > 0) {
    const wave = Math.floor(info.t * 3) % 2;
    rect(ctx, x + 13, FLOOR - 36, 1, 12, '#444');
    rect(ctx, x + 14, FLOOR - 36 + wave, 5, 3, '#f5d442');
    badge(ctx, x - 2, FLOOR - 34, unread);
  } else {
    rect(ctx, x + 13, FLOOR - 26, 6, 1, '#444');
    rect(ctx, x + 17, FLOOR - 27, 2, 3, '#f5d442');
  }
};

const workbench: Drawer = (ctx, o) => {
  const x = o.x;
  outlinedRect(ctx, x, FLOOR - 22, 40, 5, o.c, ink(o.c));
  rect(ctx, x + 1, FLOOR - 21, 38, 1, light(o.c));
  rect(ctx, x + 3, FLOOR - 17, 3, 17, dark(o.c));
  rect(ctx, x + 34, FLOOR - 17, 3, 17, dark(o.c));
  rect(ctx, x + 6, FLOOR - 8, 28, 2, dark(o.c, 0.1));
  // hammer + saw
  rect(ctx, x + 8, FLOOR - 24, 8, 2, '#7a5230');
  rect(ctx, x + 15, FLOOR - 26, 3, 4, '#8c96a0');
  rect(ctx, x + 24, FLOOR - 24, 10, 2, '#b7c0c8');
  for (let i = 0; i < 5; i++) dot(ctx, x + 25 + i * 2, FLOOR - 22, '#8c96a0');
};

const tree: Drawer = (ctx, o, info) => {
  const x = o.x;
  const trunk = '#7a5230';
  const sway = Math.round(Math.sin(info.t * 0.8 + strHash(o.id) * 6) * 0.8);
  rect(ctx, x + 18, FLOOR - 34, 8, 34, ink(trunk));
  rect(ctx, x + 19, FLOOR - 34, 6, 34, trunk);
  rect(ctx, x + 19, FLOOR - 30, 1, 26, light(trunk));
  rect(ctx, x + 14, FLOOR - 3, 16, 3, trunk);
  const canopy: Array<[number, number, number]> = [
    [22, 54, 18], [10, 58, 11], [34, 58, 11], [16, 44, 12], [29, 44, 12], [22, 68, 12],
  ];
  for (const [cx, cy, r] of canopy) disc(ctx, x + cx + sway, FLOOR - cy, r + 1, ink(o.c));
  for (const [cx, cy, r] of canopy) disc(ctx, x + cx + sway, FLOOR - cy, r, o.c);
  for (const [cx, cy, r] of canopy) disc(ctx, x + cx - r / 3 + sway, FLOOR - cy - r / 3, Math.max(2, r / 2), light(o.c, 0.1));
  for (let i = 0; i < 6; i++) {
    dot(ctx, x + 8 + hash01(i + 3) * 28 + sway, FLOOR - 40 - hash01(i * 2) * 30, dark(o.c, 0.12));
  }
};

const bush: Drawer = (ctx, o) => {
  const x = o.x;
  const blobs: Array<[number, number, number]> = [[8, 8, 7], [16, 10, 9], [24, 8, 7]];
  for (const [cx, cy, r] of blobs) disc(ctx, x + cx, FLOOR - cy, r + 1, ink(o.c));
  for (const [cx, cy, r] of blobs) disc(ctx, x + cx, FLOOR - cy, r, o.c);
  for (const [cx, cy, r] of blobs) disc(ctx, x + cx - 2, FLOOR - cy - 2, Math.max(1, r / 2.5), light(o.c, 0.1));
  rect(ctx, x + 1, FLOOR - 2, 28, 2, dark(o.c));
  // berries
  for (let i = 0; i < 4; i++) dot(ctx, x + 6 + i * 6, FLOOR - 6 - (i % 2) * 5, '#c2185b');
};

const flowers: Drawer = (ctx, o, info) => {
  const x = o.x;
  for (let i = 0; i < 4; i++) {
    const fx = x + 2 + i * 5;
    const h = 6 + Math.floor(hash01(i + strHash(o.id) * 10) * 5);
    const sway = Math.round(Math.sin(info.t * 1.3 + i) * 0.6);
    rect(ctx, fx + 1, FLOOR - h, 1, h, '#3f8f3f');
    dot(ctx, fx + 2, FLOOR - 3, '#5cb85c');
    const c = i % 2 ? o.c : mix(o.c, '#ffffff', 0.35);
    rect(ctx, fx + sway, FLOOR - h - 2, 3, 1, c);
    rect(ctx, fx + 1 + sway, FLOOR - h - 3, 1, 3, c);
    dot(ctx, fx + 1 + sway, FLOOR - h - 2, '#f5d442');
  }
};

const lamp: Drawer = (ctx, o, info) => {
  const x = o.x;
  rect(ctx, x + 2, FLOOR - 2, 8, 2, '#3a3a40');
  rect(ctx, x + 5, FLOOR - 32, 2, 30, '#5a5a62');
  if (info.night > 0.25) {
    const a = Math.min(0.35, info.night * 0.4);
    ctx.fillStyle = `rgba(255,220,140,${a})`;
    ctx.beginPath();
    ctx.moveTo(x + 1, FLOOR - 34);
    ctx.lineTo(x + 11, FLOOR - 34);
    ctx.lineTo(x + 26, FLOOR);
    ctx.lineTo(x - 14, FLOOR);
    ctx.closePath();
    ctx.fill();
  }
  // shade
  ctx.fillStyle = ink(o.c);
  ctx.fillRect(x, FLOOR - 34, 12, 1);
  outlinedRect(ctx, x + 1, FLOOR - 42, 10, 9, o.c, ink(o.c));
  rect(ctx, x + 2, FLOOR - 41, 8, 2, light(o.c));
};

const rug: Drawer = (ctx, o) => {
  const x = o.x;
  ellipse(ctx, x + 31, FLOOR + 3, 31, 3, ink(o.c));
  ellipse(ctx, x + 31, FLOOR + 3, 29, 2, o.c);
  ellipse(ctx, x + 31, FLOOR + 3, 18, 1, light(o.c, 0.12));
};

const plantPot: Drawer = (ctx, o, info) => {
  const x = o.x;
  const sway = Math.round(Math.sin(info.t + strHash(o.id) * 5) * 0.6);
  const leaf = '#4caf50';
  for (const [dx, dy] of [[-4, 14], [4, 15], [0, 19], [-2, 11], [3, 10]] as Array<[number, number]>) {
    ellipse(ctx, x + 6 + dx + sway, FLOOR - dy, 2, 3, leaf);
    dot(ctx, x + 6 + dx + sway, FLOOR - dy - 1, light(leaf));
  }
  rect(ctx, x + 6, FLOOR - 12, 1, 6, '#3f8f3f');
  outlinedRect(ctx, x + 1, FLOOR - 9, 10, 9, o.c, ink(o.c));
  rect(ctx, x, FLOOR - 10, 12, 3, dark(o.c, 0.05));
  rect(ctx, x + 2, FLOOR - 7, 1, 5, light(o.c));
};

function drawResource(ctx: Ctx, kind: ResourceKind, x: number, y: number) {
  const c = RESOURCE_COLORS[kind];
  switch (kind) {
    case 'stick':
      rect(ctx, x, y - 2, 7, 1, c);
      rect(ctx, x + 1, y - 1, 6, 1, dark(c));
      dot(ctx, x + 5, y - 3, c);
      break;
    case 'leaf':
      ellipse(ctx, x + 3, y - 2, 3, 1, c);
      rect(ctx, x + 1, y - 2, 5, 1, dark(c));
      break;
    case 'berry':
      disc(ctx, x + 2, y - 2, 1, c);
      disc(ctx, x + 4, y - 2, 1, dark(c, 0.1));
      dot(ctx, x + 3, y - 4, '#3f8f3f');
      break;
    case 'pebble':
      ellipse(ctx, x + 3, y - 2, 3, 2, ink(c));
      ellipse(ctx, x + 3, y - 2, 2, 1, c);
      dot(ctx, x + 2, y - 3, light(c));
      break;
    case 'fluff':
      disc(ctx, x + 3, y - 3, 2, '#d8d8d8');
      disc(ctx, x + 3, y - 3, 1, c);
      dot(ctx, x + 1, y - 5, c);
      dot(ctx, x + 5, y - 5, c);
      break;
  }
}

const resource: Drawer = (ctx, o) => drawResource(ctx, (o.r as ResourceKind) ?? 'pebble', o.x, FLOOR);

export function badge(ctx: Ctx, x: number, y: number, n: number) {
  disc(ctx, x, y, 3, '#7a0010');
  disc(ctx, x, y, 2, '#ff3b4f');
  if (n < 10) {
    // tiny 3x5 digits
    const glyph = DIGITS[n] ?? DIGITS[9];
    glyph.forEach((row, ry) => {
      for (let rx = 0; rx < 3; rx++) if (row[rx] === '#') dot(ctx, x - 1 + rx, y - 2 + ry, '#ffffff');
    });
  } else {
    rect(ctx, x - 1, y, 3, 1, '#ffffff');
  }
}

const DIGITS: Record<number, string[]> = {
  0: ['###', '#.#', '#.#', '#.#', '###'],
  1: ['.#.', '##.', '.#.', '.#.', '###'],
  2: ['##.', '..#', '.#.', '#..', '###'],
  3: ['##.', '..#', '.#.', '..#', '##.'],
  4: ['#.#', '#.#', '###', '..#', '..#'],
  5: ['###', '#..', '##.', '..#', '##.'],
  6: ['.##', '#..', '###', '#.#', '###'],
  7: ['###', '..#', '.#.', '.#.', '.#.'],
  8: ['###', '#.#', '###', '#.#', '###'],
  9: ['###', '#.#', '###', '..#', '##.'],
};

export const OBJECT_DRAWERS: Record<ObjectKind, Drawer> = {
  bed,
  food_bowl: foodBowl,
  bookshelf,
  computer,
  ball,
  yarn,
  plushie,
  drop_box: dropBox,
  comm_box: commBox,
  workbench,
  tree,
  bush,
  flowers,
  lamp,
  rug,
  plant_pot: plantPot,
  resource,
};

/** Draw order: flat things first, tall things behind small things. */
export function objectZ(k: ObjectKind): number {
  if (k === 'rug') return 0;
  if (k === 'tree' || k === 'bookshelf' || k === 'lamp') return 1;
  if (k === 'resource' || k === 'ball' || k === 'yarn' || k === 'plushie' || k === 'food_bowl') return 3;
  return 2;
}

export function objectBounds(o: { k: ObjectKind; x: number }): { x: number; y: number; w: number; h: number } {
  const d = OBJECT_DEFS[o.k];
  const h = o.k === 'rug' ? 8 : d.height;
  return { x: o.x, y: FLOOR - h, w: d.width, h };
}

export { drawResource };
