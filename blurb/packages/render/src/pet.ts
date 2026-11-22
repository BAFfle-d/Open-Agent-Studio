/** Turns pet state (activity, emotion, gesture) into an animated sprite. */
import type { Activity, BlobPalette, Emotion, Gesture, ShapeSpec } from '@blurb/shared';
import { buildBlob, DEFAULT_POSE, frameToRgba, paletteArray, type Pose, type SpriteFrame } from './sprite.js';
import type { Ctx } from './pixel.js';

export interface PetLook {
  activity: Activity | string;
  emotion: Emotion;
  gesture?: Gesture;
  facing: 'l' | 'r';
  palette: BlobPalette;
  shape: ShapeSpec;
  /** Horizontal speed, drives the hop. */
  vx: number;
}

const FACE: Record<Emotion, Pick<Pose, 'eyes' | 'mouth' | 'blush'>> = {
  neutral: { eyes: 'open', mouth: 'smile', blush: false },
  happy: { eyes: 'open', mouth: 'grin', blush: false },
  excited: { eyes: 'excited', mouth: 'open', blush: true },
  thinking: { eyes: 'look_up', mouth: 'flat', blush: false },
  sleepy: { eyes: 'sleepy', mouth: 'small', blush: false },
  confused: { eyes: 'confused', mouth: 'wavy', blush: false },
  sad: { eyes: 'sad', mouth: 'frown', blush: false },
  love: { eyes: 'happy', mouth: 'grin', blush: true },
};

export interface PoseResult {
  pose: Pose;
  /** Pixels the sprite is lifted off the ground (hops, dances). */
  lift: number;
  /** Small horizontal wobble. */
  wobble: number;
}

/**
 * Pure function of (look, time). `seed` desyncs blinks between instances.
 */
export function poseFor(look: PetLook, t: number, seed = 0): PoseResult {
  const face = { ...FACE[look.emotion] };
  let dw = 0;
  let dh = 0;
  let lift = 0;
  let wobble = 0;
  let arm: Pose['arm'] = 'down';
  const breathe = Math.sin(t * 2.4 + seed) > 0.6 ? 1 : 0;

  switch (look.activity) {
    case 'walking':
    case 'desktop_wander':
    case 'wandering': {
      // hop cycle: crouch → stretch in the air → land squash
      const speed = Math.min(1.6, Math.abs(look.vx) / 30 + 0.6);
      const p = (t * 2.6 * speed + seed) % 1;
      if (p < 0.18) (dw = 2), (dh = -2);
      else if (p < 0.7) {
        dw = -1;
        dh = 2;
        lift = Math.round(Math.sin(((p - 0.18) / 0.52) * Math.PI) * 5);
      } else (dw = 1), (dh = -1);
      break;
    }
    case 'desktop_chase_cursor':
    case 'playing_chase':
    case 'playing': {
      const p = (t * 3.2 + seed) % 1;
      lift = Math.round(Math.abs(Math.sin(p * Math.PI)) * 7);
      if (lift < 1) (dw = 3), (dh = -3);
      else (dw = -1), (dh = 2);
      face.eyes = 'excited';
      face.mouth = 'open';
      arm = p < 0.5 ? 'wave1' : 'wave2';
      break;
    }
    case 'sleeping':
    case 'desktop_nap':
    case 'napping':
      face.eyes = 'closed';
      face.mouth = 'small';
      face.blush = false;
      dh = Math.sin(t * 1.3 + seed) > 0 ? -3 : -2;
      dw = -dh;
      arm = 'none';
      break;
    case 'eating': {
      const chomp = Math.floor(t * 5) % 2 === 0;
      face.mouth = chomp ? 'open' : 'chomp';
      face.eyes = chomp ? 'open' : 'happy';
      dh = chomp ? 0 : -1;
      dw = -dh;
      break;
    }
    case 'reading':
    case 'coding':
      if (look.emotion === 'neutral' || look.emotion === 'happy') {
        face.eyes = 'look_up';
        face.mouth = look.activity === 'coding' ? 'flat' : 'small';
      }
      dh = breathe ? -1 : 0;
      dw = breathe;
      if (look.activity === 'coding') arm = Math.floor(t * 6) % 2 ? 'wave1' : 'up';
      break;
    case 'building':
    case 'foraging':
      arm = Math.floor(t * 4) % 2 ? 'up' : 'wave2';
      dh = Math.floor(t * 4) % 2 ? -1 : 1;
      dw = -dh;
      break;
    case 'being_pet':
      face.eyes = 'happy';
      face.mouth = 'grin';
      face.blush = true;
      dh = Math.sin(t * 8) > 0 ? -2 : -1;
      dw = 2;
      wobble = Math.round(Math.sin(t * 8));
      break;
    case 'dragged':
      dh = 4;
      dw = -3;
      arm = 'up';
      face.eyes = look.emotion === 'happy' || look.emotion === 'excited' ? 'excited' : 'confused';
      face.mouth = 'open';
      wobble = Math.round(Math.sin(t * 9) * 1.5);
      break;
    case 'falling':
      dh = 3;
      dw = -2;
      arm = 'up';
      face.mouth = 'open';
      break;
    case 'checking_dropbox':
    case 'writing_note':
      arm = Math.floor(t * 3) % 2 ? 'up' : 'down';
      break;
    case 'perched':
    case 'desktop_window_sit':
      dh = breathe ? -2 : -1;
      dw = -dh;
      arm = 'none';
      break;
    default:
      dh = breathe ? -1 : 0;
      dw = breathe;
  }

  if (look.gesture === 'wave') arm = Math.floor(t * 6) % 2 ? 'wave1' : 'wave2';
  if (look.gesture === 'dance') {
    const p = (t * 4) % 1;
    lift = Math.round(Math.abs(Math.sin(p * Math.PI)) * 4);
    wobble = Math.round(Math.sin(t * 8) * 2);
    arm = p < 0.5 ? 'wave1' : 'up';
    face.eyes = 'happy';
    face.mouth = 'grin';
  }
  if (look.gesture === 'hop') {
    lift = Math.round(Math.abs(Math.sin(t * 7)) * 6);
  }

  // blink every ~4 s for ~120 ms
  if ((face.eyes === 'open' || face.eyes === 'look_up' || face.eyes === 'sad') && (t + seed * 1.7) % 4.1 < 0.12) {
    face.eyes = 'closed';
  }

  return { pose: { ...DEFAULT_POSE, ...face, dw, dh, arm }, lift, wobble };
}

