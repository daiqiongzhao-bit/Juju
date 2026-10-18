#!/bin/sh
# Testet die ensure_secrets-Absicherung in entrypoint.sh gegen den
# Startup-Brick "[DB] Wrong encryption key — /data/yuvomi.db could not be
# decrypted" (Produktionscrash fnOS, v0.0.31).
#
# Das Skript erzeugt eine gekappte Kopie von entrypoint.sh (nur die
# Funktions-Definitionen + load_secrets, ohne chown/exec) und fährt sie in
# einer Sandbox mit JUJU_SECRETS_FILE / DB_PATH ins Temp-Verzeichnis.
set -u

cd "$(dirname "$0")/.."
REPO=$(pwd)
ENTRY="$REPO/entrypoint.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail=0

# Gekappte Kopie: alles bis zur root-Branch, dann load_secrets + BOOTED.
branch_line=$(grep -n '^if \[ "\$(id -u)" = "0" \]; then$' "$ENTRY" | head -1 | cut -d: -f1)
if [ -z "$branch_line" ] || [ "$branch_line" -lt 2 ]; then
  echo "FAIL - cannot locate root branch in $ENTRY"
  exit 1
fi
head -n $((branch_line - 1)) "$ENTRY" > "$work/ep.sh"
echo 'load_secrets && echo BOOTED' >> "$work/ep.sh"

pass() { echo "ok   - $1"; }
fail() { echo "FAIL - $1"; fail=1; }

check() {
  name="$1"; expect_status="$2"; expect_pattern="$3"; setup="$4"; db_path="$5"
  case_dir="$work/$name"
  mkdir -p "$case_dir"
  eval "$setup"

  out=$(JUJU_SECRETS_FILE="$case_dir/.juju-secrets" DB_PATH="$db_path" sh "$work/ep.sh" 2>&1)
  status=$?

  if [ "$status" != "$expect_status" ]; then
    fail "$name: exit $status, expected $expect_status"
    echo "$out" | sed 's/^/       /'
    return
  fi
  if [ -n "$expect_pattern" ] && ! echo "$out" | grep -aq "$expect_pattern"; then
    fail "$name: output missing pattern '$expect_pattern'"
    echo "$out" | sed 's/^/       /'
    return
  fi
  pass "$name"
}

# 1) Frische Installation: keine Schlüsseldatei, keine DB -> Schlüssel erzeugt.
d="$work/fresh"; mkdir -p "$d"
out=$(JUJU_SECRETS_FILE="$d/.juju-secrets" DB_PATH="$d/yuvomi.db" sh "$work/ep.sh" 2>&1)
if [ $? = 0 ] && [ -f "$d/.juju-secrets" ] && echo "$out" | grep -q BOOTED; then
  pass "fresh: creates secrets file and boots"
else
  fail "fresh: exit $? / file missing"
  echo "$out" | sed 's/^/       /'
fi
if grep -q '^DB_ENCRYPTION_KEY=.\{64\}$' "$d/.juju-secrets" && \
   grep -q '^JUJU_SM4_KEY=.\{32\}$' "$d/.juju-secrets" && \
   grep -q '^SESSION_SECRET=.\{64\}$' "$d/.juju-secrets"; then
  pass "fresh: all three keys generated"
else
  fail "fresh: key lines malformed"
fi

# 2) Bestehende Schlüsseldatei: unverändert übernehmen (kein Rekey).
d="$work/keep"; mkdir -p "$d"
printf 'DB_ENCRYPTION_KEY=%s\nJUJU_SM4_KEY=%s\nSESSION_SECRET=%s\n' \
  "$(printf 'a%.0s' $(seq 64))" "$(printf 'b%.0s' $(seq 32))" "$(printf 'c%.0s' $(seq 64))" \
  > "$d/.juju-secrets"
before=$(md5sum "$d/.juju-secrets" | cut -d' ' -f1)
out=$(JUJU_SECRETS_FILE="$d/.juju-secrets" DB_PATH="$d/yuvomi.db" sh "$work/ep.sh" 2>&1)
after=$(md5sum "$d/.juju-secrets" | cut -d' ' -f1)
if [ $? = 0 ] && [ "$before" = "$after" ] && echo "$out" | grep -q BOOTED; then
  pass "existing: secrets file reused unchanged"
