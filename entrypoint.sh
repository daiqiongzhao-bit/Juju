#!/bin/sh
# Entrypoint: Volume-Permissions zur Laufzeit korrigieren, dann als node-User starten.
# Notwendig, weil Docker beim Mounten eines named Volume die Image-Permissions überschreibt.
#
# Bei root-Start (normales Docker/Compose): Ownership der Volumes korrigieren und via
# gosu zum unprivilegierten node-User wechseln.
# Bei non-root-Start (z. B. TrueNAS startet den Container als 568:568, nachdem ein
# eigener Permissions-Container die Volumes bereits gechownt hat): direkt als der
# zugewiesene User starten — gosu wäre hier ohnehin nicht möglich.
#
# ---------------------------------------------------------------------------
# Schlüssel-Selbstgenerierung (seit 0.0.28)
# ---------------------------------------------------------------------------
# Plattformen wie fnOS validieren die Compose-Datei VOR dem ersten Start der
# App. Eine env_file, die erst ein Install-Callback anlegen würde, existiert
# zum Prüfzeitpunkt noch nicht — die Installation bricht ab mit
# "env file ... not found" (auf fnOS real aufgetreten). Deshalb erzeugt der
# Container die Schlüssel selbst: beim ersten Start, atomar (tmp + mv),
# im persistierten Daten-Volume.
#
# Die Datei wird NUR angelegt, wenn sie fehlt. Ein neuer DB_ENCRYPTION_KEY
# macht eine verschlüsselte DB unlesbar, ein neuer JUJU_SM4_KEY killt die
# Feldverschlüsselung — existiert die Datei also, werden ihre Werte
# unverändert übernommen. Datei löschen = Datenverlust (nur mit Backup
# wiederherstellbar).
set -e

SECRETS_FILE="${JUJU_SECRETS_FILE:-/data/.juju-secrets}"

# Fehlt die Datei: atomar anlegen (tmp + mv, 600 via umask).
ensure_secrets() {
  [ -f "$SECRETS_FILE" ] && return 0
  tmp="${SECRETS_FILE}.tmp.$$"
  (umask 077
  {
    echo "# Juju secrets - automatisch beim ersten Start erzeugt (0.0.28+)."
    echo "# NICHT löschen: ohne diese Datei sind die verschlüsselte Datenbank und"
    echo "# alle verschlüsselten Felder dauerhaft unlesbar. Backup aufbewahren!"
    node -e '
      const c = require("crypto");
      console.log("DB_ENCRYPTION_KEY=" + c.randomBytes(32).toString("hex"));
      console.log("JUJU_SM4_KEY=" + c.randomBytes(16).toString("hex"));
      console.log("SESSION_SECRET=" + c.randomBytes(32).toString("hex"));
    '
  } > "$tmp")
  mv -f "$tmp" "$SECRETS_FILE"
}

# Werte in die Umwelt exportieren und validieren. Fehlt ein Schlüssel, hart
# abbrechen — ein stiller Fallback auf unverschlüsselte DB wäre schlimmer.
load_secrets() {
  ensure_secrets
  set -a
  . "$SECRETS_FILE"
  set +a
  for key in DB_ENCRYPTION_KEY JUJU_SM4_KEY SESSION_SECRET; do
    eval "value=\$$key"
    if [ -z "$value" ]; then
      echo "[FATAL] $key fehlt in $SECRETS_FILE - Start abgebrochen." >&2
      echo "[FATAL] Datei nicht löschen - ggf. letzte Sicherung wiederherstellen." >&2
      exit 1
    fi
  done
}

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data /backups /app/modules
  # Documents-Mount (Default-aktiv in den Compose-Dateien) mitbehandeln; der
  # Pfad ist konfigurierbar, daher mit Guard statt hart verdrahtet.
  docs_dir="${DOCUMENT_STORAGE_LOCAL_PATH:-/documents}"
  [ -d "$docs_dir" ] && chown -R node:node "$docs_dir"
  load_secrets
  chown node:node "$SECRETS_FILE" 2>/dev/null || true
  chmod 600 "$SECRETS_FILE" 2>/dev/null || true
  exec gosu node "$@"
fi
load_secrets
exec "$@"
