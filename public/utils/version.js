/**
 * Versionsvergleich für den Update-Hinweis (#490).
 *
 * Verglichen werden ausschließlich Releases aus derselben Quelle (GitHub-Tags
 * gegen die installierte package.json-Version), deshalb reicht ein bewusst
 * kleiner Semver-Teilausschnitt: numerische Segmente plus die Regel, dass eine
 * Vorabversion (`1.84.0-rc.1`) kleiner ist als ihr fertiges Release. Ein
 * unparsebarer Wert gilt als "unbekannt" und löst nie einen Hinweis aus - ein
 * falscher Punkt an der Navigation wäre schlimmer als ein fehlender.
 */

/** Zerlegt "v1.84.0-rc.1" in { parts: [1,84,0], prerelease: 'rc.1' } oder null. */
function parseVersion(value) {
  const raw = String(value ?? '').trim().replace(/^v/i, '');
  if (!raw) return null;
  const [core, ...rest] = raw.split('-');
  const parts = core.split('.').map((segment) => Number(segment));
  if (!parts.length || parts.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return { parts, prerelease: rest.join('-') };
}

/**
 * Vergleicht zwei Versionen.
 * @returns {number|null} <0 wenn a älter, 0 wenn gleich, >0 wenn a neuer;
 *                        null, wenn eine der beiden nicht lesbar ist.
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;

  const length = Math.max(left.parts.length, right.parts.length);
  for (let i = 0; i < length; i += 1) {
    // Fehlende Segmente zählen als 0, damit "1.84" und "1.84.0" gleich sind.
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }

  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/**
 * Versionsnummer ohne `v`-Präfix. GitHub-Tags tragen es, package.json nicht -
 * ungefiltert stünde in „Version {{version}} ist verfügbar" ein zweites v.
 */
export function displayVersion(value) {
  return String(value ?? '').trim().replace(/^v/i, '');
}

/** True, wenn `candidate` nachweislich neuer ist als `current`. */
export function isNewerVersion(candidate, current) {
  const result = compareVersions(candidate, current);
  return result !== null && result > 0;
}
