/**
 * Modul: Migrationen sind append-only
 * Zweck: Den letzten Hard Constraint absichern, der keinen Guard hatte.
 *        CLAUDE.md sagt „Migrationen nur ans `migrations`-Array anhaengen,
 *        bestehende Eintraege nie aendern oder umsortieren"; bis heute hielt
 *        ihn allein die Disziplin (Guard-Abdeckung 2026-08-08, Befund H).
 * Ausfuehren: npm run test:migrations-append-only
 *
 * WARUM DAS TEUER WAERE, WENN ES BRICHT: `applied` ist eine Menge von
 * Versionsnummern in der Datenbank des NUTZERS (db.js: `MIGRATIONS.filter((m)
 * => !applied.has(m.version))`). Eine umsortierte oder neu vergebene Nummer
 * laesst eine Bestandsinstallation eine Migration ueberspringen oder eine
 * fremde fuer erledigt halten - stumm, beim Update, auf einem selbstgehosteten
 * Server ohne Betreuung.
 *
 * GELESEN WIRD DIE QUELLE, NICHT DAS IMPORTIERTE ARRAY. Das ist die
 * unbequemere Wahl und die richtige, und beide Gruende wurden beim Bau
 * gemessen:
 *
 *   (a) Die Dublette kommt gar nicht bis zur Zusicherung. `import
 *       '../server/db.js'` ruft `init()` auf, `migrate()` laeuft, und das
 *       zweite `INSERT` in `schema_migrations` bricht mit
 *       SQLITE_CONSTRAINT_PRIMARYKEY ab - der Entwickler sieht einen
 *       Stacktrace in db.js:4990 statt „version 133 kommt zweimal vor".
 *   (b) Die UMSORTIERUNG faellt beim Import ueberhaupt nicht auf. Eine frische
 *       Datenbank hat kein `applied`, also laeuft jede Reihenfolge glatt
 *       durch. Genau der Fall, der eine Bestandsinstallation zerlegt, waere
 *       ueber das importierte Array gruen geblieben.
 *
 * Der Preis ist eine Textform, an die der Guard gebunden ist - `version: N,`
 * am Anfang einer Zeile im MIGRATIONS-Array. Deshalb prueft er unten auch, dass
 * er ueberhaupt etwas gefunden hat: eine geaenderte Schreibweise faellt als
 * Guard-Fehler auf, nicht als stille Null.
 *
 * DREI FRAGEN, EINE DAVON BEWUSST NICHT GESTELLT:
 *   (1) aufsteigend und lueckenlos - faengt Umsortierung und Merge-Verlust.
 *   (2) jede Nummer einmalig - faengt die zweite Migration unter derselben Nummer.
 *   (3) wurde ein BESTEHENDER Eintrag geaendert? Nicht geprueft. Dafuer
 *       braeuchte es eine Pruefsumme je Eintrag im Repo, und die stuende beim
 *       ersten legitimen Refactor im Weg (ein Kommentar im SQL, ein
 *       umbenannter Alias). Ein Guard, den man regelmaessig „nachzieht",
 *       erzieht zum Nachziehen. Frage 3 bleibt beim Review.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');

/** Der Rumpf des MIGRATIONS-Arrays, ueber die Klammern begrenzt statt per Regex. */
function migrationsBlock() {
  const start = source.indexOf('const MIGRATIONS = [');
  assert.notEqual(start, -1, 'const MIGRATIONS = [ nicht in server/db.js gefunden.');
  let depth = 0;
  let index = source.indexOf('[', start);
  const from = index;
  while (index < source.length) {
    if (source[index] === '[') depth += 1;
    else if (source[index] === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(from, index);
    }
    index += 1;
  }
  throw new Error('Das MIGRATIONS-Array ist nicht geschlossen.');
}

/**
 * Die Versionsnummern in ihrer QUELLREIHENFOLGE.
 *
 * `^\s*version:\s*(\d+),` und nicht irgendein `version:` - im `up`-SQL stehen
 * Spaltennamen und Kommentare, und eine Suche ohne Zeilenanfang liest sie mit.
 */
function declaredVersions() {
  return [...migrationsBlock().matchAll(/^[ \t]*version:\s*(\d+)\s*,/gm)].map((m) => Number(m[1]));
}

test('die Migrationen sind lueckenlos aufsteigend nummeriert', () => {
  const versions = declaredVersions();

  // Ein Guard, der nichts gemessen hat, darf nicht urteilen: eine geaenderte
  // Schreibweise im Array wuerde sonst als „alles in Ordnung" durchgehen.
  assert.ok(versions.length >= 100,
    `Nur ${versions.length} Versionsnummern im MIGRATIONS-Array gefunden. Entweder ist die `
    + 'Schreibweise `version: N,` entfallen - dann gehoert dieser Guard nachgezogen - oder '
    + 'das Array ist kaputt.');

  const findings = [];
  versions.forEach((version, index) => {
    if (index === 0) {
      if (version !== 1) findings.push(`Der erste Eintrag traegt version ${version}, erwartet 1.`);
      return;
    }
    const previous = versions[index - 1];
    if (version === previous) {
      findings.push(`version ${version} kommt zweimal vor (Eintrag ${index - 1} und ${index}) - `
        + 'eine Bestandsinstallation haelt die zweite fuer erledigt und ueberspringt sie.');
    } else if (version < previous) {
      findings.push(`Eintrag ${index} traegt version ${version} nach ${previous} - das Array ist umsortiert.`);
    } else if (version !== previous + 1) {
      findings.push(`Zwischen ${previous} und ${version} fehlt mindestens eine Nummer (Eintrag ${index}) - `
        + 'meist zwei Zweige, die parallel angehaengt haben.');
    }
  });

  assert.deepEqual(findings, [],
    'Das MIGRATIONS-Array in server/db.js ist append-only (CLAUDE.md). Neue Migrationen werden '
    + 'ANGEHAENGT und bekommen die naechste freie Nummer; bestehende Eintraege werden nie '
    + 'umsortiert und nie neu nummeriert.\n  ' + findings.join('\n  '));
});

test('jede Migration nennt neben ihrer Version auch eine Beschreibung', () => {
  // Ein Eintrag ohne `description` ist beim naechsten Konflikt nicht
  // identifizierbar - `[DB] Migration 128 applied:` waere dann leer, und genau
  // diese Zeile ist beim Update eines Bestandsservers die einzige Spur.
  const block = migrationsBlock();
  const entries = block.split(/^[ \t]*version:\s*\d+\s*,/gm).slice(1);
  const versions = declaredVersions();
  const findings = [];
  entries.forEach((entry, index) => {
    // Nur bis zum naechsten Eintrag schauen; `up` steht dazwischen.
    const head = entry.slice(0, entry.indexOf('up:') === -1 ? entry.length : entry.indexOf('up:'));
    if (!/description:\s*['"`]\s*\S/.test(head)) {
      findings.push(`version ${versions[index]}: keine description.`);
    }
  });
  assert.deepEqual(findings, [], findings.join('\n  '));
});
