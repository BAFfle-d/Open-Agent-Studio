/** Renders the app + tray icons from the procedural sprite. */
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { BUILTIN_SKINS, CLASSIC_SHAPE } from '@blurb/shared';
import { buildBlob, frameToRgba, paletteArray, DEFAULT_POSE } from '../packages/render/src/sprite.ts';

const f = buildBlob(CLASSIC_SHAPE, { ...DEFAULT_POSE, arm: 'wave1' });
const rgba = frameToRgba(f, paletteArray(BUILTIN_SKINS[0].palette));
for (const size of [16, 32, 64, 256, 512]) {
  const png = new PNG({ width: size, height: size });
  const s = Math.max(1, Math.floor(Math.min(size / f.body.w, size / f.body.h) * 0.98));
  const ox = Math.floor((size - f.body.w * s) / 2) - f.body.x * s;
  const oy = Math.floor((size - f.body.h * s) / 2) - f.body.y * s;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx = Math.floor((x - ox) / s), sy = Math.floor((y - oy) / s);
    const d = (y * size + x) * 4;
    if (sx < 0 || sy < 0 || sx >= f.w || sy >= f.h) continue;
    const i = (sy * f.w + sx) * 4;
    png.data[d] = rgba[i]; png.data[d + 1] = rgba[i + 1]; png.data[d + 2] = rgba[i + 2]; png.data[d + 3] = rgba[i + 3];
  }
  mkdirSync('packages/desktop/resources', { recursive: true });
  writeFileSync(`packages/desktop/resources/icon-${size}.png`, PNG.sync.write(png));
}
console.log('icons written');
