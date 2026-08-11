import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';

import { SUPPORTED_LOCALES } from '../tools/installer/i18n-mini.js';

const HTML_PATH = new URL('../tools/installer/install.html', import.meta.url);
const LOCALES_DIR = new URL('../tools/installer/locales/', import.meta.url);
const html = readFileSync(HTML_PATH, 'utf8');

function loadLocale(locale) {
  return JSON.parse(readFileSync(new URL(`${locale}.json`, LOCALES_DIR), 'utf8'));
}

// ── 1.2 Accordion-Trigger sind tastaturbedienbare Buttons ─────────────────────

test('kein toggle-header ist mehr ein <div> (alle sind <button>)', () => {
  assert.doesNotMatch(html, /<div[^>]*class="toggle-head"/,
    'toggle-head darf kein <div> mehr sein');
});

test('jeder data-toggle-Trigger ist ein <button> mit type, aria-expanded und aria-controls', () => {
  const allToggles = [...html.matchAll(/\bdata-toggle="([^"]+)"/g)].map(m => m[1]);
  assert.ok(allToggles.length >= 4, 'erwartet mindestens vier Accordion-Trigger');

  const buttonToggles = [...html.matchAll(/<button[^>]*\bdata-toggle="([^"]+)"[^>]*>/g)];
  assert.equal(buttonToggles.length, allToggles.length,
    'jeder data-toggle muss auf einem <button> sitzen');

  for (const m of buttonToggles) {
    const tag = m[0];
    const target = m[1];
    assert.match(tag, /type="button"/, `Trigger für ${target} braucht type="button"`);
    assert.match(tag, /aria-expanded="false"/, `Trigger für ${target} braucht aria-expanded`);
    assert.match(tag, new RegExp(`aria-controls="${target}"`),
      `Trigger für ${target} braucht aria-controls="${target}"`);
  }
});

