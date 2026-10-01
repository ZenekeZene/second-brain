---
query: "Monthly health check"
date: 2026-10-01
type: health-check
status: blocked
previous: outputs/2026-09-27-health-check.md
iteration: 4
---

# Health Check Mensual — 2026-10-01

> **Estado: BLOQUEADO (4ª vez consecutiva)** — El problema estructural documentado en julio no ha sido resuelto. Este informe no puede inspeccionar el wiki desde la nube.

---

## Resumen ejecutivo

Cuatro meses de health checks automáticos, cuatro informes vacíos. El entorno remoto de Claude Code on the web no tiene acceso a `wiki/`, `raw/` ni `.state/` porque están gitignoreadas. El sesgo cognitivo "el informe se genera, todo está bien" puede enmascarar que **el wiki lleva al menos 3 meses sin inspección automatizada**.

**Acción requerida por Hector**: implementar una de las opciones de solución (ver abajo). Sin ello, estas rutinas no sirven de nada.

---

## Diagnóstico de sesión

| Check | Resultado |
|---|---|
| wiki/ en el repo | ❌ No existe (gitignored) |
| .state/pending.json | ❌ No existe (gitignored) |
| http://second-brain:4321 | ❌ Host no resolvible desde la nube |
| bin/gap-detect.mjs | ⚠️ `No wiki directory found. Compile first.` |
| SessionStart hook | ⚠️ `0 articles \| compiled never` |
| Commits desde septiembre | 0 commits de código nuevo |

---

## Historial de bloqueos

| Fecha | Informe | Estado |
|---|---|---|
| 2026-07-01 | health-check | ❌ Bloqueado (1ª vez) |
| 2026-09-27 | health-check | ❌ Bloqueado (2ª vez) |
| 2026-09-28 | lint | ❌ Bloqueado (3ª vez) |
| **2026-10-01** | **health-check** | ❌ **Bloqueado (4ª vez)** |

---

## Soluciones (priorizadas por impacto/esfuerzo)

### 🥇 Opción A — Mover el health check al Mac o la Pi (~30 min) **[RECOMENDADA]**

Es la solución más simple y consistente con la arquitectura actual. Ya tienes el patrón con `com.zeneke.second-brain-sync-x.plist`.

**Pasos concretos:**

1. Crear `bin/health-check.mjs` que ejecute los checks localmente y escriba en `outputs/`:

```js
// bin/health-check.mjs — ejecutar en Mac o Pi donde wiki/ existe
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';

const date = new Date().toISOString().split('T')[0];
const gapOutput = execSync('node bin/gap-detect.mjs').toString();
// ... resto de checks
writeFileSync(`outputs/${date}-health-check.md`, report);
execSync('node bin/sync-pi.mjs');
```

2. Añadir plist en Mac (similar a `com.zeneke.second-brain-sync-x.plist`):

```xml
<!-- ~/Library/LaunchAgents/com.zeneke.second-brain-health.plist -->
<key>StartCalendarInterval</key>
<dict>
  <key>Day</key><integer>1</integer>
  <key>Hour</key><integer>7</integer>
  <key>Minute</key><integer>0</integer>
</dict>
<key>ProgramArguments</key>
<array>
  <string>/usr/local/bin/node</string>
  <string>/path/to/second-brain/bin/health-check.mjs</string>
</array>
```

3. Eliminar la rutina remota de Claude Code on the web (o convertirla en un recordatorio de que el health check debe ejecutarse localmente).

---

### 🥈 Opción B — Endpoint `/api/health` en wiki-server (~2 horas)

Añadir en `bin/wiki-server.mjs` una ruta que ejecute los checks y devuelva JSON.
La rutina remota lo llamaría via WebFetch si el servidor es accesible públicamente
(requiere Tailscale o ngrok además del endpoint).

---

### 🥉 Opción C — Snapshot de estado en el repo (~1 hora)

Script que serialice a `.state/snapshot.json` (no gitignoreado) la metadata mínima
del wiki (lista de artículos, wikilinks, fuentes, pendingCount). La rutina remota
leería ese snapshot. Coste: expone nombres de artículos en el repo.

---

## Lo que sí puede inspeccionarse desde la nube

### Código de la aplicación

| Componente | Estado |
|---|---|
| bin/ (todos los scripts) | ✅ Sin cambios ni errores de sintaxis detectados |
| prompts/ | ✅ 6 ficheros presentes |
| bin/gap-detect.mjs | ✅ Ejecutable, falla solo por ausencia de wiki/ |
| bin/wiki-server.mjs | ✅ Sin endpoint /api/health (pendiente) |
| outputs/ | ⚠️ Solo contiene 3 informes bloqueados |
| wiki/, raw/, .state/ | ❌ No disponibles en remoto |

### Actividad git reciente

Desde el último health check (2026-09-27), **0 commits nuevos de funcionalidad**.
El último commit relevante fue `bce1924` (weekly lint report 2026-09-28).

No hay evidencia en git de que se esté trabajando en ninguna de las opciones de solución.

---

## Próximos pasos accionables

1. **Esta semana**: implementar Opción A. Es ~30 min de trabajo. Usa como plantilla `com.zeneke.second-brain-sync-x.plist`.
2. **Mientras tanto**: ejecutar manualmente `node bin/gap-detect.mjs` desde el Mac o la Pi para obtener un informe real del estado del wiki.
3. **Considerar**: si la rutina remota de health check no puede funcionar estructuralmente, es mejor desactivarla que generar informes vacíos mensualmente que dan falsa sensación de cobertura.

---

*Generado automáticamente por la rutina mensual de health check · 2026-10-01*