else
  fail "existing: file changed or exit $?"
fi

# 2b) Compose/.env-Installation: Schlüssel kommen aus der Umwelt, Datei fehlt,
#     verschlüsselte DB vorhanden -> Umwelt-Werte werden übernommen und
#     persistiert (NIHT neu generiert — das würde die DB killen).
d="$work/envkey"; mkdir -p "$d"
head -c 4096 /dev/urandom > "$d/yuvomi.db"
envkey=$(printf 'e%.0s' $(seq 64))
out=$(DB_ENCRYPTION_KEY="$envkey" JUJU_SM4_KEY="$(printf 'm%.0s' $(seq 32))" SESSION_SECRET="$envkey" \
      JUJU_SECRETS_FILE="$d/.juju-secrets" DB_PATH="$d/yuvomi.db" sh "$work/ep.sh" 2>&1)
if [ $? = 0 ] && [ -f "$d/.juju-secrets" ] && echo "$out" | grep -q BOOTED \
   && grep -q "^DB_ENCRYPTION_KEY=$envkey\$" "$d/.juju-secrets"; then
  pass "env-key: environment key persisted unchanged (upgrade-safe)"
else
  fail "env-key: exit $? / env key not persisted"
  echo "$out" | sed 's/^/       /'
fi

# 2c) Nur SESSION_SECRET in der Umwelt, DB verschlüsselt, KEIN DB-Schlüssel in
#     der Umwelt -> Guard muss trotzdem greifen (Schlüssel verloren).
d="$work/envpartial"; mkdir -p "$d"
head -c 4096 /dev/urandom > "$d/yuvomi.db"
out=$(SESSION_SECRET="nur-session" JUJU_SECRETS_FILE="$d/.juju-secrets" DB_PATH="$d/yuvomi.db" sh "$work/ep.sh" 2>&1)
if [ $? = 1 ] && [ ! -f "$d/.juju-secrets" ]; then
  pass "env-partial: guard fires without env DB key"
else
  fail "env-partial: exit $?"
  echo "$out" | sed 's/^/       /'
fi

# 2d) Nur SESSION_SECRET in der Umwelt, KEINE DB -> frischer Start: der
#     Umwelt-SESSION_SECRET wird übernommen, Rest neu erzeugt.
d="$work/envsessonly"; mkdir -p "$d"
out=$(SESSION_SECRET="meine-session" JUJU_SECRETS_FILE="$d/.juju-secrets" DB_PATH="$d/yuvomi.db" sh "$work/ep.sh" 2>&1)
if [ $? = 0 ] && grep -q '^SESSION_SECRET=meine-session$' "$d/.juju-secrets" \
   && grep -q '^DB_ENCRYPTION_KEY=.\{64\}$' "$d/.juju-secrets"; then
  pass "env-session-only: persists env SESSION_SECRET, generates the rest"
else
  fail "env-session-only: exit $?"
  echo "$out" | sed 's/^/       /'
fi

# 3) DER PRODUKTIONSFALL: verschlüsselte DB vorhanden, Schlüsseldatei fehlt
#    -> KEIN neuer Schlüssel, harter Abbruch mit Wiederherstellungs-Text,
#    Datenbankdatei bleibt byte-gleich liegen.
d="$work/encdb"; mkdir -p "$d"
head -c 4096 /dev/urandom > "$d/yuvomi.db"
dbhash_before=$(md5sum "$d/yuvomi.db" | cut -d' ' -f1)
out=$(JUJU_SECRETS_FILE="$d/.juju-secrets" DB_PATH="$d/yuvomi.db" sh "$work/ep.sh" 2>&1)
status=$?
dbhash_after=$(md5sum "$d/yuvomi.db" | cut -d' ' -f1)
if [ "$status" = 1 ] && [ ! -f "$d/.juju-secrets" ] && [ "$dbhash_before" = "$dbhash_after" ] \
   && echo "$out" | grep -aq 'FATAL' && echo "$out" | grep -aq 'verschlüsselte' \
   && echo "$out" | grep -aq 'Sicherungspaket'; then
  pass "encdb-db-only: refuses to generate a new key, DB untouched"
