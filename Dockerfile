FROM node:24-slim AS build

# Toolchain als Fallback für native Module: better-sqlite3-multiple-ciphers zieht
# normalerweise ein Prebuild (node-v127-linux-{x64,arm64}); schlägt der Download
# fehl, kompiliert node-gyp aus dem Quellcode. Die Cipher-Schicht steckt im Modul
# selbst - ein System-SQLCipher wird nicht mehr benötigt.
# --no-install-recommends: python3-pkg-resources & Co. landen sonst ungenutzt
# im Layer (~20 MB).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Abhängigkeiten zuerst (Docker-Layer-Caching)
COPY package*.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Image-Slimming, Stufe 1: native Module auf das Artefakt der Zielarchitektur
# reduzieren. `prebuilds/` enthält die .node-Binaries für acht Plattformen
# (darwin/win32/linuxmusl inklusive), `deps/` ist der SQLite-Quelltext zum
# Kompilieren. Beides wird zur Laufzeit nie gelesen und würde sonst in jedes
# Multi-Arch-Image mitwandern.
# Wichtig: das passiert in der BUILD-Stufe - ein rm im Runtime-Layer würde nur
# eine Löschmarkierung anlegen und keinen Byte sparen.
# ---------------------------------------------------------------------------
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH}" in arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac; \
    cd /app/node_modules/better-sqlite3-multiple-ciphers; \
    rm -rf deps; \
    find prebuilds -maxdepth 1 -type f ! -name "linux-${ARCH}.node" -delete

# ---- Runtime stage ----
FROM node:24-slim

# --no-install-recommends + Doku/Manpages raus: git bringt sonst git-man und
# git-doc mit, die im Container niemand liest.
RUN apt-get update && apt-get install -y --no-install-recommends \
    gosu \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man /usr/share/info /var/cache/apt

# npm/corepack zur Laufzeit entfernen: der In-Container-Updater baut über den
# Host-Daemon (docker.sock) und braucht kein npm im Image. Spart ~21 MB.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# Static docker CLI so the one-click updater can rebuild & replace this very
# container through the mounted /var/run/docker.sock (no docker daemon in-image).
RUN curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.3.1.tgz -o /tmp/docker.tgz \
 && tar xzf /tmp/docker.tgz -C /tmp \
 && mv /tmp/docker/docker /usr/local/bin/docker \
 && rm -rf /tmp/docker /tmp/docker.tgz

WORKDIR /app

# Node modules aus Build-Stage kopieren (bereits auf die Zielarchitektur getrimmt)
COPY --from=build /app/node_modules ./node_modules

# Anwendungscode (docs/ wird via .dockerignore ausgeschlossen)
COPY . .

# Daten-Volume-Verzeichnisse anlegen (Permissions werden zur Laufzeit gesetzt)
RUN mkdir -p /data /backups /app/modules /documents

# Container-Default für das Backup-Ziel. Ohne diesen ENV fällt die App auf ihren
# Bare-Metal-Default './backups' (= /app/backups) zurück - dort hat der node-User
# keine Schreibrechte, und die Backups landeten nicht im gemounteten Volume.
# Deployments, die BACKUP_DIR selbst setzen (Compose, TrueNAS, Umbrel, Quadlet),
# überschreiben diesen Wert wie gehabt.
ENV BACKUP_DIR=/backups

# Entrypoint: korrigiert Volume-Permissions und startet als node-User
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server/index.js"]
