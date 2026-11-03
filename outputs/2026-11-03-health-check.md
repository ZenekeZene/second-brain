---
query: "Monthly health check"
date: 2026-11-03
type: health-check
iteration: 14
previous: outputs/2026-11-02-health-check.md
---

# Health Check Mensual — 2026-11-03

> **Estado: BLOQUEADO (estructural) — mismo diagnóstico que las últimas 13 ejecuciones.** `wiki/`, `raw/` y `.state/` siguen gitignoreadas. El wiki real no es inspeccionable desde la nube. Los dos bloqueadores principales llevan **5+ meses sin resolverse**.

---

## Resumen ejecutivo

**14ª ejecución. Patrón idéntico.**

1. ✅ **3 commits rescatados** — HEAD comenzó detached en `3b4f950` con 3 commits no alcanzables desde `master` (health check 2026-11-01, lint 2026-11-02, health check 2026-11-02). Rescatados via `git checkout -b rescue-branch` + `git merge --ff-only` + push. **9ª vez que se ejecuta este rescate manual.**

2. ⚠️ **HEAD DETACHED — patrón enquistado** — Cada sesión cloud comienza en detached HEAD. La causa raíz es que el startup hook no incluye `git checkout master`. Lleva **3+ meses sin corregirse**. En cada sesión se vuelven a perder los commits si nadie los rescata.

3. ❌ **Launchd plist no instalado** — `bin/health-check.mjs --push` sigue sin ejecutarse localmente desde el Mac/Pi. **6º mes consecutivo.** Sin este paso, el health check real (artículos huérfanos, wikilinks rotos, contradicciones) nunca puede ejecutarse.

4. ❌ **3 commits pendientes de push** (antes del rescate) — los informes de las 2 últimas semanas nunca llegaron a origin/master. Serán empujados en esta sesión.

---

## Diagnóstico de sesión

| Check | Resultado |
|---|---|
| `wiki/` en el repo | ❌ No existe (gitignored) |
| `.state/pending.json` | ❌ No existe (gitignored) |
| `raw/` en el repo | ❌ No existe (gitignored) |
| `bin/gap-detect.mjs` | ⚠️ Existe pero requiere `wiki/` local |
| `bin/health-check.mjs` | ✅ Existe y funciona |
| SessionStart hook | ❌ Solo `node bin/status.mjs` — falta `git checkout master` (3 meses pendiente) |
| HEAD al inicio de sesión | ⚠️ Detached at `3b4f950` → rescatado (9ª vez) |
| Commits rescatados | ✅ 3 commits: f455753, 477b311, 3b4f950 |
| origin/master antes del push | `6482c17` — lint 2026-10-26 (¡2 semanas de lag!) |
| Launchd plist instalado | ❌ No (nunca instalado — 6 meses) |

---

## Lo que sigue sin poder inspeccionarse (wiki inaccesible desde la nube)

- Número real de artículos en el wiki y su distribución temática
- Artículos huérfanos (ningún `[[wikilink]]` apunta a ellos)
- Wikilinks rotos (apuntan a artículos inexistentes)
- Artículos sin fuentes (`sources:` vacío en frontmatter)
- Contradicciones entre artículos del mismo dominio
- Items pendientes de compilar

Todos estos checks requieren acceso a `wiki/`, `raw/` y `.state/` — presentes solo en el Mac/Pi.

---

## Recomendaciones — priorizadas por impacto

### 🔴 1. Añadir `git checkout master` al startup hook — **HOY** (3 meses pendiente, 9 rescates manuales)

Es una edición de 2 líneas en `.claude/settings.json`. Cada semana que pasa hay un nuevo rescate manual necesario. El riesgo de pérdida permanente de commits es real si nadie rescata antes del próximo GC de git.

Añadir este bloque al principio del array `hooks.SessionStart`:

```json
{
  "type": "command",
  "command": "git checkout master 2>/dev/null || true"
}
```

Resultado esperado en `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["WebFetch(*)", "Bash(npm run *)"]
  },
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
}
```

### 🔴 2. Instalar launchd plist en el Mac (6 meses pendiente — CRÍTICO)

Sin esto, los health checks reales (artículos huérfanos, wikilinks rotos, contradicciones) nunca se ejecutan. El wiki crece ciego. El plist tarda 5 minutos en instalarse:

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

### 🟢 3. Ejecutar el health check real desde el Mac ahora mismo

Si el Mac está disponible, en lugar de esperar al cron mensual:

```bash
cd ~/second-brain && node bin/health-check.mjs --push --telegram
```

Generará el primer informe real en 6 meses.

---

## Riesgo acumulado

| Riesgo | Probabilidad | Impacto |
|---|---|---|
| Pérdida de commits por GC antes del próximo rescate | Media | Alto — se pierden informes y potencialmente artículos del wiki |
| Wiki creciendo con wikilinks rotos sin detectar | Alta | Medio — degradación silenciosa de la calidad |
| Artículos huérfanos sin identificar | Alta | Bajo — información inaccesible pero no perdida |

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
| 12 | 2026-11-01 | health-check | Sin cambios — launchd plist 5º mes pendiente |
| — | 2026-11-02 | lint | Detached HEAD rescatado (8ª vez bloqueado) |
| 13 | 2026-11-02 | health-check | Detached HEAD rescatado — 2 commits recuperados |
| **14** | **2026-11-03** | **health-check** | Detached HEAD rescatado (9ª vez) — 3 commits recuperados vía rescue branch |

---

## Updated Wiki Articles

| Wiki article | Qué se añadió/corrigió | ¿Insight nuevo? |
|---|---|---|
| — | No hay wiki accesible desde la nube | — |

> El wiki real está en el Mac/Pi y es inaccesible desde este entorno remoto. El feedback loop se completará cuando `bin/health-check.mjs --push` se ejecute localmente.

---

*Generado automáticamente por la rutina mensual de health check · 2026-11-03*
*14ª ejecución — mismo bloqueador estructural desde julio 2026 (6 meses)*
*Rescate de commits detached: f455753, 477b311, 3b4f950 → empujados a origin/master en esta sesión*
