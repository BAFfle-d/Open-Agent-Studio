/**
 * Renders a sprite sheet PNG (all skins × expressions) for eyeballing the
 * procedural blob against assets/reference/. Output: scripts/out/sprites.png
 */
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { BUILTIN_SKINS, CLASSIC_SHAPE, type ShapeSpec } from '@blurb/shared';
import { buildBlob, frameToRgba, paletteArray, DEFAULT_POSE, type Pose } from '../packages/render/src/sprite.ts';

const SCALE = Number(process.env.SCALE ?? 8);
const poses: Array<Partial<Pose>> = [
  { arm: 'wave1' },
  {},
  { eyes: 'closed', mouth: 'small' },
  { eyes: 'happy', mouth: 'grin', blush: true },
  { eyes: 'excited', mouth: 'open', arm: 'up' },
  { eyes: 'look_up', mouth: 'flat' },
  { eyes: 'sleepy', mouth: 'small', dh: -2, dw: 2 },
  { eyes: 'confused', mouth: 'wavy' },
  { eyes: 'sad', mouth: 'frown' },
  { dw: 4, dh: -4 },
  { dw: -3, dh: 4, arm: 'up' },
];
const extraShapes: ShapeSpec[] = [
  { ...CLASSIC_SHAPE, peak: 'pointy', ears: 'tufts', feet: 3, lean: -0.2 },
  { ...CLASSIC_SHAPE, peak: 'flat', ears: 'nubs', feet: 4, width: 34, height: 20, lean: 0 },
];
const cell = 56;
const rows = BUILTIN_SKINS.length + 1;
const cols = poses.length;
const png = new PNG({ width: cols * cell * SCALE, height: rows * cell * SCALE });
png.data.fill(0);
for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 24; png.data[i + 1] = 20; png.data[i + 2] = 30; png.data[i + 3] = 255; }
function blit(frame: ReturnType<typeof buildBlob>, rgba: Uint8ClampedArray, cx: number, cy: number) {
  const ox = cx * cell + Math.floor((cell - frame.w) / 2);
  const oy = cy * cell + Math.floor((cell - frame.h) / 2);
  for (let y = 0; y < frame.h; y++) for (let x = 0; x < frame.w; x++) {
    const s = (y * frame.w + x) * 4;
    if (!rgba[s + 3]) continue;
    for (let sy = 0; sy < SCALE; sy++) for (let sx = 0; sx < SCALE; sx++) {
      const d = (((oy + y) * SCALE + sy) * png.width + (ox + x) * SCALE + sx) * 4;
      png.data[d] = rgba[s]; png.data[d + 1] = rgba[s + 1]; png.data[d + 2] = rgba[s + 2]; png.data[d + 3] = 255;
    }
  }
}
BUILTIN_SKINS.forEach((skin, r) => {
  poses.forEach((p, c) => {
    const f = buildBlob(CLASSIC_SHAPE, { ...DEFAULT_POSE, ...p });
    blit(f, frameToRgba(f, paletteArray(skin.palette)), c, r);
  });
});
extraShapes.forEach((s, c) => {
  const f = buildBlob(s, { ...DEFAULT_POSE, arm: 'wave1' });
  blit(f, frameToRgba(f, paletteArray(BUILTIN_SKINS[c % 3].palette)), c, rows - 1);
});
mkdirSync('scripts/out', { recursive: true });
writeFileSync('scripts/out/sprites.png', PNG.sync.write(png));
console.log('wrote scripts/out/sprites.png', png.width, png.height);