else
  fail "encdb-db-only: status=$status secrets_created=$([ -f "$d/.juju-secrets" ] && echo yes || echo no)"
  echo "$out" | sed 's/^/       /'
fi

# 4) Legacy oikos.db verschlüsselt, yuvomi.db fehlt -> ebenfalls Abbruch.
d="$work/encoikos"; mkdir -p "$d"
head -c 2048 /dev/urandom > "$d/oikos.db"
out=$(JUJU_SECRETS_FILE="$d/.juju-secrets" DB_PATH="$d/yuvomi.db" sh "$work/ep.sh" 2>&1)
if [ $? = 1 ] && [ ! -f "$d/.juju-secrets" ]; then
  pass "encdb-oikos: refuses to generate a new key"
else
  fail "encdb-oikos: exit $?"
  echo "$out" | sed 's/^/       /'
fi

# 5) Unverschlüsselte (Klartext-)DB: Migration erlaubt, Schlüssel wird erzeugt
#    (db.js verschlüsselt die Datei danach).
d="$work/plaindb"; mkdir -p "$d"
printf 'SQLite format 3\0' > "$d/yuvomi.db"; head -c 1024 /dev/zero >> "$d/yuvomi.db"
out=$(JUJU_SECRETS_FILE="$d/.juju-secrets" DB_PATH="$d/yuvomi.db" sh "$work/ep.sh" 2>&1)
if [ $? = 0 ] && [ -f "$d/.juju-secrets" ] && echo "$out" | grep -q BOOTED; then
  pass "plaintext-db: still generates key (db.js will encrypt)"
else
  fail "plaintext-db: exit $?"
  echo "$out" | sed 's/^/       /'
fi

# 6) Leere DB-Datei (0 Byte): frische Installation, Schlüssel wird erzeugt.
d="$work/emptydb"; mkdir -p "$d"
: > "$d/yuvomi.db"
out=$(JUJU_SECRETS_FILE="$d/.juju-secrets" DB_PATH="$d/yuvomi.db" sh "$work/ep.sh" 2>&1)
if [ $? = 0 ] && [ -f "$d/.juju-secrets" ] && echo "$out" | grep -q BOOTED; then
  pass "empty-db: generates key"
else
  fail "empty-db: exit $?"
  echo "$out" | sed 's/^/       /'
fi

# 7) DB_PATH zeigt in ein anderes Verzeichnis (Custom-Pfad) — Auflösung muss
#    dem konfigurierten Pfad folgen, nicht /data.
d="$work/customdb"; mkdir -p "$d/data"
head -c 512 /dev/urandom > "$d/data/juju.db"
out=$(JUJU_SECRETS_FILE="$d/.juju-secrets" DB_PATH="$d/data/juju.db" sh "$work/ep.sh" 2>&1)
if [ $? = 1 ] && echo "$out" | grep -aq 'juju.db'; then
  pass "custom-db-path: guard follows DB_PATH"
else
  fail "custom-db-path: exit $?"
  echo "$out" | sed 's/^/       /'
fi

# 8) Modus der erzeugten Datei: 600.
d="$work/mode"; mkdir -p "$d"
JUJU_SECRETS_FILE="$d/.juju-secrets" DB_PATH="$d/yuvomi.db" sh "$work/ep.sh" >/dev/null 2>&1
mode=$(stat -c '%a' "$d/.juju-secrets" 2>/dev/null || echo none)
if [ "$mode" = "600" ]; then
  pass "mode: secrets file created with 0600"
else
  fail "mode: got '$mode'"
fi

echo
if [ "$fail" = 0 ]; then
  echo "entrypoint secrets guard: ALL PASS"
  exit 0
fi
echo "entrypoint secrets guard: FAILURES"
exit 1
