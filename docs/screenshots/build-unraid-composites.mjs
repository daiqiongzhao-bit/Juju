// Generates combined dark-mode desktop + mobile composites for the Unraid
// Community Apps screenshot gallery. Run from repo root:
//   node docs/screenshots/build-unraid-composites.mjs
//
// Colors mirror public/styles/tokens.css [data-theme="dark"].
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'unraid');

const CANVAS_W = 1920;
const CANVAS_H = 1200;

const BORDER = '#3D3D3A';

// Layout (px on the 1920x1200 canvas).
const DESK = { w: 1240, h: 775, x: 168, y: 212, r: 14, border: 1.5 };
const PHONE = { h: 900, x: 1330, y: 150, r: 40, border: 2 };
const PHONE_W = Math.round(PHONE.h * (1320 / 2867)); // keep mobile aspect ratio (iPhone 17 Pro Max portrait)

const modules = ['dashboard', 'calendar', 'meals', 'shopping', 'budget'];

function background() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#1B1B19"/>
        <stop offset="1" stop-color="#101010"/>
      </linearGradient>
      <radialGradient id="glow" cx="46%" cy="30%" r="62%">
        <stop offset="0" stop-color="#a78bfa" stop-opacity="0.20"/>
        <stop offset="55%" stop-color="#a78bfa" stop-opacity="0.04"/>
        <stop offset="100%" stop-color="#a78bfa" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="glow2" cx="86%" cy="86%" r="50%">
        <stop offset="0" stop-color="#2DD4BF" stop-opacity="0.10"/>
        <stop offset="100%" stop-color="#2DD4BF" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="url(#bg)"/>
    <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="url(#glow)"/>
    <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="url(#glow2)"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png();
}

// Resize (cover), round corners, draw inner border.
async function panel(file, w, h, r, borderW) {
  const resized = await sharp(file)
    .resize(w, h, { fit: 'cover', position: 'top' })
    .toBuffer();
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}"/></svg>`
  );
  const border = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="${borderW / 2}" y="${borderW / 2}" width="${w - borderW}" height="${h - borderW}" rx="${r}" ry="${r}" fill="none" stroke="${BORDER}" stroke-width="${borderW}"/></svg>`
  );
  return sharp(resized)
    .composite([
      { input: mask, blend: 'dest-in' },
      { input: border, blend: 'over' },
    ])
    .png()
    .toBuffer();
}

// Soft drop shadow for a rounded rect of size w x h.
async function shadow(w, h, r, blur = 34, opacity = 0.5) {
  const pad = blur * 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w + pad}" height="${h + pad}"><rect x="${pad / 2}" y="${pad / 2}" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="rgba(0,0,0,${opacity})"/></svg>`;
  return sharp(Buffer.from(svg)).blur(blur).png().toBuffer();
}

async function build(module) {
  const deskFile = path.join(here, `${module}-dark-web.png`);
  const phoneFile = path.join(here, `${module}-dark-mobile.png`);

  const deskImg = await panel(deskFile, DESK.w, DESK.h, DESK.r, DESK.border);
  const phoneImg = await panel(phoneFile, PHONE_W, PHONE.h, PHONE.r, PHONE.border);

  const blur = 38;
  const deskShadow = await shadow(DESK.w, DESK.h, DESK.r, blur, 0.45);
  const phoneShadow = await shadow(PHONE_W, PHONE.h, PHONE.r, blur, 0.55);

  const out = path.join(outDir, `${module}-combined-dark.png`);
  await background()
    .composite([
      { input: deskShadow, left: DESK.x - blur, top: DESK.y - blur + 16 },
      { input: deskImg, left: DESK.x, top: DESK.y },
      { input: phoneShadow, left: PHONE.x - blur, top: PHONE.y - blur + 18 },
      { input: phoneImg, left: PHONE.x, top: PHONE.y },
    ])
    .png({ compressionLevel: 9 })
    .toFile(out);
  return out;
}

await sharp({ create: { width: 1, height: 1, channels: 4, background: '#000' } }); // warm-up
const fs = await import('node:fs/promises');
await fs.mkdir(outDir, { recursive: true });
for (const m of modules) {
  const out = await build(m);
  console.log('wrote', path.relative(here, out));
}
console.log('done');
