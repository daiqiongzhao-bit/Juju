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
#
# FEHLENDE Datei heißt aber NICHT automatisch "erster Start" (Fix 0.0.32,
# Produktionscrash auf fnOS):
#   a) Klassische Compose-Installationen (.env, Podman-Quadlet, TrueNAS-Apps)
#      liefern die Schlüssel über die Umwelt. Diese Werte sind die ECHTEN —
#      sie werden in die Datei übernommen, nie neu generiert. Ein generierter
#      Ersatz hätte die bestehende Verschlüsselung zerstört (genau dieser
#      Griff warf Instanzen nach dem Image-Upgrade auf >= 0.0.28 aus).
#   b) Gibt es KEINE Schlüssel in der Umwelt, existiert aber schon ein
#      VERSCHLÜSSELTES DB-File (Migration, Wiederherstellung einer nackten
#      .db, manuelles Kopieren ohne die versteckte Schlüsseldatei), gehört
#      dazu ein Schlüssel, den wir nicht haben. Ein jetzt generierter Schlüssel
#      würde die Datenbank dauerhaft unlesbar machen — jeder Start endete mit
#      "[DB] Wrong encryption key". Daher bricht ensure_secrets() in dem Fall
#      mit einer Wiederherstellungs-Anleitung ab. Die Daten bleiben intakt:
#      der Schlüsselverlust ist reparabel (Backup), ein überschriebener nicht.
set -e

SECRETS_FILE="${JUJU_SECRETS_FILE:-/data/.juju-secrets}"

# Erkennt ein verschlüsseltes (SQLCipher-)DB-File am fehlenden Klartext-Header.
# SQLite-Klartextdateien beginnen mit "SQLite format 3\0" — fehlt der Header,
# ist die Datei verschlüsselt oder binärer Müll. Leere, winzige oder unlesbare
# Dateien gelten als NICHT verschlüsselt (frische Installation, Platzhalter).
is_encrypted_db_file() {
  [ -s "$1" ] || return 1
  head -c 16 "$1" 2>/dev/null | LC_ALL=C grep -aq 'SQLite format 3' && return 1
  return 0
}

# Schreibt die Schlüsseldatei: jeder in der Umwelt gesetzte Wert wird
# unverändert übernommen, fehlende werden neu erzeugt. Atomar (tmp + mv),
# 600 via umask.
persist_env_secrets() {
  tmp="${SECRETS_FILE}.tmp.$$"
  (umask 077
  {
    echo "# Juju secrets - verwaltet vom Container-Entrypoint (0.0.32+)."
    echo "# Gesetzte Umwelt-Werte wurden übernommen, fehlende neu erzeugt."
    echo "# Nicht löschen: ohne diese Datei sind die verschlüsselte Datenbank und"
    echo "# alle verschlüsselten Felder dauerhaft unlesbar. Backup aufbewahren!"
    node -e '
      const c = require("crypto");
      const hex = (bytes) => c.randomBytes(bytes).toString("hex");
      const value = (name, bytes) => {
        const env = process.env[name];
        return env && env.length ? env : hex(bytes);
      };
      console.log("DB_ENCRYPTION_KEY=" + value("DB_ENCRYPTION_KEY", 32));
      console.log("JUJU_SM4_KEY=" + value("JUJU_SM4_KEY", 16));
      console.log("SESSION_SECRET=" + value("SESSION_SECRET", 32));
    '
  } > "$tmp")
  mv -f "$tmp" "$SECRETS_FILE"
}

# Fehlt die Datei: Werte bestimmen (Umwelt / Abbruch / Neuerzeugung), dann
# atomar anlegen (tmp + mv, 600 via umask).
ensure_secrets() {
  [ -f "$SECRETS_FILE" ] && return 0

  # (a) Der DB-Schlüssel aus der Umwelt ist maßgeblich — übernehmen, nicht
  #     erzeugen. (Nur wenn ER gesetzt ist: ohne ihn wäre jede Übernahme ein
  #     Rekey. Fehlende SM4-/SESSION-Werte werden ergänzt, sie gefährden die
  #     DB nicht.)
  if [ -n "${DB_ENCRYPTION_KEY:-}" ]; then
    persist_env_secrets
    return 0
  fi

  # (b) Kein Schlüssel in der Umwelt: fehlende Datei heißt nur dann "erster
  #     Start", wenn auch keine verschlüsselte DB existiert. Geprüft werden der
  #     konfigurierte DB_PATH und der Legacy-Pfad oikos.db im selben
  #     Verzeichnis — dieselbe Auflösung wie in server/db.js.
  db_file="${DB_PATH:-/app/yuvomi.db}"
  db_dir=$(dirname "$db_file")
  for candidate in "$db_file" "$db_dir/oikos.db"; do
    if is_encrypted_db_file "$candidate"; then
      echo "[FATAL] $SECRETS_FILE fehlt, aber $candidate ist eine verschlüsselte" >&2
      echo "[FATAL] Datenbank. Ein neuer Schlüssel würde sie dauerhaft unlesbar" >&2
      echo "[FATAL] machen — es wird ABSICHTLICH keine neue Schlüsseldatei erzeugt." >&2
      echo "[FATAL]" >&2
      echo "[FATAL] Wiederherstellung (eine der Optionen):" >&2
      echo "[FATAL]  1) Neuestes Sicherungspaket aus dem Sicherungsverzeichnis" >&2
      echo "[FATAL]     (/backups, *.zip) entpacken und die enthaltene .juju-secrets" >&2
      echo "[FATAL]     nach $db_dir/ kopieren (Besitzer node, chmod 600), dann starten." >&2
      echo "[FATAL]  2) Weboberfläche: Sicherung -> Wiederherstellen des Pakets" >&2
      echo "[FATAL]     MIT Schlüsseldatei (\"restore secrets\")." >&2
      echo "[FATAL]  3) Stammen die Schlüssel aus einer .env / Compose-Datei:" >&2
      echo "[FATAL]     DB_ENCRYPTION_KEY dort erneut als Umgebungsvariable setzen" >&2
      echo "[FATAL]     — der Umwelt-Wert wird übernommen und persistiert." >&2
      echo "[FATAL]  4) Daten endgültig nicht mehr benötigt: $candidate (und ggf." >&2
      echo "[FATAL]     $db_dir/oikos.db) beiseiteschieben und neu starten — es" >&2
      echo "[FATAL]     wird eine frische, leere Datenbank angelegt." >&2
      exit 1
    fi
  done

  # (c) Wirklich erster Start (oder einzelne Umwelt-Schlüssel ohne DBKEY):
  #     fehlende Werte neu erzeugen, gesetzte Umwelt-Werte übernehmen.
  persist_env_secrets
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