test('der Toggle-Handler aktualisiert aria-expanded', () => {
  assert.match(html, /setAttribute\(\s*'aria-expanded'/,
    'Klick-Handler muss aria-expanded synchron halten');
});

// ── 1.3 ARIA-Live-Regionen ────────────────────────────────────────────────────

test('jedes error-banner trägt role="alert"', () => {
  const banners = [...html.matchAll(/<div[^>]*class="error-banner"[^>]*>/g)];
  assert.ok(banners.length >= 6, 'erwartet mindestens sechs Fehler-Banner');
  for (const m of banners) {
    assert.match(m[0], /role="alert"/, `Fehler-Banner ohne role="alert": ${m[0]}`);
  }
});

test('die Docker-Statuszeile ist eine Live-Region', () => {
  const row = html.match(/<div[^>]*class="status-row"[^>]*>/);
  assert.ok(row, 'status-row nicht gefunden');
  assert.match(row[0], /role="status"/, 'status-row braucht role="status"');
  assert.match(row[0], /aria-live="polite"/, 'status-row braucht aria-live="polite"');
});

test('der Spinner ist für Screenreader ausgeblendet', () => {
  const spinner = html.match(/<div[^>]*class="spinner"[^>]*>/);
  assert.ok(spinner, 'spinner nicht gefunden');
  assert.match(spinner[0], /aria-hidden="true"/, 'Spinner braucht aria-hidden="true"');
});

// ── 1.4 Fokus-Management bei Schrittwechsel ───────────────────────────────────

test('jede Schritt-Überschrift ist per Skript fokussierbar (tabindex="-1")', () => {
  // Die persistente, visuell versteckte Seiten-<h1 class="vh"> ist der einzige
  // dauerhafte Landmark-Titel und wird NICHT per Skript fokussiert — ausnehmen.
  const headings = [...html.matchAll(/<h[12][^>]*>/g)].filter(m => !/class="vh"/.test(m[0]));
  assert.ok(headings.length > 0, 'keine Schritt-Überschriften gefunden');
  for (const m of headings) {
    assert.match(m[0], /tabindex="-1"/, `Schritt-Überschrift ohne tabindex="-1": ${m[0]}`);
  }
});

test('genau eine <h1> (persistenter Seitentitel) plus <main>-Landmark', () => {
  const h1s = [...html.matchAll(/<h1[^>]*>/g)];
  assert.equal(h1s.length, 1, `genau eine <h1> erwartet, gefunden: ${h1s.length}`);
  assert.match(h1s[0][0], /class="vh"/, 'die einzige <h1> ist der versteckte Seitentitel');
  assert.match(html, /<main\b/, 'die Karte braucht einen <main>-Landmark');
});

test('showStep setzt den Fokus auf die aktive Überschrift', () => {
  assert.match(html, /\.focus\(\s*\{\s*preventScroll:\s*true\s*\}\s*\)/,
    'showStep muss den Fokus (ohne Scroll-Sprung) auf die Überschrift setzen');
});

// ── 1.5 Augen-Buttons haben ein zugängliches Label ────────────────────────────

test('jeder Augen-Button hat aria-label und data-i18n-aria', () => {
  const eyeButtons = [...html.matchAll(/<button[^>]*\bdata-eye="[^"]+"[^>]*>/g)];
  assert.ok(eyeButtons.length >= 3, 'erwartet mindestens drei Augen-Buttons');
  for (const m of eyeButtons) {
    assert.match(m[0], /aria-label="/, `Augen-Button ohne aria-label: ${m[0]}`);
    assert.match(m[0], /data-i18n-aria="/, `Augen-Button ohne data-i18n-aria: ${m[0]}`);
  }
});

// ── 1.6 Schritt 1 nutzt dasselbe Fehler-Rendering wie alle anderen ────────────

test('kein veraltetes class="error" mehr (vereinheitlicht auf error-banner)', () => {
  assert.doesNotMatch(html, /class="error"/, 'class="error" existiert nicht im CSS');
});

test('cfg-err ist ein error-banner', () => {
  assert.match(html, /<div[^>]*id="cfg-err"[^>]*class="error-banner"|<div[^>]*class="error-banner"[^>]*id="cfg-err"/,
    'cfg-err muss ein error-banner sein');
});

// ── 1.7 Schrittzähler aus den Schritten abgeleitet, nicht hartcodiert ─────────

test('keine hartcodierten "Step N of 7"-Zähler im Markup', () => {
  assert.doesNotMatch(html, /Step .* of 7/, 'hartcodierter "of 7"-Zähler gefunden');
});

test('Schrittzähler wird im Skript aus den Schritten berechnet', () => {
  assert.match(html, /common\.stepCounter/, 'stepCounter-Schlüssel wird nicht verwendet');
});

test('common.stepCounter existiert in jeder Locale mit {{n}}/{{total}}', () => {
  for (const locale of SUPPORTED_LOCALES) {
    const data = loadLocale(locale);
    const tpl = data.common && data.common.stepCounter;
    assert.ok(tpl, `${locale}.json fehlt common.stepCounter`);
    assert.match(tpl, /\{\{n\}\}/, `${locale}: stepCounter ohne {{n}}`);
    assert.match(tpl, /\{\{total\}\}/, `${locale}: stepCounter ohne {{total}}`);
  }
});

test('die nummerierten *.tag-Schlüssel sind entfernt, advanced.tag bleibt', () => {
  for (const locale of SUPPORTED_LOCALES) {
    const data = loadLocale(locale);
    for (const step of ['config', 'secrets', 'weather', 'calendar', 'review', 'docker', 'admin']) {
      assert.equal(data[step]?.tag, undefined, `${locale}: ${step}.tag sollte entfernt sein`);
    }
    assert.ok(data.advanced?.tag, `${locale}: advanced.tag muss erhalten bleiben`);
  }
});

// ── 1.8 Mobile Wirkung: Schlüsselbreite, Schriftgrössen, Zielgrössen ─────────
//
// Der Vorgänger dieses Blocks prüfte, ob `flex-wrap: wrap` im Stylesheet STEHT.
// Er war grün, während `#sec-db` bei 390px auf 102px für einen 64-Zeichen-
// Schlüssel zusammenfiel - direkt unter der Aufforderung „Speichere diese
// Schlüssel jetzt". Die Regel stand da, sie wirkte nur nicht: `flex: 1` setzt
// die Basis auf 0, das Feld schrumpfte also, statt umzubrechen.
//
// Gemessen wird deshalb die Wirkung, nicht die Schreibweise: die Breite in px,
// die das Feld am Ende bekommt. Kein Browser, sondern dieselbe Rechnung, die
// der Browser für diese eine Zeile anstellt - eine flexible Box neben festen
// Buttons. Bekannte Grenze: das Modell kennt nur `flex-direction: row`; ein
// Umbau auf `column` müsste hier mitgezogen werden.

const MOBILE_VIEWPORT = 390;   // iPhone-Klasse, dieselbe Breite wie im Critique

/** Alle <style>-Blöcke der Datei, ohne Kommentare. */
function stylesheet(source) {
  return [...source.matchAll(/<style>([\s\S]*?)<\/style>/g)]
    .map(m => m[1]).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Flache Regelliste { selector, body, media }; @media wird eine Ebene tief aufgelöst. */
function collectRules(css) {
  const out = [];
  const walk = (text, media) => {
    let idx = 0;
    while (idx < text.length) {
      const brace = text.indexOf('{', idx);
      if (brace === -1) break;
      const prelude = text.slice(idx, brace).trim();
      let depth = 1;
      let end = brace + 1;
      while (end < text.length && depth > 0) {
        if (text[end] === '{') depth++;
        else if (text[end] === '}') depth--;
        end++;
      }
      const body = text.slice(brace + 1, end - 1);
      if (prelude.startsWith('@')) {
        // Nur Media-Queries tragen hier Regeln, die uns interessieren.
        if (/^@media/i.test(prelude)) walk(body, prelude);
      } else {
        for (const sel of prelude.split(',')) out.push({ selector: sel.trim(), body, media });
      }
      idx = end;
    }
  };
  walk(css, null);
  return out;
}

const RULES = collectRules(stylesheet(html));

/**
 * Wirksamer Wert einer Eigenschaft. Später deklariert gewinnt, wie in der
 * Kaskade bei gleicher Spezifität. `mediaMatch` entscheidet, welche
 * Media-Blöcke bei der geprüften Breite überhaupt gelten.
 */
function declared(selectorMatches, prop, mediaMatches = media => media === null) {
  let value = null;
  for (const rule of RULES) {
    if (!mediaMatches(rule.media)) continue;
    if (!selectorMatches(rule.selector)) continue;
    const found = rule.body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i'));
    if (found) value = found[1].trim();
  }
  return value;
}

/** Gilt der Media-Block bei `width`? Deckt die hier benutzte max-width-Form ab. */
function appliesAt(width) {
  return media => {
    if (media === null) return true;
    const max = media.match(/max-width:\s*(\d+)px/i);
    if (max) return width <= Number(max[1]);
    // Alles andere (prefers-color-scheme, prefers-reduced-motion) ist für die
    // Breitenrechnung kein Faktor und bleibt bewusst draussen.
    return false;
  };
}

/** :root-Custom-Properties des Inline-Fallbacks, für var()-Auflösung. */
const ROOT_VARS = (() => {
  const map = new Map();
  for (const rule of RULES) {
    if (rule.selector !== ':root' || rule.media !== null) continue;
    for (const [, name, value] of rule.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) {
      map.set(name, value.trim());
    }
  }
  return map;
})();

/** Längenwert in px; löst var() und rem auf, gibt bei Prozent den Anteil zurück. */
function toPx(value, base = null) {
  if (value == null) return null;
  let raw = value.trim();
  const variable = raw.match(/^var\(\s*(--[\w-]+)/);
  if (variable) raw = ROOT_VARS.get(variable[1]) ?? raw;
  const rem = raw.match(/^(-?[\d.]+)rem/);
  if (rem) return Number(rem[1]) * 16;
  const px = raw.match(/^(-?[\d.]+)px/);
  if (px) return Number(px[1]);
  const pct = raw.match(/^(-?[\d.]+)%/);
  if (pct && base !== null) return (Number(pct[1]) / 100) * base;
  return null;
}

/** Horizontales Padding aus einem padding-Shorthand (1 bis 4 Werte). */
function paddingX(shorthand) {
  const parts = shorthand.trim().split(/\s+/);
  const right = parts.length === 1 ? parts[0] : parts[1];
  const left = parts.length >= 4 ? parts[3] : right;
  return { left: toPx(left) ?? 0, right: toPx(right) ?? 0 };
}

/** Innenbreite der Karte bei `viewport`, so wie der Browser sie ausrechnet. */
function cardContentWidth(viewport) {
  const media = appliesAt(viewport);
  const body = paddingX(declared(sel => sel === 'body', 'padding', media));
  const cardMax = toPx(declared(sel => sel === '.card', 'max-width', media));
  const cardBody = paddingX(declared(sel => sel === '.card-body', 'padding', media));
  const cardWidth = Math.min(cardMax, viewport - body.left - body.right);
  return cardWidth - cardBody.left - cardBody.right;
}

/** flex-Shorthand in { grow, shrink, basis } zerlegen. */
function flexParts(shorthand) {
  const parts = shorthand.trim().split(/\s+/);
  if (parts.length === 1) {
    // `flex: 1` heisst 1 1 0% - genau die Basis 0, die das Feld schrumpfen liess.
    return /^[\d.]+$/.test(parts[0])
      ? { grow: Number(parts[0]), shrink: 1, basis: '0%' }
      : { grow: 1, shrink: 1, basis: parts[0] };
  }
  if (parts.length === 2) return { grow: Number(parts[0]), shrink: Number(parts[1]), basis: '0%' };
  return { grow: Number(parts[0]), shrink: Number(parts[1]), basis: parts[2] };
}

/**
 * Breite, die das Secret-Feld in der längsten Secret-Zeile bekommt.
 * Modelliert eine Flex-Zeile: eine flexible Box plus N unflexible Buttons.
 */
function secretFieldWidth(viewport) {
  const media = appliesAt(viewport);
  const available = cardContentWidth(viewport);
  const gap = toPx(declared(sel => sel === '.secret-row', 'gap', media)) ?? 0;
  const wraps = (declared(sel => sel === '.secret-row', 'flex-wrap', media) || 'nowrap') === 'wrap';

  const flex = flexParts(declared(sel => sel === '.secret-row input', 'flex', media) || '0 1 auto');
  const basis = toPx(flex.basis, available) ?? 0;
  const minWidth = toPx(declared(sel => sel === '.secret-row input', 'min-width', media)) ?? 0;

  // Die längste Zeile im Markup bestimmt die Rechnung: der DB-Schlüssel trägt
  // Auge, Kopieren und Generieren. Aus dem Markup gezählt, nicht angenommen.
  const rows = [...html.matchAll(/<div class="secret-row">([\s\S]*?)<\/div>\s*<\/div>/g)];
  const buttons = Math.max(...rows.map(m => (m[1].match(/<button/g) || []).length), 1);
  const buttonWidth = toPx(declared(sel => sel === '.btn-sm', 'min-width', media)) ?? 44;
  const buttonsBlock = buttons * buttonWidth + buttons * gap;

  // Passt die Basis nicht neben die Buttons und ist Umbruch erlaubt, bekommt
  // das Feld eine eigene Zeile und damit die volle Breite.
  if (wraps && basis + buttonsBlock > available) return available;
  return Math.max(minWidth, available - buttonsBlock);
}

test('das Secret-Feld bekommt auf dem Handy die volle Zeile, nicht den Rest', () => {
  const breite = secretFieldWidth(MOBILE_VIEWPORT);
  const voll = cardContentWidth(MOBILE_VIEWPORT);
  assert.ok(breite >= voll * 0.95,
    `#sec-db misst bei ${MOBILE_VIEWPORT}px nur ${breite.toFixed(0)}px von ${voll.toFixed(0)}px verfügbarer Breite. `
    + 'Ein 64-Zeichen-Schlüssel gehört auf eine eigene Zeile, die Buttons darunter.');
});

test('das Secret-Feld ist mindestens 14px gross (12px war unlesbar)', () => {
  const size = toPx(declared(sel => sel === '.secret-row input', 'font-size'));
  assert.ok(size >= 14, `Secret-Felder stehen auf ${size}px, mindestens 14px sind nötig`);
});

test('Textfelder stehen auf mindestens 16px (sonst zoomt iOS Safari bei jedem Fokus)', () => {
  // Unter 16px zoomt iOS Safari beim Fokus in ein Feld und verschiebt das
  // Layout. Der Befund stand seit dem Juni-Critique offen. Die Secret-Zeile ist
  // die bewusste Ausnahme: monospace, 64 Zeichen, dort wiegt Lesbarkeit mehr.
  const size = toPx(declared(sel => /^input\[type=text\]/.test(sel), 'font-size'));
  assert.ok(size >= 16, `Textfelder stehen auf ${size}px, iOS zoomt unter 16px`);
});

test('Bedienelemente erfüllen die Zielgrössen (44px Höhe, 24px Kästchen)', () => {
  const media = appliesAt(MOBILE_VIEWPORT);
  const buttonHeight = toPx(declared(sel => sel === '.btn', 'min-height', media));
  assert.ok(buttonHeight >= 44, `.btn ist ${buttonHeight}px hoch, 44px sind das Touch-Minimum`);

  const selectHeight = toPx(declared(sel => /(^|,)\s*select$/.test(sel) || sel === 'select', 'min-height', media));
  assert.ok(selectHeight >= 44, `select ist ${selectHeight}px hoch, 44px sind das Touch-Minimum`);

  // WCAG 2.2 SC 2.5.8 verlangt 24x24 CSS-Pixel, in jeder Breite. Die Kästchen
  // waren 13x13 neben einem 16px hohen Label.
  for (const prop of ['inline-size', 'block-size']) {
    const size = toPx(declared(sel => sel === 'input[type=checkbox]', prop));
    assert.ok(size >= 24, `Checkbox-${prop} ist ${size}px, WCAG 2.2 verlangt 24px`);
  }
});

// ── 1.9 Tinte auf Akzentflächen erfüllt AA, in beiden Themes ──────────────────
//
// Der Installer hatte hier weißen Text auf --color-accent stehen. Im Light-Mode
// stimmt das (6,0:1), im Dark-Mode hellt der Akzent auf #A78BFA auf und weiß
// fällt auf 2,72:1. Betroffen war die Primäraktion JEDES Schritts.
//
// Der Guard rechnet den echten WCAG-Kontrast, statt auf einen Token-Namen zu
// matchen: ein Textmatch würde grün bleiben, sobald jemand die Hex-Werte ändert.
// Geprüft werden beide Quellen, weil beide real ausgeliefert werden: der
// Inline-Fallback in install.html und tokens.css, das ihn überschreibt.

const tokensCss = readFileSync(new URL('../public/styles/tokens.css', import.meta.url), 'utf8');

function srgbToLinear(channel) {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const raw = hex.replace('#', '');
  const full = raw.length === 3 ? [...raw].map(c => c + c).join('') : raw.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** Erster Hex-Wert von `name` ab Position `from`. */
function cssVar(css, name, from = 0) {
  const re = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`, 'g');
  re.lastIndex = from;
  const match = re.exec(css);
  assert.ok(match, `${name} nicht gefunden (ab Offset ${from})`);
  return match[1];
}

test('Primäraktionen des Installers erfüllen AA auf Akzentgrund, in beiden Themes', () => {
  // Inline-Fallback: :root ist Light, der prefers-color-scheme-Block ist Dark.
  const htmlDark = html.indexOf('@media (prefers-color-scheme: dark)');
  assert.ok(htmlDark > 0, 'Dark-Block im Inline-Fallback nicht gefunden');

  // tokens.css setzt die Basiswerte auf --_-Variablen; --color-* verweist darauf.
  const tokensDark = tokensCss.indexOf('@media (prefers-color-scheme: dark)');
  assert.ok(tokensDark > 0, 'Dark-Block in tokens.css nicht gefunden');

  const paare = [
    ['Inline-Fallback, Light', cssVar(html, '--color-ink-on-vivid'), cssVar(html, '--color-accent')],
    ['Inline-Fallback, Dark', cssVar(html, '--color-ink-on-vivid', htmlDark), cssVar(html, '--color-accent', htmlDark)],
    ['tokens.css, Light', cssVar(tokensCss, '--_color-ink-on-vivid'), cssVar(tokensCss, '--_color-accent')],
    ['tokens.css, Dark', cssVar(tokensCss, '--_color-ink-on-vivid', tokensDark), cssVar(tokensCss, '--_color-accent', tokensDark)],
  ];

  for (const [quelle, ink, accent] of paare) {
    const ratio = contrastRatio(ink, accent);
    assert.ok(ratio >= 4.5,
      `${quelle}: ${ink} auf ${accent} ergibt ${ratio.toFixed(2)}:1, AA verlangt 4.5:1`);
  }
});

test('der Installer nutzt kein --color-text-on-accent (folgt dem Theme nicht)', () => {
  // tokens.css definiert --color-text-on-accent als statisches Weiß und
  // redefiniert es in KEINEM Dark-Block. Auf einer Fläche, die im Dark-Mode
  // aufhellt, ist es deshalb immer ein Kontrastfehler. Richtig ist
  // --color-ink-on-vivid, das dem Theme folgt.
  assert.doesNotMatch(html, /var\(--color-text-on-accent/,
    'auf Akzentflächen gehört --color-ink-on-vivid, nicht --color-text-on-accent');
});
