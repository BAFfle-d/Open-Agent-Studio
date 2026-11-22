/**
 * Procedural pixel-art blob, modeled on the reference sprites.
 *
 * Produces palette-indexed pixels (no canvas needed), so the same code runs in
 * the Electron renderer, the fan web viewer, Node tests, and the PNG preview
 * script. Every skin is a palette swap; every shape (including ones Blurb
 * designs) is a ShapeSpec fed through the same generator, so a designed
 * shape is guaranteed to render, squash, blink and emote like the original.
 */
import type { BlobPalette, ShapeSpec } from '@blurb/shared';

export const PX = {
  T: 0,
  OUTLINE: 1,
  BODY: 2,
  SHADE: 3,
  DEEP: 4,
  HIGHLIGHT: 5,
  CHEEK: 6,
  EYE: 7,
  SPARKLE: 8,
} as const;

export type EyeKind = 'open' | 'closed' | 'happy' | 'sleepy' | 'excited' | 'sad' | 'look_up' | 'confused';
export type MouthKind = 'smile' | 'grin' | 'small' | 'open' | 'chomp' | 'flat' | 'wavy' | 'frown';
export type ArmKind = 'none' | 'down' | 'up' | 'wave1' | 'wave2';

export interface Pose {
  /** Width/height deltas in sprite pixels (squash & stretch). */
  dw: number;
  dh: number;
  eyes: EyeKind;
  mouth: MouthKind;
  arm: ArmKind;
  /** Stronger blush. */
  blush: boolean;
}

export const DEFAULT_POSE: Pose = { dw: 0, dh: 0, eyes: 'open', mouth: 'grin', arm: 'down', blush: false };

export interface SpriteFrame {
  w: number;
  h: number;
  px: Uint8Array;
  /** Anchor: x of body center and y of the bottom row, in frame pixels. */
  ax: number;
  ay: number;
  /** Body bounds inside the frame, for hit testing and bubble placement. */
  body: { x: number; y: number; w: number; h: number };
}

const PAD_X = 9;
const PAD_TOP = 6;

function stamp(px: Uint8Array, w: number, x0: number, y0: number, rows: string[], map: Record<string, number>, mirror = false) {
  const h = px.length / w;
  rows.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      const ch = row[mirror ? row.length - 1 - dx : dx];
      const v = map[ch];
      if (v === undefined) continue;
      const x = x0 + dx;
      const y = y0 + dy;
      if (x >= 0 && x < w && y >= 0 && y < h) px[y * w + x] = v;
    }
  });
}

// ---- face stamps (X = eye ink, W = sparkle, C = cheek) ----
const EYES: Record<EyeKind, string[]> = {
  open: ['.XX.', 'XXWW', 'XXWW', 'XWXX', '.XX.'],
  look_up: ['XWWX', 'XWWX', 'XXXX', '.XX.', '....'],
  closed: ['....', '....', '....', 'XXXX', '....'],
  sleepy: ['....', '....', 'XXXX', '.XX.', '....'],
  happy: ['....', '.XX.', 'X..X', '....', '....'],
  excited: ['X...', '.XX.', '..XX', '.XX.', 'X...'],
  sad: ['....', 'XX..', 'XXXW', 'XXXX', '.XX.'],
  confused: ['.XX.', 'X..X', 'X.XX', 'X...', '.XX.'],
};

const MOUTHS: Record<MouthKind, string[]> = {
  smile: ['X...X', '.XXX.'],
  grin: ['X...X', 'XXXXX', '.XXX.'],
  small: ['.XX.', '.XX.'],
  open: ['.XXX.', 'XXCXX', '.XXX.'],
  chomp: ['XXXXX', '.....'],
  flat: ['.XXX.'],
  wavy: ['.X...', 'X.X.X', '...X.'],
  frown: ['.XXX.', 'X...X'],
};

const CHEEK = ['.CCC.', 'CCCCC'];
const CHEEK_BLUSH = ['.CCC.', 'CCCCC', '.CCC.'];

