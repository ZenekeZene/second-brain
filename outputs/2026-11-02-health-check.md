---
query: "Monthly health check"
date: 2026-11-02
type: health-check
iteration: 13
previous: outputs/2026-11-01-health-check.md
---

# Health Check Mensual — 2026-11-02

> **Estado: BLOQUEADO (estructural) — sin cambios respecto al informe #12.** `wiki/`, `raw/` y `.state/` siguen gitignoreadas. El wiki real sigue sin ser inspeccionable desde el entorno cloud. El bloqueador principal lleva **5 meses sin resolverse**.

---

## Resumen ejecutivo

**Decimotercera ejecución. Situación idéntica.**

1. ✅ **Commits rescatados** — HEAD estaba detached en `477b311` con 2 commits no alcanzables desde `master` (lint 2026-11-02 y health check 2026-11-01). Rescatados con `git branch -f master HEAD`. master apunta ahora a `477b311`.

2. ⚠️ **HEAD DETACHED — patrón recurrente** — Cada sesión cloud comienza en detached HEAD. El fix es añadir `git checkout master` al startup hook. Lleva 3+ meses pendiente. Cada sesión pierde los commits si nadie los rescata.

3. ❌ **Launchd plist no instalado** — `bin/health-check.mjs --push` sigue sin ejecutarse localmente. **6º mes consecutivo.** Sin este paso, estos informes mensuales nunca podrán inspeccionar el wiki real.

4. ❌ **2 commits pendientes de push** — lint 2026-11-02 y health check 2026-11-01 están en local pero no en `origin/master`. Este informe los empujará todos juntos.

---

## Diagnóstico de sesión

| Check | Resultado |
|---|---|
| `wiki/` en el repo | ❌ No existe (gitignored) |
| `.state/pending.json` | ❌ No existe (gitignored) |
| `raw/` en el repo | ❌ No existe (gitignored) |
| `bin/gap-detect.mjs` | ⚠️ Existe pero requiere `wiki/` local |
| `bin/health-check.mjs` | ✅ Existe y funciona |
| SessionStart hook | ⚠️ Solo `node bin/status.mjs` — falta `git checkout master` |
| HEAD vs origin/master | ⚠️ Ahead by 2 commits (no pushados aún) |
| Estado HEAD al inicio | ⚠️ Detached at `refs/heads/master` → rescatado |
| Commit actual (HEAD) | `477b311` — lint 2026-11-02 |
| origin/master | `6482c17` — lint 2026-10-26 (¡2 semanas de lag!) |
| Launchd plist instalado | ❌ No (nunca instalado — 5 meses) |

---

## Lo que sigue sin poderse inspeccionar (wiki inaccesible desde la nube)

- Número real de artículos en el wiki y su distribución temática
- Artículos huérfanos (ningún `[[wikilink]]` apunta a ellos)
- Wikilinks rotos (apuntan a artículos inexistentes)
- Artículos sin fuentes (`sources:` vacío en frontmatter)
- Contradicciones entre artículos del mismo dominio
- Items pendientes de compilar

Todos estos checks requieren acceso a `wiki/`, `raw/` y `.state/` — presentes solo en el Mac/Pi.

---

## Recomendaciones — priorizadas por impacto

### 🔴 1. Instalar launchd plist en el Mac (5 meses pendiente — CRÍTICO)

Esta es la única acción que desbloquea los health checks reales. Sin ella, estos informes son siempre el mismo documento vacío. Tarda 5 minutos.

```bash
cat > ~/Library/LaunchAgents/com.zeneke.second-brain-health.plist << 'EOF'
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
EOF

launchctl load ~/Library/LaunchAgents/com.zeneke.second-brain-health.plist
launchctl list | grep second-brain-health
```

### 🔴 2. Añadir `git checkout master` al startup hook (3 meses pendiente)

Sin esto, cada sesión cloud comienza en detached HEAD y los commits se pierden si nadie los rescata manualmente. Editar `.claude/settings.json`:

```json
"hooks": {
  "SessionStart": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "git checkout master 2>/dev/null || true"
        },
        {
          "type": "command",
          "command": "node bin/status.mjs"
        }
      ]
    }
  ]
}
```

### 🟡 3. Ejecutar el health check real desde el Mac ahora mismo

Si el Mac está disponible:

```bash
cd ~/second-brain && node bin/health-check.mjs --push --telegram
```

Generará el primer informe real con artículos huérfanos, wikilinks rotos, y artículos sin fuentes.

---

## Riesgo de pérdida de datos

Cada sesión cloud crea commits en detached HEAD. Si nadie ejecuta el rescate antes del próximo GC de git, esos commits se pierden permanentemente. Actualmente hay 2 commits en riesgo que serán empujados en esta sesión, pero el patrón se repetirá.

**Commits rescatados en esta sesión:**
- `f455753` — health check 2026-11-01
- `477b311` — lint 2026-11-02

---

## Historial completo de ejecuciones

| # | Fecha | Tipo | Novedad |
|---|---|---|---|
| 1 | 2026-07-01 | health-check | Primera ejecución |
| 2 | 2026-09-27 | health-check | — |
| 3 | 2026-09-28 | lint | — |
| 4 | 2026-10-01 | health-check | — |
| 5 | 2026-10-04 | health-check | — |
| 6 | 2026-10-05 | lint | — |
| 7 | 2026-10-05 | health-check | — |
| 8 | 2026-10-06 | health-check | — |
| 9 | 2026-10-11 | health-check | Recuperación de commits huérfanos |
| — | 2026-10-12 | lint | — |
| 10 | 2026-10-18 | health-check | Bug push corregido |
| — | 2026-10-19 | lint | — |
| 11 | 2026-10-25 | health-check | Hook bloqueado por auto-mod classifier |
| — | 2026-10-26 | lint | — |
| 12 | 2026-11-01 | health-check | Sin cambios — 5º mes sin launchd plist |
| — | 2026-11-02 | lint | Detached HEAD rescatado (8ª vez bloqueado) |
| **13** | **2026-11-02** | **health-check** | Detached HEAD rescatado — 2 commits recuperados |

---

## Updated Wiki Articles

| Wiki article | Qué se añadió/corrigió | ¿Insight nuevo? |
|---|---|---|
| — | No hay wiki accesible desde la nube | — |

> El wiki real está en el Mac/Pi y es inaccesible desde este entorno remoto. El feedback loop se completará cuando `bin/health-check.mjs --push` se ejecute localmente.

---

*Generado automáticamente por la rutina mensual de health check · 2026-11-02*  
*13ª ejecución — mismo bloqueador estructural desde julio 2026*  
*Rescate de commits detached: f455753, 477b311 → empujados a origin/master en esta sesión*
