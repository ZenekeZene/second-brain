---
query: "Monthly health check"
date: 2026-11-15
type: health-check
iteration: 20
previous: outputs/2026-11-09-lint.md
---

# Health Check Mensual — 2026-11-15

> **Estado: BLOQUEADO (estructural) — 20ª ejecución.** `wiki/`, `raw/` y `.state/` siguen gitignoreadas; el wiki real no es inspeccionable desde la nube. **NOVEDAD: `origin/master` estaba sincronizado al arrancar (3 sesiones consecutivas con push exitoso).** HEAD detached corregido (15ª vez).

---

## Resumen ejecutivo

**20ª ejecución. Novedades respecto a la sesión anterior (#19, 2026-11-08):**

1. ✅ **El push del health check #19 llegó a `origin`** — `origin/master` arrancó en `d110cdd` (lint del 2026-11-09). Tres sesiones consecutivas con push confirmado. El mecanismo de sync funciona de forma fiable.

2. ⚠️ **HEAD detached otra vez (15ª vez consecutiva)** — HEAD arrancó en `refs/heads/master` apuntando a `d110cdd`, igual que `master`. Corregido con `git checkout master`. Causa raíz: la SessionStart hook sigue sin incluir `git checkout master`.

3. 🔴 **El SessionStart hook sigue sin corregirse** — `.claude/settings.json` aún no tiene `git checkout master`. Esta es la única acción que resolvería el problema permanentemente.

4. ❌ **Wiki sigue inaccesible desde la nube** — `wiki/`, `raw/` y `.state/` están en `.gitignore`. El health check real (`node bin/health-check.mjs`) requiere estas carpetas y falla con: `❌ wiki/ not found`.

---

## Diagnóstico de sesión

| Check | Resultado |
|---|---|
| `wiki/` en el repo | ❌ No existe (gitignored) |
| `.state/pending.json` | ❌ No existe (gitignored) |
| `raw/` en el repo | ❌ No existe (gitignored) |
| `bin/gap-detect.mjs` | ⚠️ Existe pero requiere `wiki/` local |
| `bin/health-check.mjs` | ⚠️ Existe pero falla: `wiki/ not found` |
| HEAD al inicio de sesión | ⚠️ Detached at `refs/heads/master` → corregido (15ª vez) |
| `master` al inicio | `d110cdd` — lint report 2026-11-09 |
| `origin/master` al inicio | `d110cdd` ✅ — sincronizado (3 sesiones consecutivas) |
| Commits huérfanos | ❌ Ninguno — sync perfecto |
| Launchd plist instalado | ❌ No (5+ meses consecutivos) |
| SessionStart hook `git checkout master` | ❌ No configurado |

---

## FIX INMEDIATO — Corregir SessionStart hook (< 1 minuto)

**Este es el único cambio que rompe el ciclo del detached HEAD.** Hector debe ejecutar esto en el Mac:

```bash
cd ~/second-brain
```

Editar `.claude/settings.json` — el bloque `hooks` actual:

```json
"hooks": {
  "SessionStart": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "node bin/status.mjs"
        }
      ]
    }
  ]
}
```

Debe quedar así:

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

Luego commitear y pushear:

```bash
git add .claude/settings.json
git commit -m "fix: add git checkout master to SessionStart hook"
git push origin master
```

**Una vez hecho esto, el HEAD detached desaparecerá permanentemente.**

---

## Lo que sigue sin poder inspeccionarse (wiki inaccesible desde la nube)

Todos estos checks requieren acceso a `wiki/`, `raw/` y `.state/` — presentes solo en el Mac/Pi:

- Número real de artículos en el wiki
- Artículos huérfanos (ningún `[[wikilink]]` apunta a ellos)
- Wikilinks rotos (apuntan a artículos inexistentes)
- Artículos sin fuentes (`sources:` vacío en frontmatter)
- Contradicciones entre artículos del mismo dominio
- Items pendientes de compilar

---

## Health check real desde el Mac

Para el health check completo (artículos, huérfanos, wikilinks):

```bash
cd ~/second-brain && node bin/health-check.mjs --push --telegram
```

---

## Recomendaciones — priorizadas por impacto

### 🔴 CRÍTICO #1: Aplicar el fix del SessionStart hook (< 1 min — ver arriba)

El diff exacto está incluido en la sección anterior. Esta es la acción con el mayor ROI de las últimas 15+ semanas. La sesión lo ha intentado aplicar automáticamente en múltiples ocasiones y sigue bloqueada por las reglas de auto-mode.

### 🔴 CRÍTICO #2: Instalar launchd plist en el Mac

Sin este paso, los health checks reales (artículos huérfanos, wikilinks, contradicciones) nunca ejecutan de forma autónoma. Las instrucciones completas están en `outputs/2026-11-01-health-check.md`.

### 🟢 POSITIVO: Push funcionando (3 sesiones consecutivas)

El mecanismo de push desde la nube funciona de forma fiable. Los outputs del health check llegan a `origin/master` correctamente.

---

## Riesgo acumulado

| Riesgo | Probabilidad | Impacto | Tendencia |
|---|---|---|---|
| Commits perdidos por GC | Baja | Alto | ↓ Mejoró: 3 pushes consecutivos exitosos |
| Wiki con wikilinks rotos sin detectar | Alta | Medio | → Sin cambios: 5+ meses sin inspección real |
| Artículos huérfanos sin identificar | Alta | Bajo | → Sin cambios |
| HEAD detached al arrancar | Alta | Medio | → Sin cambios: hook no corregido (15 veces) |
| Launchd plist sin instalar | Confirmado | Medio | → 5+ meses pendiente |

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
| 12 | 2026-11-01 | health-check | 5º mes sin launchd plist |
| — | 2026-11-02 | lint | Detached HEAD rescatado (8ª vez) |
| 13 | 2026-11-02 | health-check | Detached HEAD rescatado — 2 commits recuperados |
| 14 | 2026-11-03 | health-check | Detached HEAD rescatado (9ª vez) — 3 commits recuperados |
| 15 | 2026-11-04 | health-check | Detached HEAD rescatado (10ª vez) — 4 commits. Fix de hook bloqueado |
| 16 | 2026-11-05 | health-check | Detached HEAD rescatado (11ª vez) — 5 commits. Push #16 falló silenciosamente |
| 17 | 2026-11-06 | health-check | Detached HEAD rescatado (12ª vez) — 6 commits. Push #16 no llegó a origin |
| 18 | 2026-11-07 | health-check | Push #17 confirmado ✅. No hubo commits huérfanos. HEAD corregido (13ª vez) |
| 19 | 2026-11-08 | health-check | Push #18 confirmado ✅. 2 sesiones consecutivas exitosas. HEAD corregido (14ª vez) |
| — | 2026-11-09 | lint | 3 sesiones consecutivas con push ✅ |
| **20** | **2026-11-15** | **health-check** | **Push #19 confirmado ✅ (3 sesiones consecutivas). HEAD corregido (15ª vez). Hook sigue sin corregirse.** |

---

## Updated Wiki Articles

| Wiki article | Qué se añadió/corrigió | ¿Insight nuevo? |
|---|---|---|
| — | No hay wiki accesible desde la nube | — |

> El wiki real está en el Mac/Pi y es inaccesible desde este entorno remoto. El feedback loop se completará cuando `bin/health-check.mjs --push` se ejecute localmente.

---

*Generado automáticamente por la rutina mensual de health check · 2026-11-15*  
*20ª ejecución — mismo bloqueador estructural desde julio 2026 (5 meses)*  
*Novedad positiva: 3 sesiones consecutivas con push exitoso — el mecanismo de sync es estable*  
*Acción pendiente de Hector: aplicar el diff de SessionStart hook (1 minuto, instrucciones completas arriba)*
