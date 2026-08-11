/**
 * Icon Generator for Juju PWA
 * Generates icons from the brand mark (a bold "J" monogram on the violet
 * gradient). Sizes: 192px and 512px, both "any" and "maskable" variants.
 *
 * Usage: node scripts/generate-icons.js
 * Dependencies: sharp (devDependency)
 */

import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(__dirname, '..', 'public', 'icons');

mkdirSync(ICONS_DIR, { recursive: true });

/** Brand mark: a bold "J" monogram (white stroke) on the violet→indigo gradient tile. */
const MARK_PATH = 'M104 46 L104 100 Q104 122 82 124 Q58 126 50 104';

/** Common gradient defs: brand violet→indigo ramp + subtle top sheen (glass character). */
const DEFS = `<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="160" y2="160" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#A78BFA"/>
      <stop offset="46%" stop-color="#8B5CF6"/>
      <stop offset="100%" stop-color="#6D28D9"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="160" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.24"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>`;

const MARK = `<path d="${MARK_PATH}" fill="none" stroke="#ffffff" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/>`;

/** Logo SVG (any): rounded corners, gradient background + sheen */
function createLogoSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 160 160" fill="none">
  ${DEFS}
  <rect width="160" height="160" rx="36" fill="url(#bg)"/>
  <rect width="160" height="160" rx="36" fill="url(#sheen)"/>
  ${MARK}
</svg>`;
}

/** Maskable logo SVG: full-bleed background (no rx), mark within safe zone */
function createMaskableLogoSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 160 160" fill="none">
  ${DEFS}
  <rect width="160" height="160" fill="url(#bg)"/>
  <rect width="160" height="160" fill="url(#sheen)"/>
  <g transform="translate(8,8) scale(0.9)">${MARK}</g>
</svg>`;
}

/** Apple Touch Icon (180x180): same as any-icon */
function createAppleTouchSvg() {
  return createLogoSvg(180);
}

/** Favicon (32x32): simplified - gradient background with the "J" mark */
function createFaviconSvg() {
  return createLogoSvg(32);
}

const icons = [
  { name: 'icon-192.png',          size: 192, svg: createLogoSvg(192)         },
  { name: 'icon-512.png',          size: 512, svg: createLogoSvg(512)         },
  { name: 'icon-maskable-192.png', size: 192, svg: createMaskableLogoSvg(192) },
  { name: 'icon-maskable-512.png', size: 512, svg: createMaskableLogoSvg(512) },
  { name: 'apple-touch-icon.png',  size: 180, svg: createAppleTouchSvg()      },
  { name: 'favicon-32.png',        size: 32,  svg: createFaviconSvg()         },
];

for (const icon of icons) {
  const outputPath = join(ICONS_DIR, icon.name);
  await sharp(Buffer.from(icon.svg))
    .png()
    .toFile(outputPath);
  console.log(`  ✓ ${icon.name} (${icon.size}x${icon.size})`);
}

console.log('\nIcons generated in public/icons/');
