---
query: "Monthly health check"
date: 2026-07-01
type: health-check
status: blocked
---

# Health Check Mensual — 2026-07-01

> **Estado: BLOQUEADO — el entorno remoto no tiene acceso al contenido del wiki.**

---

## Problema estructural detectado

La rutina de health check está configurada para ejecutarse en el entorno cloud de
Claude Code on the web. Sin embargo, **todo el contenido del segundo cerebro está
excluido del repositorio** vía `.gitignore`:

```
raw/
.state/
outputs/
wiki/
INDEX.md
```

Cuando el entorno remoto clona el repo, clona únicamente el código de la aplicación
(bin/, prompts/, package.json…). No hay artículos, ni items pendientes, ni estado que
inspeccionar. El hook de SessionStart lo confirma:

```
Second Brain: 0 articles | compiled never
```

El health check completo (huérfanos, wikilinks rotos, fuentes ausentes, contradicciones)
**no puede ejecutarse aquí**. Necesita acceso directo a `wiki/` y `.state/`.

---

## Opciones para arreglarlo (por orden de esfuerzo)

### Opción A — Ejecutar el health check localmente en el Mac o la Pi ✅ recomendada

Añadir una entrada en `crontab` (Pi) o `launchd` (Mac) que ejecute directamente:

```bash
node bin/gap-detect.mjs > outputs/$(date +%F)-health-check.md
```

Equivalente al patrón que ya existe para `sync-x-and-pi.sh`.

**Ventaja**: acceso completo a wiki/ y .state/. Sin cambios en la arquitectura.

### Opción B — Exponer un endpoint de health en el servidor wiki

En `bin/wiki-server.mjs`, añadir una ruta `/api/health` que ejecute los checks
y devuelva un JSON con el resultado. La rutina remota llamaría ese endpoint via WebFetch.

**Ventaja**: la rutina remota puede seguir siendo remota.
**Coste**: implementar el endpoint en el servidor.

### Opción C — Publicar un snapshot de estado en el repo

Crear un script que serialice el estado mínimo necesario para el health check
(lista de artículos, wikilinks, fuentes) a un fichero no gitignoreado, por ejemplo
`.state/snapshot.json`, y que el cron local lo suba al repo.
La rutina remota leería ese snapshot.

**Coste**: mayor complejidad; hay que decidir qué datos del wiki son aceptables
exponer en un repo público.

---

## Estado actual del repositorio (lo que sí es visible)

| Aspecto | Estado |
|---|---|
| Código de aplicación | OK — sin errores detectados |
| .claude/settings.json | OK — Hook SessionStart activo |
| bin/gap-detect.mjs | OK — listo para ejecutar localmente |
| bin/status.mjs | OK — reporta 0 artículos en remoto |
| wiki/, raw/, .state/ | NO DISPONIBLE — gitignored |
| Compilación | NO DISPONIBLE — "compiled never" en remoto |

---

## Acción recomendada

Mueve el cron del health check al Mac o a la Pi, donde el contenido existe.
Si prefieres mantener la rutina remota, implementa la Opción B (endpoint /api/health).

Hasta que se resuelva, este informe se genera automáticamente pero queda vacío de datos reales.
