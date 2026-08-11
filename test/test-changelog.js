/**
 * Tests: Live changelog parser/proxy.
 * Ausführen: node --test test/test-changelog.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import changelogRouter, { buildRouter, __test } from '../server/routes/changelog.js';
import { compareVersions, isNewerVersion, displayVersion } from '../public/utils/version.js';

test('parseReleaseBody keeps release sections and removes GitHub noise', () => {
  const sections = __test.parseReleaseBody(`
## Added
- New dashboard changelog modal ([#455](https://github.com/daiqiongzhao-bit/Juju/pull/455))
- Internal commit 9f4a12bc should not leak

## Fixed
- Better widget sizing

Full Changelog: https://github.com/daiqiongzhao-bit/Juju/compare/v1.0.0...v1.1.0
Assets
`);

  assert.deepEqual(sections, [
    {
      title: 'Added',
      items: [
        'New dashboard changelog modal (#455)',
        'Internal commit should not leak',
      ],
    },
    {
      title: 'Fixed',
      items: ['Better widget sizing'],
    },
  ]);
});

test('buildChangelogPayload marks current version when it appears in releases', () => {
  const payload = __test.buildChangelogPayload([
    { tag_name: 'v1.2.2', body: '- Newest release', html_url: 'https://example.test/latest' },
    { tag_name: 'v1.2.1', body: '- Current release', html_url: 'https://example.test/current' },
  ], '1.2.1');

  assert.equal(payload.current_version, '1.2.1');
  assert.equal(payload.latest_version, 'v1.2.2');
  assert.equal(payload.current_in_releases, true);
  assert.equal(payload.releases.length, 2);
});

test('buildChangelogPayload reports current version missing from releases', () => {
  const payload = __test.buildChangelogPayload([
    { tag_name: 'v0.88.1', body: '- Public release notes' },
  ], '1.2.1');

  assert.equal(payload.latest_version, 'v0.88.1');
  assert.equal(payload.current_in_releases, false);
});

test('changelog router fetches and sanitizes GitHub release JSON', async () => {
  const app = express();
  app.use(buildRouter({
    appVersion: '1.2.1',
    now: () => 1000,
    fetchFn: async (url, options) => {
      assert.match(url, /api\.github\.com\/repos\/daiqiongzhao-bit\/yuvomi\/releases/);
      assert.equal(options.headers.Accept, 'application/vnd.github+json');
      return {
        ok: true,
        json: async () => [
          {
            tag_name: 'v1.2.1',
            body: '## Added\n- Live changelog\n\nFull Changelog: https://example.test',
            html_url: 'https://github.com/daiqiongzhao-bit/Juju/releases/tag/v1.2.1',
          },
        ],
      };
    },
  }));

  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.current_in_releases, true);
    assert.equal(body.data.releases[0].sections[0].items[0], 'Live changelog');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('default changelog router is an express router', () => {
  assert.equal(typeof changelogRouter, 'function');
});

// --------------------------------------------------------
// Update-Hinweis (#490): der Vergleich hinter dem Punkt an der Navigation
// --------------------------------------------------------

test('isNewerVersion compares numeric segments, not strings', () => {
  // Der String-Vergleich, den diese Funktion ersetzt, hielte '1.9.0' für neuer.
  assert.equal(isNewerVersion('1.10.0', '1.9.0'), true);
  assert.equal(isNewerVersion('1.9.0', '1.10.0'), false);
  assert.equal(isNewerVersion('2.0.0', '1.99.99'), true);
});

test('isNewerVersion tolerates the v prefix of GitHub tags', () => {
  assert.equal(isNewerVersion('v1.84.0', '1.83.0'), true);
  assert.equal(isNewerVersion('v1.83.0', '1.83.0'), false);
  assert.equal(isNewerVersion('1.83.0', 'v1.83.0'), false);
});

test('isNewerVersion treats missing segments as zero', () => {
  assert.equal(compareVersions('1.84', '1.84.0'), 0);
  assert.equal(isNewerVersion('1.84.1', '1.84'), true);
});

test('isNewerVersion ranks a prerelease below its final release', () => {
  assert.equal(isNewerVersion('1.84.0-rc.1', '1.84.0'), false);
  assert.equal(isNewerVersion('1.84.0', '1.84.0-rc.1'), true);
  assert.equal(isNewerVersion('1.84.0-rc.2', '1.84.0-rc.1'), true);
});

test('displayVersion drops the tag prefix so the label reads once', () => {
  // "Version {{version}} ist verfügbar" mit einem GitHub-Tag ergäbe sonst
  // "Version v1.84.0".
  assert.equal(displayVersion('v1.84.0'), '1.84.0');
  assert.equal(displayVersion('1.84.0'), '1.84.0');
  assert.equal(displayVersion('  V1.84.0  '), '1.84.0');
  assert.equal(displayVersion(null), '');
});

test('unreadable versions never trigger the hint', () => {
  // Ein falscher Punkt an der Navigation wäre schlimmer als ein fehlender:
  // alles Unlesbare gilt als "unbekannt", nicht als "neuer".
  assert.equal(compareVersions('latest', '1.83.0'), null);
  assert.equal(isNewerVersion('latest', '1.83.0'), false);
  assert.equal(isNewerVersion('1.84.0', ''), false);
  assert.equal(isNewerVersion('', '1.83.0'), false);
  assert.equal(isNewerVersion(null, undefined), false);
});

test('jeder getaggte Release hat einen CHANGELOG-Eintrag, keine Version doppelt', (t) => {
  // F-033-Guard: beim Docs-Audit 2026-08-05 fehlten 13 getaggten Releases die
  // Einträge - bei spaeteren Release-Läufen still verloren gegangen. Der Guard
  // beißt beim lokalen release-prep (voller Clone); in CI ohne Tags
  // (checkout mit depth 1, ohne fetch-tags) skippt er sichtbar statt leer zu
  // bestehen. Die Gegenrichtung (Eintrag ohne Tag) bleibt bewusst ungeprüft:
  // [0.71.9]/[0.76.0] sind dokumentierte Altfälle, und beim Release liegt der
  // neue Eintrag naturgemäß vor dem Tag.
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  let tags;
  try {
    tags = execSync('git tag', { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .filter((l) => /^v\d+\.\d+\.\d+$/.test(l))
      .map((l) => l.slice(1));
  } catch {
    return t.skip('git nicht verfügbar');
  }
  if (tags.length === 0) return t.skip('keine Tags im Checkout (shallow clone)');

  const md = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const headings = [...md.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
  const headingSet = new Set(headings);

  const missing = tags.filter((v) => !headingSet.has(v));
  assert.deepEqual(missing, [],
    `Getaggte Releases ohne CHANGELOG-Eintrag: ${missing.join(', ')}`);

  const dupes = [...new Set(headings.filter((v, i) => headings.indexOf(v) !== i))];
  assert.deepEqual(dupes, [],
    `Versionen mit doppeltem CHANGELOG-Heading: ${dupes.join(', ')}`);
});
