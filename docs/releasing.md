# Release-Prozess

Ein Release besteht aus **einem Tag** — nicht aus einem Tag plus einem lokalen
Build. Grund: bei v0.0.74 wurde parallel gebaut, und das ausgelieferte Image
war nicht das getestete.

## Die eine Regel

> **Lokal niemals `docker buildx ... --push` ausführen.**

Der einzige Image-Builder ist `.github/workflows/docker-publish.yml`, und der
läuft ausschließlich bei einem `v*`-Tag (oder manuell per `workflow_dispatch`).
Wer zusätzlich lokal pusht, erzeugt ein zweites Image unter demselben Tag —
genau der Fehler, der bei v0.0.74 zu „getestet `49459ab6`, ausgeliefert
`a7c33848`" geführt hat.

## Ablauf

```bash
# 1) Version an drei Stellen gleich halten (sonst bricht das Gate):
#    package.json "version"
#    public/index.html  alle ?v=0.0.xx
#    public/sw.js       Cache-/Versionskonstante
#    (Hilfe: bump-00xx.py aus dem Maintainer-Arbeitsverzeichnis)

# 2) CHANGELOG.md ergänzen (wird im Update-Dialog der App angezeigt)

# 3) Commit, dann Tag
git add -A && git commit -m "release(v0.0.xx): ..."
git push origin main
git tag v0.0.xx            # lightweight reicht; das Gate prüft nur den Namen
git push origin v0.0.xx
```

Danach läuft im CI:

| Job | Prüft | Bricht ab bei |
|---|---|---|
| `Gate (i18n, lint, tests)` | Tag == `package.json`, i18n-Keys, Lint, komplette Test-Suite | Version driftet, roter Test |
| `Build & Push Image` | Multi-Arch-Build (amd64/arm64) → Docker Hub + ghcr | Build-Fehler |
| `Verify published image` | zieht **genau den eben gepushten Digest**, prüft Version im Image, startet einen Kaltstart-Container, erwartet `/health` 200 + `setup_required: true` + vollständige Migrationskette im Log | Image startet nicht, Version falsch, Migration hängt |

## Deployment (Digest pinnen)

Der Digest steht im Job-Summary von `Verify published image`.

```bash
# Compose-Deployment: Image-Referenz auf den Digest setzen
sed -i 's#^    image: .*#    image: daiqiongzhao/juju@sha256:<digest>#' docker-compose.yml
docker compose pull && docker compose up -d

# oder docker run: Image einfach durch die Digest-Referenz ersetzen
docker pull daiqiongzhao/juju@sha256:<digest>
```

Danach verifizieren: `curl -fsS https://<domain>/` muss 200 liefern und
`docker logs --tail 20 juju` die Zeile `Server running on port 3000 | Version
<neu>` zeigen — bei einer bestehenden DB zusätzlich `Schema v<N>`.

Für den Rollback den vorherigen Container bzw. die vorherige
Digest-Referenz behalten, bis der neue Stand einen Tag produktiv war.

Trotz Tag im Namen ist der Digest die verbindliche Angabe: Tags sind mutable,
Digests nicht. Nur so fährt die Produktion dieselben Bytes, die das Gate geprüft
hat.

## Manuell nachbauen (Notfall)

Wenn ein Tag-Build nicht durchläuft, das Image aber gebraucht wird:

```bash
gh workflow run docker-publish.yml --ref main    # baut :latest + :sha-<commit>
```

Der Lauf macht dieselben drei Jobs. Ein Image ohne grünes `verify-image` ist
kein Release — lieber den Tag neu setzen, nachdem der Fehler behoben ist.

## Was NICHT mehr nötig ist

* Lokale Build-Logs (`juju-build-*.log`) und `juju-publish-*.sh` — die Schritte
  sind im Workflow.
* Mehrfaches Prüfen „ist das Image wirklich das geprüfte?" — `verify-image`
  zieht über den Digest, nicht über den Tag.
