/**
 * Modul: Changelog
 * Zweck: Liefert die Versionshistorie der DIESER Installation zugrunde liegenden
 *        Versionslinie - gelesen aus der im Image enthaltenen CHANGELOG.md.
 *
 * Warum kein GitHub mehr: der Endpoint las die Releases des Upstream-Projekts
 * (daiqiongzhao-bit/Juju). Diese Versionslinie steht auf v0.0.39 und hat mit
 * den eigenen Releases (0.0.40+) nichts gemeinsam - die UI zeigte „aktuellste
 * Version: v0.0.39" gegen ein lokales 0.0.55 (Feedback 2026-10-26). Das
 * Changelog wird pro Release ohnehin gepflegt und mit COPY . . in das Image
 * übernommen; lokal gelesen heißt: offlinefähig, ohne API-Limit, immer exakt
 * zum laufenden Build passend.
 *
 * Format (Keep a Changelog-artig):
 *   ## [0.0.57] - 2026-10-26
 *   ### 新增
 *   - Punkt ...
 * Auch `## 0.0.57` ohne Klammern/Datum wird erkannt.
 */

import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { createLogger } from '../logger.js';

const log = createLogger('Changelog');

const CHANGELOG_PATH = new URL('../../CHANGELOG.md', import.meta.url);
const CACHE_TTL_MS = 5 * 60 * 1000;
// Die UI-Liste muss nicht 800+ historische Einträge aus der Upstream-Ära
// enthalten: newest first,gekürzt auf die letzten 30 Releases.
const MAX_RELEASES = 30;

const { version: APP_VERSION } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
);

/** „v0.0.57", „release-0.0.57" → „0.0.57" (klein, ohne Präfix). */
function normalizeVersion(value) {
  return String(value || '')
    .trim()
    .replace(/^release[-_\s]*/i, '')
    .replace(/^v/i, '')
    .toLowerCase();
}

/** Überschriftszeile `## [0.0.57] - 2026-10-26` → { version, date } oder null. */
function parseReleaseHeading(line) {
  const m = /^#{2}\s+\[?([0-9]+\.[0-9]+\.[0-9]+[^\]\s]*)]?\s*(?:-\s*(.+))?$/i.exec(line.trim());
  if (!m) return null;
  return { version: m[1].trim(), date: (m[2] || '').trim() };
}

/**
 * CHANGELOG-Text → [{ version, date, sections: [{ title, items }] }].
 * Nicht-Release-Überschriften (## Enthalten ...) werden ignoriert; ###
 * Unterabschnitte (新增/修复/…) werden zu Abschnitten, Bullets zu Items.
 */
export function parseChangelog(text) {
  const releases = [];
  let current = null;
  let section = null;

  const ensureSection = (title) => {
    if (!current) return null;
    const wanted = title || 'Changes';
    let last = current.sections[current.sections.length - 1];
    if (!last || last.title !== wanted) {
      last = { title: wanted, items: [] };
      current.sections.push(last);
    }
    return last;
  };

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('## ')) {
      const heading = parseReleaseHeading(line);
      if (heading) {
        current = { version: heading.version, date: heading.date, sections: [] };
        releases.push(current);
      } else {
        current = null; // z. B. „## Unreleased"
      }
      section = null;
      continue;
    }

    if (!current) continue;

    if (line.startsWith('### ')) {
      section = ensureSection(line.slice(4).trim());
      continue;
    }

    const bullet = line.match(/^(?:[-*+]|\d+\.)\s+(.+)$/);
    if (!bullet && !line.startsWith('>')) continue;
    const target = ensureSection(section ? section.title : undefined);
    const text0 = String(bullet ? bullet[1] : line.replace(/^>\s?/, '')).trim();
    if (!text0) continue;
    if (bullet) {
      target.items.push(text0);
    } else if (target.items.length) {
      target.items[target.items.length - 1] += ` ${text0}`;
    } else {
      target.items.push(text0);
    }
  }

  return releases
    .map((r) => ({ ...r, sections: r.sections.filter((s) => s.items.length) }))
    .filter((r) => r.sections.length);
}

function readChangelogReleases() {
  try {
    if (!existsSync(CHANGELOG_PATH)) return [];
    return parseChangelog(readFileSync(CHANGELOG_PATH, 'utf-8'));
  } catch (err) {
    log.warn('Reading CHANGELOG.md failed:', err?.message || err);
    return [];
  }
}

function buildChangelogPayload(releases, currentVersion = APP_VERSION) {
  const normalized = Array.isArray(releases) ? releases : [];

  // Leeres/fehlendes Changelog: laufende Version als einziger Eintrag, damit
  // die UI nie „unbekannt" zeigt und keinen Phantom-Update meldet.
  if (normalized.length === 0 && currentVersion) {
    normalized.push({ version: currentVersion, date: '', sections: [] });
  }

  const currentKey = normalizeVersion(currentVersion);
  const latestVersion = normalized[0]?.version || null;
  const currentInReleases = Boolean(currentKey)
    && normalized.some((release) => normalizeVersion(release.version) === currentKey);

  return {
    current_version: currentVersion,
    latest_version: latestVersion,
    current_in_releases: currentInReleases,
    releases: normalized.slice(0, MAX_RELEASES),
  };
}

export function buildRouter({
  appVersion = APP_VERSION,
  now = () => Date.now(),
} = {}) {
  const router = express.Router();
  let cachedPayload = null;
  let cachedAt = 0;

  router.get('/', (_req, res) => {
    const age = now() - cachedAt;
    if (cachedPayload && age >= 0 && age < CACHE_TTL_MS) {
      return res.json({ data: cachedPayload });
    }

    // Datei jedes Mal neu lesen: im Container unveränderlich, in der Dev-Umgebung
    // landen neue Einträge so sofort in der UI. Das Lesen ist winzig (<100 kB).
    const releases = readChangelogReleases();
    if (!releases.length) {
      // Kein Changelog im Image: trotzdem antworten (aktuelle Version, leer).
      const payload = buildChangelogPayload([], appVersion);
      return res.json({ data: payload });
    }

    cachedPayload = buildChangelogPayload(releases, appVersion);
    cachedAt = now();
    return res.json({ data: cachedPayload });
  });

  return router;
}

const router = buildRouter();

export default router;
export const __test = {
  normalizeVersion,
  parseReleaseHeading,
  parseChangelog,
  buildChangelogPayload,
};
