/** Tiny canvases: a blob in a given skin/shape, or a world object. */
import { useEffect, useRef } from 'react';
import { DEFAULT_POSE, OBJECT_DRAWERS, drawResource, getSprite, type Pose } from '@blurb/render';
import { OBJECT_DEFS, WORLD, type BlobPalette, type ObjectKind, type ResourceKind, type ShapeSpec } from '@blurb/shared';

export function BlobThumb({ palette, shape, size = 56, pose }: { palette: BlobPalette; shape: ShapeSpec; size?: number; pose?: Partial<Pose> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    const { canvas, frame } = getSprite(shape, { ...DEFAULT_POSE, ...pose }, palette, false);
    // Scale by the body (frames include padding for arms/ears). Prefer integer
    // scales for crisp pixels unless that would waste most of the tile.
    const b = frame.body;
    const raw = Math.min((size - 4) / b.w, (size - 4) / b.h);
    const s = Math.max(1, Math.floor(raw) / raw > 0.75 ? Math.floor(raw) : raw);
    c.width = size;
    c.height = size;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(canvas as CanvasImageSource, b.x, b.y, b.w, b.h, Math.round((size - b.w * s) / 2), Math.round((size - b.h * s) / 2), b.w * s, b.h * s);
  }, [palette, shape, size, pose]);
  return <canvas ref={ref} className="pix" width={size} height={size} aria-hidden />;
}

export function ObjectThumb({ kind, color, size = 40 }: { kind: ObjectKind | `resource:${ResourceKind}`; color?: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    c.width = size;
    c.height = size;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);
    const isRes = kind.startsWith('resource:');
    const k: ObjectKind = isRes ? 'resource' : (kind as ObjectKind);
    const def = OBJECT_DEFS[k];
    const w = isRes ? 8 : def.width;
    const h = isRes ? 7 : k === 'rug' ? 8 : def.height + (k === 'comm_box' ? 8 : 2);
    const s = Math.max(1, Math.min(size / (w + 2), size / (h + 2)));
    ctx.save();
    ctx.translate(size / 2, size - 2);
    ctx.scale(s, s);
    ctx.translate(-w / 2, -WORLD.floorY - (k === 'rug' ? 4 : 0));
    if (isRes) drawResource(ctx, kind.slice(9) as ResourceKind, 0, WORLD.floorY);
    else OBJECT_DRAWERS[k](ctx, { id: 'thumb', k, x: 0, c: color ?? def.defaultColor, s: k === 'food_bowl' ? 2 : undefined }, { t: 0, night: 0 });
    ctx.restore();
  }, [kind, color, size]);
  return <canvas ref={ref} className="pix" width={size} height={size} aria-hidden />;
}
