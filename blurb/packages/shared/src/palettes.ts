import type { BlobPalette, ShapeDesign, ShapeSpec, SkinDesign } from './types.js';

/**
 * Palettes sampled from the three reference sprites in assets/reference/.
 * (Dominant-color histogram over the 1536x1024 renders, quantized.)
 */
export const BUILTIN_SKINS: SkinDesign[] = [
  {
    id: 'red',
    name: 'Cherry',
    origin: 'builtin',
    palette: {
      outline: '#3a0008',
      body: '#ff0a28',
      shade: '#a80018',
      deep: '#78000f',
      highlight: '#f8a890',
      cheek: '#f8a890',
      eye: '#3a0008',
      sparkle: '#ffffff',
    },
  },
  {
    id: 'pink',
    name: 'Bubblegum',
    origin: 'builtin',
    palette: {
      outline: '#480c30',
      body: '#fcb4d8',
      shade: '#e06898',
      deep: '#b43c6c',
      highlight: '#fce4f0',
      cheek: '#fce4f0',
      eye: '#480c30',
      sparkle: '#ffffff',
    },
  },
  {
    id: 'blue',
    name: 'Glacier',
    origin: 'builtin',
    palette: {
      outline: '#001848',
      body: '#80d0f8',
      shade: '#58a8f0',
      deep: '#1870d0',
      highlight: '#e8f8f8',
      cheek: '#b0e8f8',
      eye: '#001848',
      sparkle: '#ffffff',
    },
  },
];

export const CLASSIC_SHAPE: ShapeSpec = {
  width: 30,
  height: 24,
  peak: 'round',
  lean: 0.25,
  feet: 2,
  ears: 'none',
  gloss: true,
};

export const BUILTIN_SHAPES: ShapeDesign[] = [{ id: 'classic', name: 'Classic Blob', spec: CLASSIC_SHAPE, origin: 'builtin' }];

/** Hard limits on any shape, builtin or designed. Keeps sprites renderable. */
export const SHAPE_LIMITS = {
  width: { min: 18, max: 40 },
  height: { min: 14, max: 32 },
  lean: { min: -0.6, max: 0.6 },
  feet: { min: 0, max: 4 },
} as const;

export function clampShape(spec: Partial<ShapeSpec>): ShapeSpec {
  const c = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  return {
    width: Math.round(c(spec.width, SHAPE_LIMITS.width.min, SHAPE_LIMITS.width.max, CLASSIC_SHAPE.width)),
    height: Math.round(c(spec.height, SHAPE_LIMITS.height.min, SHAPE_LIMITS.height.max, CLASSIC_SHAPE.height)),
    peak: spec.peak === 'pointy' || spec.peak === 'flat' || spec.peak === 'round' ? spec.peak : 'round',
    lean: c(spec.lean, SHAPE_LIMITS.lean.min, SHAPE_LIMITS.lean.max, CLASSIC_SHAPE.lean),
    feet: Math.round(c(spec.feet, SHAPE_LIMITS.feet.min, SHAPE_LIMITS.feet.max, CLASSIC_SHAPE.feet)),
    ears: spec.ears === 'nubs' || spec.ears === 'tufts' || spec.ears === 'none' ? spec.ears : 'none',
    gloss: typeof spec.gloss === 'boolean' ? spec.gloss : true,
  };
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

const HEX_RE = /^#([0-9a-f]{6})$/i;

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX_RE.test(v);
}

/** Accepts #rgb, #rrggbb, or a small set of named colors. Returns null if not a color. */
export function normalizeColor(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (HEX_RE.test(s)) return s;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return NAMED_COLORS[s] ?? null;
}

export const NAMED_COLORS: Record<string, string> = {
  red: '#e8303a',
  pink: '#f48fb1',
  orange: '#f39c34',
  yellow: '#f5d442',
  green: '#4caf50',
  mint: '#7fe0b0',
  teal: '#26a69a',
  blue: '#3f7fdc',
  sky: '#80d0f8',
  purple: '#9b59d0',
  lavender: '#c3a6f0',
  brown: '#8d5a3b',
  tan: '#d2b48c',
  white: '#f4f4f4',
  gray: '#9a9a9a',
  grey: '#9a9a9a',
  black: '#2a2a2e',
  gold: '#e0b23a',
  coral: '#ff7f6a',
};

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = Math.min(1, Math.max(0, s));
  l = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgbToHex((rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255);
}

export function shiftLightness(hex: string, delta: number, satDelta = 0): string {
  const [h, s, l] = rgbToHsl(...hexToRgb(hex));
  return hslToHex(h, s + satDelta, l + delta);
}

export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

/**
 * Derive a full blob palette from one body color, following the same
 * light/shade structure as the reference sprites.
 */
export function paletteFromBody(body: string): BlobPalette {
  const [h, s, l] = rgbToHsl(...hexToRgb(body));
  return {
    outline: hslToHex(h, Math.min(1, s + 0.2), 0.11),
    body,
    shade: hslToHex(h, Math.min(1, s + 0.1), Math.max(0.12, l - 0.17)),
    deep: hslToHex(h, Math.min(1, s + 0.1), Math.max(0.08, l - 0.3)),
    highlight: mix(body, '#ffffff', 0.62),
    cheek: mix(body, '#ffffff', 0.5),
    eye: hslToHex(h, Math.min(1, s + 0.2), 0.11),
    sparkle: '#ffffff',
  };
}
