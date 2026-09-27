---
query: "Monthly health check"
date: 2026-09-27
type: health-check
status: blocked
previous: outputs/2026-07-01-health-check.md
---

# Health Check Mensual — 2026-09-27

> **Estado: BLOQUEADO — mismo problema estructural que en julio. Las recomendaciones no fueron implementadas.**

---

## Resumen ejecutivo

El entorno remoto de Claude Code on the web **no puede acceder al contenido del wiki**.
Las carpetas `wiki/`, `raw/` y `.state/` están gitignoreadas y no se sincronizan al repo.
El servidor del wiki en `http://second-brain:4321` tampoco es accesible desde la nube
(DNS no resuelve `second-brain`).

Resultado: **0 artículos inspeccionados**, idéntico al health check de julio.

---

## Diagnóstico de la sesión

| Check | Resultado |
|---|---|
| wiki/ en el repo | ❌ No existe (gitignored) |
| .state/pending.json | ❌ No existe (gitignored) |
| http://second-brain:4321 | ❌ Host no resolvible desde la nube |
| bin/status.mjs | ⚠️ Reporta `0 articles \| compiled never` |
| bin/gap-detect.mjs | ⚠️ `No wiki directory found. Compile first.` |
| Commits desde julio | 1 commit (solo el anterior health check) |

---

## Cambios en el código desde julio (sí visibles)

El repositorio muestra actividad de desarrollo activa entre junio y julio de 2026,
pero **ningún cambio posterior** que resuelva el acceso remoto:

| Commit | Descripción |
|---|---|
| `b45d9b5` | chore: monthly health check report 2026-07-01 |
| `32a629e` | Allow npm run * commands without permission prompts |
| `efdc123` | docs: X sync cron Mac → Pi |
| `1491538` | fix(x): syntax error en página X |
| `0696342` | fix(x): hide Sync button en Pi; cron diario Mac |
| `31dd8c8` | feat(pending): expand full file content |
| `353c82f` | fix(compile): compile-lite con llm_backend config |

Las opciones recomendadas en julio (endpoint `/api/health`, snapshot en repo,
o mover el cron al Mac/Pi) **no fueron implementadas**.

---

## Opciones de solución (reiteradas con prioridad)

### 🥇 Opción A — Mover el health check al Mac o la Pi (recomendada, ~30 min)

El cron ya existe para otras tareas (`sync-x-and-pi.sh`). Añadir una entrada launchd/crontab:

```bash
# En el Mac (launchd) o la Pi (cron):
node /path/to/second-brain/bin/gap-detect.mjs
```

Ejemplo de plist para Mac (similar a `com.zeneke.second-brain-sync-x.plist`):

```xml
<key>ProgramArguments</key>
<array>
  <string>/usr/local/bin/node</string>
  <string>/path/to/second-brain/bin/gap-detect.mjs</string>
</array>
```

**Por qué es la mejor**: acceso completo, cero coste de infraestructura, consistente
con el patrón existente. El informe se escribe en `outputs/` y luego `sync-pi.mjs`
lo sube al Pi.

---

### 🥈 Opción B — Endpoint `/api/health` en el wiki-server (~1-2 horas)

Añadir en `bin/wiki-server.mjs` una ruta autenticada:

```js
server.get('/api/health', async (req, reply) => {
  const { execFileSync } = await import('child_process');
  const report = execFileSync('node', ['bin/gap-detect.mjs', '--json'], { cwd: ROOT });
  reply.send(JSON.parse(report));
});
```

La rutina remota llamaría `http://second-brain:4321/api/health`.
**Problema**: el hostname `second-brain` no es resolvible desde la nube.
Necesitaría una URL pública o un túnel (ngrok, Tailscale).

---

### 🥉 Opción C — Snapshot de estado en el repo

Crear `bin/snapshot.mjs` que serialice a `.state/snapshot.json`
(no gitignoreado) la metadata mínima:

```json
{
  "articles": ["wiki/ai-agents.md", ...],
  "wikilinks": {"ai-agents": ["rag", "llm-architectures"]},
  "sources": {"ai-agents": ["raw/articles/2026-..."]},
  "pendingCount": 3,
  "lastCompile": "2026-09-15"
}
```

La rutina remota leería ese fichero. **Coste**: expone nombres de artículos en el repo público.

---

## Próximos pasos recomendados

1. **Esta semana**: implementar Opción A (launchd en Mac). ~30 min de trabajo.
2. **Si quieres mantener la rutina remota**: añadir Tailscale o un túnel al Pi para que
   la nube pueda alcanzar `second-brain:4321`, y luego implementar Opción B.
3. **Mientras tanto**: el health check remoto seguirá siendo un informe vacío cada mes.

---

## Estado del repositorio (lo que sí es inspeccionable)

| Componente | Estado |
|---|---|
| bin/ (scripts) | ✅ Todos presentes y con sintaxis válida |
| prompts/ | ✅ 6 ficheros (compile, health-check, lint, route, plan-fase1, todo-fase1) |
| bin/gap-detect.mjs | ✅ Listo para ejecutar en local |
| bin/wiki-server.mjs | ✅ Sin /api/health aún |
| outputs/ | ⚠️ Solo contiene este informe y el de julio |
| wiki/, raw/, .state/ | ❌ No disponibles en remoto |
| Compilación | ❌ "compiled never" en remoto |
