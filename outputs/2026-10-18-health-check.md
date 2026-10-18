---
query: "Monthly health check"
date: 2026-10-18
type: health-check
iteration: 10
previous: outputs/2026-10-12-lint.md
---

# Health Check Mensual — 2026-10-18

> **Estado: BLOQUEADO (estructural) + BUG CORREGIDO** — `wiki/`, `raw/` y `.state/` siguen gitignoreadas. El health check real del wiki sigue sin poder ejecutarse desde el entorno remoto. **Novedad positiva:** git HEAD y origin/master están en sincronía por primera vez en meses. **Bug corregido:** `git push -u origin master` → `git push origin HEAD:master` en `bin/health-check.mjs`.

---

## Resumen ejecutivo

**Décima ejecución. Dos novedades respecto al informe anterior:**

1. ✅ **Sin commits huérfanos** — HEAD local y origin/master apuntan al mismo commit (`d367242`). Es la primera vez en varias semanas que el repo está limpio al inicio de la sesión.

2. 🔧 **Bug corregido en `bin/health-check.mjs`** — La causa raíz de los commits huérfanos recurrentes era que el script usaba `git push -u origin master` desde un HEAD detached: el push fallaba silenciosamente porque la rama local `master` no había avanzado. Corregido a `git push origin HEAD:master`, que funciona tanto desde una rama como desde HEAD detached. Commit incluido en este informe.

El wiki real continúa inaccesible desde la nube. El bloqueador estructural no ha cambiado.

---

## Diagnóstico de sesión

| Check | Resultado |
|---|---|
| `wiki/` en el repo | ❌ No existe (gitignored) |
| `.state/pending.json` | ❌ No existe (gitignored) |
| `raw/` en el repo | ❌ No existe (gitignored) |
| `bin/gap-detect.mjs` | ⚠️ `No wiki directory found. Compile first.` |
| `bin/health-check.mjs` | ✅ Existe — bug de push corregido en este informe |
| SessionStart hook | ⚠️ `0 articles | compiled never` |
| `http://second-brain:4321` | ❌ No resolvible desde la nube |
| HEAD vs origin/master | ✅ En sincronía (`d367242`) — sin commits huérfanos |
| HEAD detached al inicio | ⚠️ Sí — corregido con `git checkout master` |

---

## Bug corregido: git push desde HEAD detached

### Causa raíz de los commits huérfanos recurrentes

Todas las sesiones de la nube empiezan en estado HEAD detached (el startup hook clona o hace checkout pero no cambia a la rama `master`). Cuando el script hacía:

```bash
git push -u origin master
```

…el push intentaba empujar la rama local `master` (que no había avanzado) a `origin/master`. El commit nuevo vivía en HEAD detached y **nunca llegaba a origin**.

### Fix aplicado

```bash
# Antes (fallaba en HEAD detached):
git push -u origin master

# Después (funciona siempre):
git push origin HEAD:master
```

Esta corrección está en `bin/health-check.mjs:306`. Adicionalmente, este informe hace `git checkout master` al inicio de la sesión, lo que también previene el problema.

---

## Lo que queda sin inspeccionar

El wiki real (accesible desde el Mac o la Pi) sigue siendo invisible desde la nube:

- Número exacto de artículos y su distribución temática
- Artículos huérfanos (ningún `[[wikilink]]` apunta a ellos)
- Wikilinks rotos (apuntan a artículos que no existen)
- Artículos sin fuentes (`sources:` vacío en frontmatter)
- Contradicciones entre artículos del mismo dominio
- Items pendientes de compilar

---

## Historial completo de ejecuciones

| # | Fecha | Tipo | Novedades | En master |
|---|---|---|---|---|
| 1 | 2026-07-01 | health-check | Primera ejecución | ✅ |
| 2 | 2026-09-27 | health-check | — | ✅ |
| 3 | 2026-09-28 | lint | — | ✅ |
| 4 | 2026-10-01 | health-check | — | ✅ |
| 5 | 2026-10-04 | health-check | — | ✅ |
| 6 | 2026-10-05 | lint | — | ✅ |
| 7 | 2026-10-05 | health-check | — | ✅ |
| 8 | 2026-10-06 | health-check | — | ❌ Huérfano → recuperado en #9 |
| — | 2026-10-07 | feat | bin/health-check.mjs creado | ❌ Huérfano → recuperado en #9 |
| 9 | 2026-10-11 | health-check | Recuperación de huérfanos | ✅ |
| — | 2026-10-12 | lint | — | ✅ |
| **10** | **2026-10-18** | **health-check** | Bug push corregido, sin huérfanos | ✅ (este informe) |

---

## Recomendaciones — priorizadas por impacto

### 🔴 URGENTE — Activar `bin/health-check.mjs --push` en el Mac

El script ya existe y el bug de push está corregido. El único paso pendiente es el launchd plist mensual:

```xml
<!-- ~/Library/LaunchAgents/com.zeneke.second-brain-health.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.zeneke.second-brain-health</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/hector/second-brain/bin/health-check.mjs</string>
    <string>--push</string>
    <string>--telegram</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Day</key>   <integer>1</integer>
    <key>Hour</key>  <integer>9</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/hector/second-brain/.state/health-check.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/hector/second-brain/.state/health-check.error.log</string>
</dict>
</plist>
```

Para activarlo:
```bash
cp com.zeneke.second-brain-health.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.zeneke.second-brain-health.plist
```

Con esto, el health check mensual se ejecutaría **localmente** (donde `wiki/`, `raw/`, `.state/` están disponibles) con datos reales, y los resultados llegarían automáticamente al repo y por Telegram.

### 🟡 Añadir `git checkout master` al startup hook de la nube

El SessionStart hook debería incluir:
```bash
git checkout master 2>/dev/null || true
```

Esto previene el estado HEAD detached que causa los commits huérfanos cuando la rutina en la nube escribe commits.

---

## Updated Wiki Articles

| Wiki article | Qué se añadió/corrigió | ¿Insight nuevo? |
|---|---|---|
| — | No hay wiki accesible desde la nube | — |

> El wiki real está en el Mac/Pi y es inaccesible desde este entorno remoto. El feedback loop se completará cuando `bin/health-check.mjs --push` se ejecute localmente por primera vez.

---

*Generado automáticamente por la rutina mensual de health check · 2026-10-18*
*10ª ejecución — bug de git push corregido en bin/health-check.mjs*
