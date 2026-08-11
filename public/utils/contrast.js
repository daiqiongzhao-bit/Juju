/**
 * Modul: Kontrast-Utilities
 * Zweck: Lesbare Textfarbe auf einer frei gewählten Hintergrundfarbe.
 * Abhängigkeiten: keine
 *
 * Avatare tragen die Farbe, die sich das Familienmitglied selbst ausgesucht
 * hat, und die Initialen standen darauf immer in Weiß. Auf hellen Tönen ergab
 * das gemessene 3,5:1 und 2,8:1 - unter der 4,5:1-Schwelle für Fließtext
 * (Critique 2026-07-27). CSS kann das nicht entscheiden: `color-contrast()`
 * ist nicht verfügbar, und die Farbe kommt aus der Datenbank.
 */

// WCAG 2.1 §1.4.3: relative Luminanz nach der sRGB-Formel.
function relativeLuminance(r, g, b) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function parseHex(value) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value ?? '').trim());
  if (!match) return null;
  const hex = match[1].length === 3
    ? match[1].split('').map((c) => c + c).join('')
    : match[1];
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

export function contrastRatio(hexA, hexB) {
  const a = parseHex(hexA);
  const b = parseHex(hexB);
  if (!a || !b) return null;
  const la = relativeLuminance(...a);
  const lb = relativeLuminance(...b);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

// Die beiden Werte, zwischen denen entschieden wird - als Literale, weil hier
// gerechnet und nicht nur gesetzt wird. Sie spiegeln die Tokens, die das CSS
// dann tatsächlich einsetzt: `--color-text-on-accent` (#ffffff) und
// `--color-ink-on-bright` (#000000, laut tokens.css:104 genau für
// "frei wählbare helle Flächen" gedacht).
const ON_ACCENT = '#ffffff';
const INK_ON_BRIGHT = '#000000';

// WCAG 2.1 AA für Fließtext. Eine Schwelle für alle Avatargrößen statt drei:
// die kleinste Instanz (32px Kreis, 14px Schrift) braucht den strengen Wert,
// und ein Mitglied soll auf derselben Seite nicht in zwei Farben erscheinen.
const AA_TEXT = 4.5;

/**
 * True, wenn Weiß auf `background` die Kontrastschwelle verfehlt und dunkle
 * Tinte dort besser liegt.
 *
 * Nicht "wähle immer die bessere der beiden": wo Weiß die Schwelle hält,
 * bleibt es Weiß. Auf der Standardpalette greift die Regel trotzdem
 * durchgehend - selbst iOS-Blau (#007AFF) traegt weissen 14px-Text nur mit
 * 4,05:1. Bei einem nicht auswertbaren Wert (z. B. `var(--color-accent)`)
 * bleibt es bei der Standard-Textfarbe der Komponente.
 */
export function prefersInkText(background) {
  const onWhite = contrastRatio(background, ON_ACCENT);
  if (onWhite == null || onWhite >= AA_TEXT) return false;
  return contrastRatio(background, INK_ON_BRIGHT) > onWhite;
}
