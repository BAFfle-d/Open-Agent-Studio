import { useEffect, useRef } from 'react';
import { WorldRenderer } from '@blurb/render';
import type { PublicState } from '@blurb/shared';

interface Props {
  subscribe: (fn: (s: PublicState) => void) => () => void;
  initial?: PublicState;
  burst?: { kind: 'treat' | 'build' | 'pet' | 'magic'; n: number };
}

/** The live world mirror: same renderer as the desktop app. */
export function LiveView({ subscribe, initial, burst }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WorldRenderer | undefined>(undefined);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const r = new WorldRenderer(canvas);
    rendererRef.current = r;
    if (initial) r.setState(initial);
    const unsub = subscribe((s) => r.setState(s));
    const ro = new ResizeObserver(([e]) => r.resize(e.contentRect.width, e.contentRect.height));
    ro.observe(canvas);
    let raf = 0;
    const loop = (t: number) => {
      r.frame(t, { showName: true });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (burst?.n) rendererRef.current?.burst(burst.kind);
  }, [burst?.n]);

  return <canvas ref={canvasRef} className="live-canvas" aria-label="Live view of Blurb's world" />;
}
