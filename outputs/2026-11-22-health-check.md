---
query: "Monthly health check"
date: 2026-11-22
type: health-check
iteration: 21
previous: outputs/2026-11-16-lint.md
---

# Health Check Mensual — 2026-11-22

> **Estado: BLOQUEADO (estructural) — 21ª ejecución.** `wiki/`, `raw/` y `.state/` siguen gitignoreadas; el wiki real no es inspeccionable desde la nube. **NOVEDAD: `origin/master` arrancó en sincronía perfecta con master. `7f8a325` (huérfano de 2026-11-16) ya está en master ✅.**

---

## Resumen ejecutivo

**21ª ejecución. Novedades respecto a la sesión anterior (#20, 2026-11-15):**

1. ✅ **Commit `7f8a325` rescatado — está en `master`** — El health-check de 2026-11-15 que quedó como huérfano en la sesión de lint aparece ahora correctamente en la historia de master. Alguien lo cherry-pickeó (Hector manualmente o la sesión de lint lo logró antes de terminar).

2. ✅ **master, HEAD y origin/master completamente sincronizados al arrancar** — Todo en `f191162` (lint 2026-11-16). Sin commits huérfanos. Cuatro sesiones consecutivas con push exitoso confirmado.

3. ⚠️ **HEAD detached otra vez (17ª vez consecutiva)** — Arrancó en `refs/heads/master` apuntando a `f191162`. Corregido con `git checkout master`. La causa raíz no ha cambiado.

4. 🔴 **El SessionStart hook sigue sin `git checkout master`** — `.claude/settings.json` revisado: solo tiene `node bin/status.mjs`. Esta es la 17ª semana documentando este único fix pendiente.

5. ❌ **Wiki sigue inaccesible desde la nube** — `wiki/`, `raw/` y `.state/` están en `.gitignore`. El health check real no puede ejecutarse desde este entorno.

---

## Diagnóstico de sesión

| Check | Resultado |
|---|---|
| `wiki/` en el repo | ❌ No existe (gitignored) |
| `.state/pending.json` | ❌ No existe (gitignored) |
| `raw/` en el repo | ❌ No existe (gitignored) |
| `bin/gap-detect.mjs` | ⚠️ Existe pero requiere `wiki/` local |
| `bin/health-check.mjs` | ⚠️ Existe pero falla: `wiki/ not found` |
| HEAD al inicio de sesión | ⚠️ Detached at `refs/heads/master` → corregido (17ª vez) |
| `master` al inicio | `f191162` — lint report 2026-11-16 |
| `origin/master` al inicio | `f191162` ✅ — sincronizado |
| `7f8a325` (huérfano anterior) | ✅ Ahora en master — rescatado |
| Commits huérfanos actuales | ✅ Ninguno |
| SessionStart hook `git checkout master` | ❌ No configurado (17ª vez documentado) |
| Launchd plist instalado | ❌ No (5+ meses consecutivos) |

---

## FIX INMEDIATO — SessionStart hook (< 1 minuto en el Mac)

**Una acción, un minuto, resuelve el detached HEAD para siempre.**

Editar `~/.second-brain/.claude/settings.json` (o `~/second-brain/.claude/settings.json`):

**Estado actual:**
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

**Debe quedar:**
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

---

## Lo que sigue sin poder inspeccionarse (wiki inaccesible desde la nube)

Todos estos checks requieren `wiki/`, `raw/` y `.state/` — solo presentes en el Mac/Pi:

- Número real de artículos en el wiki
- Artículos huérfanos (ningún `[[wikilink]]` apunta a ellos)
- Wikilinks rotos (apuntan a artículos inexistentes)
- Artículos sin fuentes (`sources:` vacío en frontmatter)
- Contradicciones entre artículos del mismo dominio
- Items pendientes de compilar

---

## Health check real desde el Mac

Para el health check completo:

```bash
cd ~/second-brain && node bin/health-check.mjs --push --telegram
```

---

## Recomendaciones — priorizadas por impacto

### 🔴 CRÍTICO #1: Aplicar el fix del SessionStart hook (< 1 min — ver arriba)

17 semanas / 21 sesiones detectando el mismo detached HEAD. El diff exacto está incluido arriba. Esta es la única acción con ROI permanente.

### 🔴 CRÍTICO #2: Instalar launchd plist en el Mac

Sin este paso, los health checks reales (artículos huérfanos, wikilinks, contradicciones) nunca ejecutan de forma autónoma. Las instrucciones completas están en `outputs/2026-11-01-health-check.md`.

### 🟢 POSITIVO: Sync funcionando con fiabilidad

Cuatro sesiones consecutivas con master, HEAD y origin/master en sincronía al arrancar. El commit huérfano de la sesión anterior ya estaba rescatado. El mecanismo de push es estable.

---

## Riesgo acumulado

| Riesgo | Probabilidad | Impacto | Tendencia |
|---|---|---|---|
| Commits perdidos por GC | Baja | Alto | ↓ Mejoró: 4 pushes consecutivos exitosos |
| Wiki con wikilinks rotos sin detectar | Alta | Medio | → Sin cambios: 5+ meses sin inspección real |
| Artículos huérfanos sin identificar | Alta | Bajo | → Sin cambios |
| HEAD detached al arrancar | Alta | Medio | → Sin cambios: hook no corregido (17 veces) |
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
| 16 | 2026-11-05 | health-check | Detached HEAD rescatado (11ª vez) — 5 commits. Push #16 falló |
| 17 | 2026-11-06 | health-check | Detached HEAD rescatado (12ª vez) — 6 commits. Push #16 no llegó |
| 18 | 2026-11-07 | health-check | Push #17 confirmado ✅. HEAD corregido (13ª vez) |
| 19 | 2026-11-08 | health-check | Push #18 confirmado ✅. 2 sesiones consecutivas. HEAD corregido (14ª vez) |
| — | 2026-11-09 | lint | 3 sesiones consecutivas con push ✅ |
| 20 | 2026-11-15 | health-check | Push #19 ✅ (3 sesiones consecutivas). HEAD corregido (15ª vez) |
| — | 2026-11-16 | lint | Cherry-pick de `7f8a325` bloqueado; huérfano en riesgo |
| **21** | **2026-11-22** | **health-check** | **`7f8a325` ya en master ✅ · 4 pushes consecutivos ✅ · HEAD corregido (17ª vez) · Hook sigue sin corregirse** |

---

## Updated Wiki Articles

| Wiki article | Qué se añadió/corrigió | ¿Insight nuevo? |
|---|---|---|
| — | No hay wiki accesible desde la nube | — |

> El wiki real está en el Mac/Pi y es inaccesible desde este entorno remoto. El feedback loop se completará cuando `bin/health-check.mjs --push` se ejecute localmente.

---

*Generado automáticamente por la rutina mensual de health check · 2026-11-22*  
*21ª ejecución — mismo bloqueador estructural desde julio 2026 (5 meses)*  
*Positivo: 4 sesiones consecutivas con push exitoso — sync estable*  
*Acción pendiente de Hector: aplicar el diff de SessionStart hook (1 minuto, instrucciones completas arriba)*
