#!/bin/sh
# E2E-GESAMT: entrypoint-GUARD gegen echte SQLCipher-Datenbanken.
#
# Teil A: synthetische verschlüsselte DB (im echten Image, Node 24).
# Teil B: ECHTE Produktions-DB — Kopie der /data/yuvomi.db der laufenden
#         Dev-Instanz (Docker-Container "juju"), inkl. ihres echten Schlüssels.
# Teil C: db.js-Fehlermeldung enthält Wiederherstellungs-Hinweis.
#
# Alle node-Operationen laufen in daiqiongzhao/juju:latest: der Dev-Host hat
# Node 20, mit dem better-sqlite3-multiple-ciphers 13.x nicht lädt (deshalb
# überspringt auch die Test-Suite diese Fälle dort).
set -u
cd /tmp/juju-dev

IMG=daiqiongzhao/juju:latest
CHECKS=/tmp/e2e-check
WORK=/tmp/e2e-work
fails=0

rm -rf "$CHECKS" "$WORK"; mkdir -p "$CHECKS" "$WORK/a" "$WORK/b"
cp test/e2e-db.cjs "$CHECKS/e2e-db.cjs"
# Docker läuft mit Userns-Remap (Container-Root -> Host-User "lighthouse"):
# die Scratch-Verzeichnisse müssen für ihn beschreibbar sein.
chmod -R 777 "$CHECKS" "$WORK"

# Gekappte Kopie des entrypoint (nur Definitionen + load_secrets).
branch_line=$(grep -n '^if \[ "\$(id -u)" = "0" \]; then$' entrypoint.sh | head -1 | cut -d: -f1)
head -n $((branch_line - 1)) entrypoint.sh > "$CHECKS/ep.sh"
echo 'load_secrets && echo BOOTED' >> "$CHECKS/ep.sh"

node_run() { docker run --rm --user 0:0 --entrypoint node -e NODE_PATH=/app/node_modules -v "$CHECKS:/checks:ro" -v "$WORK:/e2e" "$IMG" /checks/e2e-db.cjs "$@"; }

echo "--- Teil A: synthetische verschlüsselte DB ---"
KEY_A=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
rm -f "$WORK/a/yuvomi.db"
if node_run create /e2e/a/yuvomi.db "$KEY_A" >/dev/null 2>&1 && [ -s "$WORK/a/yuvomi.db" ]; then
  echo "ok - A1: synthetische DB erzeugt"
else
  echo "FAIL A1: create"; fails=1
fi
if [ -s "$WORK/a/yuvomi.db" ] && ! head -c 16 "$WORK/a/yuvomi.db" | LC_ALL=C grep -aq 'SQLite format 3'; then
  echo "ok - A2: Datei ist NICHT im Klartext-Format"
else
  echo "FAIL A2"; fails=1
fi
res=$(node_run open-no-key /e2e/a/yuvomi.db 2>&1)
if [ "$res" = "REFUSED_WITHOUT_KEY" ]; then
  echo "ok - A3: ohne Schlüssel nicht zu öffnen (wirklich verschlüsselt)"
else
  echo "FAIL A3: $res"; fails=1
fi

# Guard: Datei fehlt, DB vorhanden -> Abbruch, DB byte-identisch.
hash_before=$(md5sum "$WORK/a/yuvomi.db" | cut -d' ' -f1)
rm -f "$WORK/a/.juju-secrets"
out=$(JUJU_SECRETS_FILE="$WORK/a/.juju-secrets" DB_PATH="$WORK/a/yuvomi.db" sh "$CHECKS/ep.sh" 2>&1)
st=$?
hash_after=$(md5sum "$WORK/a/yuvomi.db" | cut -d' ' -f1)
if [ "$st" = 1 ] && [ ! -f "$WORK/a/.juju-secrets" ] && [ "$hash_before" = "$hash_after" ] \
   && echo "$out" | grep -aq '\[FATAL\]'; then
  echo "ok - A4: Guard stoppt Start, keine neue Schlüsseldatei, DB unverändert"
else
  echo "FAIL A4: status=$st"; echo "$out" | sed 's/^/    /'; fails=1
fi

# Guard im ECHTEN Image (sh/head/grep/node vorhanden). WICHTIG:
# --entrypoint sh überschreibt den Image-Entrypoint (der sonst selbst die
# Schlüsseldatei anlegen würde); die drei -e-Leerungen sind reine
# Verteidigung in der Tiefe - das Registry-Image backt KEINE Standard-
# Schlüssel (ENV von :0.0.31 und :latest gegenprüft), sie stellen nur
# sicher, dass der Umwelt-Pfad nicht vor dem Guard greift, falls ein
# Deployment oder eine Registry die Standardwerte jemals setzen sollte.
res=$(docker run --rm --user 0:0 --entrypoint sh -e JUJU_SECRETS_FILE=/e2e/a/.juju-secrets -e DB_PATH=/e2e/a/yuvomi.db \
      -e DB_ENCRYPTION_KEY= -e JUJU_SM4_KEY= -e SESSION_SECRET= \
      -v "$CHECKS:/checks:ro" -v "$WORK:/e2e" "$IMG" /checks/ep.sh 2>&1)
