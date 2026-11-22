/**
 * Transparent, click-through desktop layer. Main decides when this window
 * accepts the mouse (only over Blurb or an open menu); everything else passes
 * through to the apps underneath.
 */
import { useEffect, useRef, useState } from 'react';
import { Emitter, Particles, drawBubble, drawPet } from '@blurb/render';
import { api } from '../api';
import type { OverlayFrame } from '../../../ipc-types';

interface Press {
  sx: number;
  sy: number;
  dragging: boolean;
}

const MENU: Array<{ id: string; icon: string; label: string }> = [
  { id: 'chat', icon: '💬', label: 'Chat' },
  { id: 'pet', icon: '🤚', label: 'Pet' },
  { id: 'snack', icon: '🍪', label: 'Snack' },
  { id: 'nap', icon: '😴', label: 'Nap' },
  { id: 'look', icon: '📷', label: 'Look at my screen' },
  { id: 'home', icon: '🏠', label: 'Go home' },
];

export function OverlayApp() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<OverlayFrame | null>(null);
  const press = useRef<Press | null>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [chatAt, setChatAt] = useState<{ x: number; y: number } | null>(null);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const menuOpen = useRef(false);
  menuOpen.current = !!menuAt || !!chatAt;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const particles = new Particles();
    const emitter = new Emitter(particles);
    const off = api.onOverlay((f) => (frameRef.current = f));
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(innerWidth * dpr);
      canvas.height = Math.round(innerHeight * dpr);
    };
    resize();
    addEventListener('resize', resize);
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const f = frameRef.current;
      if (f?.visible) {
        const s = f.scale * dpr;
        ctx.setTransform(s, 0, 0, s, 0, 0);
        ctx.imageSmoothingEnabled = false;
        const drawn = drawPet(
          ctx,
          { activity: f.activity, emotion: f.emotion, gesture: f.gesture, facing: f.facing, palette: f.palette, shape: f.shape, vx: 40 },
          Math.round(f.x / f.scale),
          Math.round(f.y / f.scale),
          now / 1000,
          1,
          3,
        );
        emitter.tick(dt, f.activity, f.emotion, drawn.body.x + drawn.body.w / 2, drawn.body.y, drawn.body.y + drawn.body.h * 0.6);
        particles.update(dt);
        particles.draw(ctx);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        // Bubble would sit under the radial menu / chat box, so hide it while they're open.
        if (!menuOpen.current && (f.speech?.text || f.speech?.streaming)) {
          drawBubble(ctx, f.speech.text || '…', (drawn.body.x + drawn.body.w / 2) * s, drawn.body.y * s - 4 * dpr, canvas.width, dpr, !!f.speech.streaming);
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener('resize', resize);
      off();
    };
  }, []);

  // Tell main which screen areas must stay clickable (menu / chat bubble).
  useEffect(() => {
    const regions = [];
    if (menuAt) regions.push({ x: menuAt.x - 110, y: menuAt.y - 140, w: 220, h: 200 });
    if (chatAt) regions.push({ x: chatAt.x - 170, y: chatAt.y - 70, w: 340, h: 64 });
    api.overlayRegions(regions);
    api.overlayFocus(!!chatAt);
    if (chatAt) setTimeout(() => inputRef.current?.focus(), 30);
  }, [menuAt, chatAt]);

  const overPet = (x: number, y: number) => {
    const f = frameRef.current;
    if (!f?.visible) return false;
    const halfW = ((f.shape.width + 10) * f.scale) / 2;
    const h = (f.shape.height + 8) * f.scale;
    return Math.abs(x - f.x) < halfW && y <= f.y + 4 && y >= f.y - h;
  };

  const anchor = () => {
    const f = frameRef.current!;
    return { x: f.x, y: f.y - (f.shape.height + 4) * f.scale };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!overPet(e.clientX, e.clientY)) {
      setMenuAt(null);
      return;
    }
    (e.target as Element).setPointerCapture(e.pointerId);
    press.current = { sx: e.clientX, sy: e.clientY, dragging: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p || p.dragging) return;
    if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 6) {
      p.dragging = true;
      setMenuAt(null);
      void api.overlayDragStart();
    }
  };

  const onPointerUp = () => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    if (p.dragging) void api.overlayDragEnd();
    else setMenuAt((m) => (m ? null : anchor()));
  };

  const choose = (id: string) => {
    const at = anchor();
    setMenuAt(null);
    if (id === 'chat') setChatAt(at);
    if (id === 'pet') void api.overlayPet();
    if (id === 'snack') void api.giveTreat();
    if (id === 'nap') void api.overlayNap();
    if (id === 'look') void api.askScreen('What do you see on my screen?');
    if (id === 'home') void api.goHome();
  };

  return (
    <div className="overlay-root" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <canvas ref={canvasRef} className="overlay-canvas" />
      {menuAt && (
        <div className="radial" style={{ left: menuAt.x, top: menuAt.y }} onPointerDown={(e) => e.stopPropagation()}>
          {MENU.map((m, i) => {
            const a = Math.PI + (i / (MENU.length - 1)) * Math.PI;
            return (
              <button
                key={m.id}
                className="radial-btn"
                style={{ transform: `translate(${Math.cos(a) * 82}px, ${Math.sin(a) * 82 - 10}px)` }}
                title={m.label}
                aria-label={m.label}
                onClick={() => choose(m.id)}
              >
                {m.icon}
              </button>
            );
          })}
        </div>
      )}
      {chatAt && (
        <form
          className="quick-chat"
          style={{ left: chatAt.x, top: chatAt.y - 64 }}
          onPointerDown={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void api.chat(text.trim());
            setText('');
            setChatAt(null);
          }}
        >
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setChatAt(null)}
            placeholder="Say something… (Esc to close)"
            aria-label="Message Blurb"
          />
          <button type="submit">➤</button>
        </form>
      )}
    </div>
  );
}
