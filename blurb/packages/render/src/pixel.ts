import { mix, shiftLightness } from '@blurb/shared';

export type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function rect(ctx: Ctx, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

export function dot(ctx: Ctx, x: number, y: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
}

/** Filled pixel circle (midpoint-ish), crisp at 1x. */
export function disc(ctx: Ctx, cx: number, cy: number, r: number, color: string) {
  ctx.fillStyle = color;
  const rr = r * r + r * 0.6;
  for (let y = -r; y <= r; y++) {
    let span = 0;
    while ((span + 1) * (span + 1) + y * y <= rr) span++;
    ctx.fillRect(Math.round(cx - span), Math.round(cy + y), span * 2 + 1, 1);
  }
}

/** Ellipse filled row by row. */
export function ellipse(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, color: string) {
  ctx.fillStyle = color;
  for (let y = -ry; y <= ry; y++) {
    const span = Math.round(rx * Math.sqrt(Math.max(0, 1 - (y * y) / (ry * ry + 0.5))));
    ctx.fillRect(Math.round(cx - span), Math.round(cy + y), span * 2 + 1, 1);
  }
}

export function outlinedRect(ctx: Ctx, x: number, y: number, w: number, h: number, fill: string, line: string) {
  rect(ctx, x, y, w, h, line);
  rect(ctx, x + 1, y + 1, w - 2, h - 2, fill);
}

export const dark = (c: string, d = 0.18) => shiftLightness(c, -d);
export const light = (c: string, d = 0.15) => shiftLightness(c, d);
export const ink = (c: string) => shiftLightness(c, -0.42, 0.05);
export { mix };

/** Deterministic hash → 0..1, for stable "random" decoration. */
export function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export function strHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}