st=$?
if [ "$st" = 1 ] && echo "$res" | grep -aq '\[FATAL\]' && [ ! -f "$WORK/a/.juju-secrets" ]; then
  echo "ok - A5: Guard funktioniert im Image (Node 24)"
else
  echo "FAIL A5: status=$st"; echo "$res" | sed 's/^/    /'; fails=1
fi

# Daten überleben mit korrektem Schlüssel.
res=$(node_run check /e2e/a/yuvomi.db "$KEY_A" produktionsdaten 2>&1)
if [ "$res" = "DATA_INTACT" ]; then
  echo "ok - A6: DB mit korrektem Schlüssel weiterhin lesbar"
else
  echo "FAIL A6: $res"; fails=1
fi

# Umwelt-Schlüssel werden übernommen (Legacy-.env-Pfad):
rm -f "$WORK/a/.juju-secrets"
res=$(docker run --rm --user 0:0 --entrypoint sh \
      -e DB_ENCRYPTION_KEY="$KEY_A" -e JUJU_SM4_KEY="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')" -e SESSION_SECRET="$KEY_A" \
      -e JUJU_SECRETS_FILE=/e2e/a/.juju-secrets -e DB_PATH=/e2e/a/yuvomi.db \
      -v "$CHECKS:/checks:ro" -v "$WORK:/e2e" "$IMG" /checks/ep.sh 2>&1)
st=$?
if [ "$st" = 0 ] && echo "$res" | grep -q BOOTED && grep -q "^DB_ENCRYPTION_KEY=$KEY_A\$" "$WORK/a/.juju-secrets"; then
  echo "ok - A7: Umwelt-Schlüssel persistiert (Legacy-.env-Upgrade-Pfad)"
else
  echo "FAIL A7: status=$st"; echo "$res" | sed 's/^/    /'; fails=1
fi

echo "--- Teil B: ECHTE DB der laufenden Instanz ---"
if docker ps --format '{{.Names}}' | grep -qx juju; then
  docker cp juju:/data/yuvomi.db "$WORK/b/yuvomi.db" 2>/dev/null || { echo "FAIL B1: docker cp"; fails=1; }
  if [ -s "$WORK/b/yuvomi.db" ]; then
    echo "ok - B1: echte Instanz-DB kopiert"
  else
    echo "FAIL B1: Kopie leer"; fails=1
  fi
  KEY_B=$(docker exec juju printenv DB_ENCRYPTION_KEY)
  if [ -n "$KEY_B" ]; then
    echo "ok - B1: Schlüssel aus Container-Umwelt gelesen (${#KEY_B} Zeichen)"
  else
    echo "FAIL B1: kein Schlüssel im Container"; fails=1
  fi

  # Echtheitsprobe: mit echtem Schlüssel lesbar, ohne Schlüssel nicht.
  res=$(node_run check /e2e/b/yuvomi.db "$KEY_B" 2>&1)
  if [ "$res" = "DATA_INTACT" ]; then
    echo "ok - B2: echte DB mit Container-Schlüssel lesbar"
  else
    echo "FAIL B2: $res"; fails=1
  fi
  res=$(node_run open-no-key /e2e/b/yuvomi.db 2>&1)
  if [ "$res" = "REFUSED_WITHOUT_KEY" ]; then
    echo "ok - B3: echte DB ohne Schlüssel nicht zu öffnen"
  else
    echo "FAIL B3: $res"; fails=1
  fi

  # Guard gegen die ECHTE Datei: Schlüsseldatei fehlt -> Abbruch, Byte-Gleichheit.
  hash_before=$(md5sum "$WORK/b/yuvomi.db" | cut -d' ' -f1)
  rm -f "$WORK/b/.juju-secrets"
  out=$(JUJU_SECRETS_FILE="$WORK/b/.juju-secrets" DB_PATH="$WORK/b/yuvomi.db" sh "$CHECKS/ep.sh" 2>&1)
  st=$?
  hash_after=$(md5sum "$WORK/b/yuvomi.db" | cut -d' ' -f1)
  if [ "$st" = 1 ] && [ ! -f "$WORK/b/.juju-secrets" ] && [ "$hash_before" = "$hash_after" ] \
     && echo "$out" | grep -aq '\[FATAL\]'; then
    echo "ok - B4: Guard schützt die echte Instanz-DB (kein Rekey)"
  else
    echo "FAIL B4: status=$st"; echo "$out" | sed 's/^/    /'; fails=1
  fi
else
  echo "skip - Teil B: kein laufender Container 'juju'"
fi

echo "--- Teil C: db.js-Hinweis ---"
if grep -q 'restore it from the newest backup bundle' server/db.js; then
  echo "ok - C1: db.js-Fehlermeldung enthält Wiederherstellungs-Hinweis"
else
  echo "FAIL C1"; fails=1
fi

echo
if [ "$fails" = 0 ]; then
  echo "E2E: ALLE PRUEFUNGEN BESTANDEN"
  rm -rf "$CHECKS" "$WORK"
  exit 0
fi
echo "E2E: FEHLER"
exit 1