// ---------------------------------------------------------------------------
// Sprite cache
// ---------------------------------------------------------------------------

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

export function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

interface CachedSprite {
  canvas: AnyCanvas;
  frame: SpriteFrame;
}

const cache = new Map<string, CachedSprite>();
const frameCache = new Map<string, SpriteFrame>();
const MAX_CACHE = 600;

export function getFrame(shape: ShapeSpec, pose: Pose): SpriteFrame {
  const key = JSON.stringify([shape, pose]);
  let f = frameCache.get(key);
  if (!f) {
    f = buildBlob(shape, pose);
    if (frameCache.size > MAX_CACHE) frameCache.clear();
    frameCache.set(key, f);
  }
  return f;
}

export function getSprite(shape: ShapeSpec, pose: Pose, palette: BlobPalette, flip: boolean): CachedSprite {
  const key = JSON.stringify([shape, pose, palette, flip]);
  let s = cache.get(key);
  if (s) return s;
  const frame = getFrame(shape, pose);
  const canvas = makeCanvas(frame.w, frame.h);
  const c = canvas.getContext('2d') as Ctx;
  const img = c.createImageData(frame.w, frame.h);
  img.data.set(frameToRgba(frame, paletteArray(palette), flip));
  c.putImageData(img, 0, 0);
  s = { canvas, frame };
  if (cache.size > MAX_CACHE) cache.clear();
  cache.set(key, s);
  return s;
}

export interface DrawnPet {
  /** Body rect in the destination's coordinates, for hit tests and bubbles. */
  body: { x: number; y: number; w: number; h: number };
}

/**
 * Draw the pet with its feet at (x, y) in the destination's pixel space.
 * `scale` is an integer upscale (1 inside the world canvas; >1 for overlay).
 */
export function drawPet(ctx: Ctx, look: PetLook, x: number, y: number, t: number, scale = 1, seed = 0): DrawnPet {
  const { pose, lift, wobble } = poseFor(look, t, seed);
  const flip = look.facing === 'l';
  const { canvas, frame } = getSprite(look.shape, pose, look.palette, flip);
  const ax = flip ? frame.w - 1 - frame.ax : frame.ax;
  const dx = Math.round(x - ax * scale + wobble * scale);
  const dy = Math.round(y - (frame.ay + 1) * scale - lift * scale);
  // soft shadow
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  const sw = Math.max(6, frame.body.w - 6 - lift) * scale;
  ctx.fillRect(Math.round(x - sw / 2), Math.round(y - scale), Math.round(sw), Math.max(1, scale));
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas as CanvasImageSource, dx, dy, frame.w * scale, frame.h * scale);
  const bx = flip ? frame.w - frame.body.x - frame.body.w : frame.body.x;
  return {
    body: { x: dx + bx * scale, y: dy + frame.body.y * scale, w: frame.body.w * scale, h: frame.body.h * scale },
  };
}
