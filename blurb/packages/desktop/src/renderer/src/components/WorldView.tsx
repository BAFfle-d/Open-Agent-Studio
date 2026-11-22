/**
 * The little world. Click Blurb to pet, drag Blurb to carry, click an object
 * to ask Blurb to use it, drag an object to rearrange, right-click an object
 * to recolor/remove, drag items in from the palette.
 */
import { useEffect, useRef, useState } from 'react';
import { WorldRenderer } from '@blurb/render';
import { OBJECT_DEFS, WORLD, type PublicObject, type PublicState } from '@blurb/shared';
import { api } from '../api';
import type { PlaceKind } from '../../../ipc-types';

export const DRAG_MIME = 'application/x-blurb-item';

interface Props {
  onBurstRef: (fn: (kind: 'treat' | 'build' | 'pet' | 'magic', x?: number, y?: number) => void) => void;
}

type Press =
  | { type: 'pet'; sx: number; sy: number; dragging: boolean; lastPat: number }
  | { type: 'obj'; obj: PublicObject; sx: number; dragging: boolean; offset: number };

export function WorldView({ onBurstRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const r = useRef<WorldRenderer | null>(null);
  const press = useRef<Press | null>(null);
  const hover = useRef<string | undefined>(undefined);
  const ghost = useRef<{ kind: PlaceKind; x: number } | null>(null);
  const objMove = useRef<{ id: string; x: number } | null>(null);
  const petOverride = useRef<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ obj: PublicObject; left: number; top: number } | null>(null);
  const [cursor, setCursor] = useState('default');

  useEffect(() => {
    const canvas = canvasRef.current!;
    const renderer = new WorldRenderer(canvas);
    r.current = renderer;
    onBurstRef((k, x, y) => renderer.burst(k, x, y));
    const off = api.onState((s: PublicState) => {
      if (objMove.current) {
        const m = objMove.current;
        s = { ...s, objects: s.objects.map((o) => (o.id === m.id ? { ...o, x: m.x } : o)) };
      }
      renderer.setState(s);
    });
    const ro = new ResizeObserver(([e]) => renderer.resize(e.contentRect.width, e.contentRect.height));
    ro.observe(canvas);
    let raf = 0;
    const loop = (t: number) => {
      const g = ghost.current;
      renderer.frame(t, {
        hoverId: hover.current,
        petOverride: petOverride.current ?? undefined,
        ghost: g && !g.kind.startsWith('resource:') ? { kind: g.kind as never, x: g.x - OBJECT_DEFS[g.kind as keyof typeof OBJECT_DEFS].width / 2 } : undefined,
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toWorld = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return r.current!.toWorld(e.clientX - rect.left, e.clientY - rect.top);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setMenu(null);
    const w = toWorld(e);
    const renderer = r.current!;
    canvasRef.current!.setPointerCapture(e.pointerId);
    if (renderer.hitPet(w.x, w.y)) {
      press.current = { type: 'pet', sx: w.x, sy: w.y, dragging: false, lastPat: 0 };
      return;
    }
    const obj = renderer.hitObject(w.x, w.y);
    if (obj) press.current = { type: 'obj', obj, sx: w.x, dragging: false, offset: w.x - (obj.x + OBJECT_DEFS[obj.k].width / 2) };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const w = toWorld(e);
    const p = press.current;
    if (!p) {
      const renderer = r.current!;
      const overPet = renderer.hitPet(w.x, w.y);
      const obj = overPet ? undefined : renderer.hitObject(w.x, w.y);
      hover.current = obj?.id;
      setCursor(overPet ? 'grab' : obj ? 'pointer' : 'default');
      return;
    }
    if (p.type === 'pet') {
      const dist = Math.hypot(w.x - p.sx, w.y - p.sy);
      if (!p.dragging && dist > 6) {
        p.dragging = true;
        setCursor('grabbing');
        void api.dragStart();
      }
      if (p.dragging) {
        const pos = { x: Math.max(8, Math.min(WORLD.width - 8, w.x)), y: Math.max(30, Math.min(WORLD.floorY, w.y + 12)) };
        petOverride.current = pos;
        void api.dragMove(pos.x, pos.y);
      } else if (dist > 1 && performance.now() - p.lastPat > 350) {
        // little strokes while holding = petting
        p.lastPat = performance.now();
        void api.petContinue();
      }
    } else {
      if (!p.dragging && Math.abs(w.x - p.sx) > 4) p.dragging = true;
      if (p.dragging) {
        objMove.current = { id: p.obj.id, x: Math.round(w.x - p.offset - OBJECT_DEFS[p.obj.k].width / 2) };
        setCursor('grabbing');
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const p = press.current;
    press.current = null;
    setCursor('default');
    if (!p) return;
    const w = toWorld(e);
    if (p.type === 'pet') {
      if (p.dragging) {
        void api.dragEnd();
        setTimeout(() => (petOverride.current = null), 60);
      } else {
        void api.petStart();
        r.current?.burst('pet');
      }
    } else if (p.dragging) {
      void api.moveObject(p.obj.id, w.x - p.offset).finally(() => setTimeout(() => (objMove.current = null), 120));
    } else {
      void api.useObject(p.obj.id);
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const w = toWorld(e);
    const obj = r.current!.hitObject(w.x, w.y);
    if (!obj) return setMenu(null);
    const rect = canvasRef.current!.getBoundingClientRect();
    setMenu({ obj, left: Math.min(e.clientX - rect.left, rect.width - 220), top: Math.min(e.clientY - rect.top, rect.height - 160) });
  };

  const onDragOver = (e: React.DragEvent) => {
    const kind = e.dataTransfer.types.includes(DRAG_MIME) ? (window as unknown as { __blurbDrag?: PlaceKind }).__blurbDrag : undefined;
    if (!kind) return;
    e.preventDefault();
    ghost.current = { kind, x: toWorld(e).x };
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const kind = e.dataTransfer.getData(DRAG_MIME) as PlaceKind | 'treat';
    ghost.current = null;
    if (!kind) return;
    const w = toWorld(e);
    const target = r.current!.hitObject(w.x, w.y);
    if (kind === 'treat') {
      if (target?.k === 'drop_box') void api.dropToBox({ kind: 'treat', count: 1 });
      else void api.giveTreat();
      return;
    }
    if (target?.k === 'drop_box') {
      if (kind.startsWith('resource:')) void api.dropToBox({ kind: 'resource', resource: kind.slice(9) as never, count: 1 });
      else void api.dropToBox({ kind: 'object', objectKind: kind as never, count: 1 });
      r.current?.burst('magic', target.x + 11, WORLD.floorY - 20);
      return;
    }
    void api.place(kind, w.x);
  };

  const swatches = ['#e8303a', '#f48fb1', '#f39c34', '#f5d442', '#4caf50', '#26a69a', '#80d0f8', '#3f7fdc', '#9b59d0', '#8d5a3b', '#f4f4f4', '#2a2a2e'];
  const def = menu ? OBJECT_DEFS[menu.obj.k] : undefined;

  return (
    <div className="world-wrap" onDragLeave={() => (ghost.current = null)}>
      <canvas
        ref={canvasRef}
        className="world-canvas"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => (hover.current = undefined)}
        onContextMenu={onContextMenu}
        onDragOver={onDragOver}
        onDrop={onDrop}
        aria-label="Blurb's world. Click Blurb to pet, drag to carry. Click objects to have Blurb use them."
      />
      {menu && def && (
        <div className="obj-menu" style={{ left: menu.left, top: menu.top }} role="dialog" aria-label={`${def.label} options`}>
          <div className="obj-menu-title">{def.label}</div>
          {def.activity && (
            <button onClick={() => (void api.useObject(menu.obj.id), setMenu(null))}>Ask Blurb to use it</button>
          )}
          <div className="swatches">
            {swatches.map((c) => (
              <button key={c} className="swatch" style={{ background: c }} aria-label={`Paint ${c}`} onClick={() => (void api.recolorObject(menu.obj.id, c), setMenu(null))} />
            ))}
            <label className="swatch custom" title="Custom color">
              <input type="color" defaultValue={menu.obj.c} onChange={(e) => void api.recolorObject(menu.obj.id, e.target.value)} />
            </label>
          </div>
          {!def.unique && (
            <button className="danger" onClick={() => (void api.removeObject(menu.obj.id), setMenu(null))}>Remove</button>
          )}
        </div>
      )}
    </div>
  );
}