/** Half-width (in px) of the body at normalized height t (0 = top, 1 = bottom). */
function halfWidth(spec: ShapeSpec, W: number, t: number): number {
  const top = spec.peak === 'pointy' ? 0.08 : spec.peak === 'flat' ? 0.62 : 0.2;
  const reach = spec.peak === 'pointy' ? 0.85 : spec.peak === 'flat' ? 0.35 : 0.66;
  const u = Math.min(1, t / reach);
  let hw = (W / 2) * (top + (1 - top) * Math.sqrt(1 - (1 - u) * (1 - u)));
  if (t > 0.86) hw *= 1 - ((t - 0.86) / 0.14) ** 2 * 0.1;
  return hw;
}

export function buildBlob(spec: ShapeSpec, pose: Pose = DEFAULT_POSE): SpriteFrame {
  const W = Math.max(12, spec.width + pose.dw);
  const H = Math.max(10, spec.height + pose.dh);
  const fw = W + PAD_X * 2;
  const fh = H + PAD_TOP + 1;
  const mask = new Uint8Array(fw * fh);
  const bottom = fh - 1;
  const top = bottom - H + 1;
  const baseCx = PAD_X + W / 2;
  const at = (x: number, y: number) => (x >= 0 && x < fw && y >= 0 && y < fh ? mask[y * fw + x] : 0);
  const set = (x: number, y: number) => {
    if (x >= 0 && x < fw && y >= 0 && y < fh) mask[y * fw + x] = 1;
  };

  // ---- silhouette ----
  const cxAt = (t: number) => baseCx + spec.lean * Math.pow(1 - t, 1.6) * W * 0.22;
  const rowL: number[] = [];
  const rowR: number[] = [];
  for (let r = 0; r < H; r++) {
    const t = H === 1 ? 1 : r / (H - 1);
    const hw = halfWidth(spec, W, t);
    const cx = cxAt(t);
    const l = Math.round(cx - hw);
    const rr = Math.round(cx + hw) - 1;
    rowL[r] = l;
    rowR[r] = rr;
    for (let x = l; x <= rr; x++) set(x, top + r);
  }

  // ---- feet: carve notches into the bottom edge ----
  if (spec.feet >= 2) {
    const l = rowL[H - 1];
    const r = rowR[H - 1];
    for (let k = 1; k < spec.feet; k++) {
      const gx = Math.round(l + ((r - l) * k) / spec.feet);
      for (let dx = -1; dx <= 1; dx++) mask[bottom * fw + gx + dx] = 0;
      mask[(bottom - 1) * fw + gx] = 0;
    }
  } else if (spec.feet === 1) {
    // a single soft base: round the bottom corners a bit more
    mask[bottom * fw + rowL[H - 1]] = 0;
    mask[bottom * fw + rowR[H - 1]] = 0;
  }

  // ---- ears ----
  const tcx = Math.round(cxAt(0));
  const topHw = Math.max(2, Math.round(halfWidth(spec, W, 0.08)));
  if (spec.ears === 'nubs') {
    for (const sx of [-1, 1]) {
      const ex = tcx + sx * Math.max(2, topHw - 1);
      for (let dx = -1; dx <= 1; dx++) set(ex + dx, top - 1);
      set(ex, top - 2);
    }
  } else if (spec.ears === 'tufts') {
    for (const dx of [-2, 0, 2]) {
      set(tcx + dx, top - 1);
      set(tcx + dx, top - 2);
      if (dx === 0) set(tcx, top - 3);
    }
  }

  // ---- arms (right arm is the expressive one; left is a resting nub) ----
  const armRow = (t: number) => top + Math.round(t * (H - 1));
  if (pose.arm !== 'none') {
    // left resting nub, low on the body
    const ly = armRow(0.74);
    const lx = rowL[ly - top];
    for (let dy = 0; dy < 3; dy++) for (let dx = 1; dx <= 2; dx++) set(lx - dx + (dy === 2 ? 1 : 0), ly + dy);

    const ry = armRow(pose.arm === 'down' ? 0.62 : 0.5);
    const rx = rowR[ry - top];
    if (pose.arm === 'down') {
      for (let dy = 0; dy < 4; dy++) for (let dx = 1; dx <= 2; dx++) set(rx + dx - (dy === 3 ? 1 : 0), ry + dy);
    } else {
      // raised arm: a chunky limb angled up-right ending in a round mitten
      const tipDx = pose.arm === 'wave2' ? 4 : 5;
      const tipDy = pose.arm === 'wave2' ? -5 : -7;
      const steps = 8;
      for (let s = 0; s <= steps; s++) {
        const x = Math.round(rx - 1 + ((tipDx + 1) * s) / steps);
        const y = Math.round(ry + 1 + ((tipDy - 1) * s) / steps);
        for (let dy = -2; dy <= 2; dy++) for (let dx = -1; dx <= 2; dx++) set(x + dx, y + dy);
      }
      const mx = rx + tipDx;
      const my = ry + tipDy - 1;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) if (Math.abs(dx) + Math.abs(dy) <= 3) set(mx + dx, my + dy);
    }
  }

  // ---- distance-to-edge (chamfer, 4-neighborhood) ----
  const INF = 1e9;
  const dist = new Float64Array(fw * fh).fill(INF);
  for (let y = 0; y < fh; y++)
    for (let x = 0; x < fw; x++) {
      if (!at(x, y)) continue;
      if (!at(x - 1, y) || !at(x + 1, y) || !at(x, y - 1) || !at(x, y + 1)) dist[y * fw + x] = 0;
    }
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < fh; y++)
      for (let x = 0; x < fw; x++) {
        const i = y * fw + x;
        if (!mask[i] || dist[i] === 0) continue;
        let d = dist[i];
        if (x > 0) d = Math.min(d, dist[i - 1] + 1);
        if (y > 0) d = Math.min(d, dist[i - fw] + 1);
        dist[i] = d;
      }
    for (let y = fh - 1; y >= 0; y--)
      for (let x = fw - 1; x >= 0; x--) {
        const i = y * fw + x;
        if (!mask[i] || dist[i] === 0) continue;
        let d = dist[i];
        if (x < fw - 1) d = Math.min(d, dist[i + 1] + 1);
        if (y < fh - 1) d = Math.min(d, dist[i + fw] + 1);
        dist[i] = d;
      }
  }

  // ---- shading ----
  const px = new Uint8Array(fw * fh);
  for (let y = 0; y < fh; y++)
    for (let x = 0; x < fw; x++) {
      const i = y * fw + x;
      if (!mask[i]) continue;
      if (dist[i] === 0) {
        px[i] = PX.OUTLINE;
        continue;
      }
      let v: number = PX.BODY;
      const t = (y - top) / Math.max(1, H - 1);
      const nearRight = !at(x + 2, y) || (!at(x + 1, y - 1) && t > 0.15);
      const nearBottom = !at(x, y + 2);
      if (nearRight && t > 0.08) v = PX.SHADE;
      if (nearBottom) v = PX.SHADE;
      // deep shade where the bottom edge curls into a foot notch
      if (nearBottom && (!at(x - 2, y + 1) || !at(x + 2, y + 1))) v = PX.DEEP;
      px[i] = v;
    }

  // ---- gloss highlight: a rim band on the upper-left ----
  if (spec.gloss) {
    for (let y = top; y < top + Math.round(H * 0.55); y++)
      for (let x = 0; x < fw; x++) {
        const i = y * fw + x;
        if (!mask[i] || px[i] !== PX.BODY) continue;
        const t = (y - top) / Math.max(1, H - 1);
        const cx = cxAt(t);
        if (x >= cx - W * 0.12) continue;
        if (t < 0.06 || t > 0.42) continue;
        if (dist[i] >= 2 && dist[i] <= 3) px[i] = PX.HIGHLIGHT;
      }
    // little sparkle dots, like the reference
    const dotY = top + 2;
    const dotX = Math.round(cxAt(0.08) + halfWidth(spec, W, 0.08) * 0.35);
    if (at(dotX, dotY) && dist[dotY * fw + dotX] >= 1) px[dotY * fw + dotX] = PX.HIGHLIGHT;
    const sy = top + Math.round(H * 0.48);
    const sx = rowL[sy - top] + 3;
    if (px[sy * fw + sx] === PX.BODY) px[sy * fw + sx] = PX.HIGHLIGHT;
    // highlight on the left nub
    if (pose.arm !== 'none') {
      const ly = armRow(0.74) + 1;
      const lx = rowL[armRow(0.74) - top] - 1;
      if (px[ly * fw + lx] === PX.BODY || px[ly * fw + lx] === PX.SHADE) px[ly * fw + lx] = PX.HIGHLIGHT;
    }
  }

  // ---- face ----
  const faceT = 0.36;
  const eyeTop = top + Math.round((H - 1) * faceT) - (pose.dh > 0 ? 1 : 0);
  const fcx = Math.round(cxAt(faceT + 0.12) + (spec.lean > 0 ? 0.5 : 0));
  const spread = Math.max(4, Math.round(W * 0.23));
  const inkMap = { X: PX.EYE, W: PX.SPARKLE, C: PX.CHEEK };
  const eyeRows = EYES[pose.eyes];
  stamp(px, fw, fcx - spread - 2, eyeTop, eyeRows, inkMap);
  // right eye mirrors for asymmetric glyphs (excited ><)
  const mirrorRight = pose.eyes === 'excited';
  stamp(px, fw, fcx + spread - 2, eyeTop, eyeRows, inkMap, mirrorRight);
  if (pose.eyes === 'confused') {
    // one normal eye, one swirly: overwrite the left with a normal eye
    stamp(px, fw, fcx - spread - 2, eyeTop, ['....', ...EYES.open.slice(0, 4)].slice(0, 5), inkMap);
  }

  const mouthRows = MOUTHS[pose.mouth];
  const mw = mouthRows[0].length;
  stamp(px, fw, fcx - Math.floor(mw / 2), eyeTop + 5, mouthRows, inkMap);

  const cheek = pose.blush ? CHEEK_BLUSH : CHEEK;
  stamp(px, fw, fcx - spread - 4, eyeTop + 5, cheek, { C: PX.CHEEK });
  stamp(px, fw, fcx + spread - 1, eyeTop + 5, cheek, { C: PX.CHEEK });

  // Never let face stamps overwrite the outline.
  for (let i = 0; i < px.length; i++) if (mask[i] && dist[i] === 0) px[i] = PX.OUTLINE;
  // Face stamps that fell outside the body get cleared.
  for (let i = 0; i < px.length; i++) if (!mask[i]) px[i] = PX.T;

  // body bounds
  let minX = fw, maxX = 0, minY = fh, maxY = 0;
  for (let y = 0; y < fh; y++)
    for (let x = 0; x < fw; x++)
      if (mask[y * fw + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }

  return {
    w: fw,
    h: fh,
    px,
    ax: Math.round(baseCx),
    ay: bottom,
    body: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
  };
}

/** Palette-indexed → RGBA bytes. */
export function frameToRgba(frame: SpriteFrame, colors: string[], flip = false): Uint8ClampedArray {
  const out = new Uint8ClampedArray(frame.w * frame.h * 4);
  const rgb = colors.map((c) => {
    const n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  });
  for (let y = 0; y < frame.h; y++)
    for (let x = 0; x < frame.w; x++) {
      const sx = flip ? frame.w - 1 - x : x;
      const v = frame.px[y * frame.w + sx];
      if (!v) continue;
      const o = (y * frame.w + x) * 4;
      const c = rgb[v];
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = 255;
    }
  return out;
}

export function paletteArray(p: BlobPalette): string[] {
  return ['#000000', p.outline, p.body, p.shade, p.deep, p.highlight, p.cheek, p.eye, p.sparkle];
}
