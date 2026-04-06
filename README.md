# 🧠 Second Brain

Wiki personal mantenida por IA al estilo [Karpathy](https://x.com/karpathy/status/1907464197547720858).
El material en bruto entra en `raw/`, un LLM lo compila en artículos interconectados en `wiki/`,
y las consultas retroalimentan la wiki. Tú eres el editor jefe. La IA escribe.

---

## Concepto

```
raw/  →  [LLM compila]  →  wiki/  →  [queries]  →  outputs/
                                           ↓
                                    feedback loop
                                    (insights nuevos
                                     vuelven a wiki/)
```

No es un RAG ni un chatbot con memoria. Es una Wikipedia personal que crece con el tiempo,
se corrige sola y aprende de tus propias exploraciones.

---

## Estructura

```
second-brain/
├── CLAUDE.md              ← Instrucciones para el LLM (no tocar)
├── INDEX.md               ← Índice maestro de la wiki (mantenido por LLM)
├── raw/                   ← Material sin procesar
│   ├── articles/          ← Artículos web (markdown extraído)
│   ├── notes/             ← Notas rápidas de texto
│   ├── bookmarks/         ← URLs guardadas para procesar después
│   ├── files/             ← PDFs, markdowns, ficheros locales
│   ├── images/            ← Fotos del móvil, capturas, diagramas
│   └── x-bookmarks/       ← Bookmarks de X/Twitter (JSON)
├── wiki/                  ← Artículos compilados por el LLM
├── outputs/               ← Queries, briefings, análisis generados
├── prompts/               ← Prompts reutilizables para operaciones habituales
├── .state/
│   ├── pending.json       ← Items pendientes de compilación
│   └── compile-log.json   ← Historial de compilaciones
└── bin/                   ← Scripts CLI
    ├── ingest.mjs
    ├── compile.mjs
    ├── search.mjs
    └── status.mjs
```

---

## Instalación

```bash
git clone <repo>
cd second-brain
npm install
```

Requisito: [Claude Code CLI](https://claude.ai/code) instalado (`claude --version`).

---

## Uso

### Desde Claude Code (modo conversacional)

Abre Claude Code dentro de este directorio. El `CLAUDE.md` le explica al LLM cómo operar.

#### Ingestar contenido

```
brain: save https://example.com/articulo-interesante
brain: nota Los sistemas de cache distribuida priorizan disponibilidad sobre consistencia
brain: bookmark https://paper.que-leeré-luego.com
brain: file ~/Downloads/documento.pdf
brain: image ~/Desktop/diagrama-arquitectura.png
```

#### Compilar pendientes

Cuando hayas acumulado material en `raw/`, dile al LLM que lo compile:

```
compila el brain
```

El LLM leerá todos los items pendientes, los integrará en artículos wiki interconectados
y actualizará el `INDEX.md`.

#### Consultar la wiki

```
brain: qué sé sobre entrenamiento de fuerza?
brain: resúmeme todo lo que tengo sobre AI agents
brain: compara lo que sé de REST vs GraphQL
```

La respuesta se guarda en `outputs/` y los insights nuevos se propagan de vuelta a la wiki.

#### Health check y linting

```
brain: health check
brain: lint
```

---

### Desde la terminal (scripts CLI)

#### `npm run status`
Estado rápido del cerebro:
```
🧠 Second Brain: 23 artículos | ⏳ 4 pendientes | compilado hace 2h
```

Con más detalle:
```bash
node bin/status.mjs --full
```

#### `npm run ingest`
Ingestar contenido sin abrir Claude Code:
```bash
npm run ingest -- url "https://example.com/post"
npm run ingest -- note "Texto de la nota"
npm run ingest -- bookmark "https://url.com"
npm run ingest -- file "/ruta/al/fichero.pdf"
```

#### `npm run search`
Buscar en la wiki:
```bash
npm run search -- "machine learning"
npm run search -- --tags react
npm run search -- --recent 10
```

#### `npm run compile`
Lanzar compilación desde terminal:
```bash
npm run compile                  # compila todos los pendientes
npm run compile -- --dry-run     # muestra qué compilaría sin ejecutar
```

---

## Automatización

### Hook SessionStart
Al abrir Claude Code en este directorio, aparece automáticamente el estado del cerebro.
Configurado en `.claude/settings.json`.

### Schedules (compilación y mantenimiento automáticos)

Con el comando `/schedule` de Claude Code puedes configurar agentes recurrentes:

**Compilación diaria** (cada mañana a las 8:00):
```
/schedule create --cron "0 8 * * *" --name "brain-compile" \
  --prompt "Lee /Users/hector/Projects/second-brain/.state/pending.json. Si hay items pendientes, compílalos siguiendo las instrucciones de CLAUDE.md."
```

**Linting semanal** (lunes a las 9:00):
```
/schedule create --cron "0 9 * * 1" --name "brain-lint" \
  --prompt "Ejecuta el linting semanal del second brain siguiendo prompts/lint.md."
```

**Health check mensual** (primer domingo de cada mes):
```
/schedule create --cron "0 10 0 1 *" --name "brain-health" \
  --prompt "Ejecuta el health check del second brain siguiendo prompts/health-check.md."
```

---

## Artículos wiki

Cada artículo sigue este formato:

```markdown
---
created: 2026-04-06
updated: 2026-04-06
sources:
  - raw/articles/2026-04-06-nombre-fuente.md
tags: [tag1, tag2]
---

# Título del Artículo

> Frase resumen de una línea.

## Resumen ejecutivo
## Conceptos clave
## En profundidad
## Recursos destacados
## Conexiones         ← [[wikilinks]] a artículos relacionados
## Fuentes
```

Los `[[wikilinks]]` son compatibles con [Obsidian](https://obsidian.md) —
apunta Obsidian a este directorio para navegar la wiki con graph view, backlinks y búsqueda.

---

## El feedback loop

Regla fundamental: cuando una query genera un insight nuevo, **vuelve a la wiki**.

Todos los outputs en `outputs/` incluyen una tabla obligatoria:

| Artículo wiki | Qué se añadió | ¿Insight nuevo? |
|---|---|---|
| wiki/nombre.md | descripción del cambio | sí / no |

Si la tabla está vacía sin justificación, el feedback loop no se completó.

---

## Fuera de scope (v2)

- Sincronización automática de bookmarks de X (requiere API key)
- Scraping de LinkedIn
- Input móvil via Telegram (notas de voz, fotos)
- Búsqueda semántica
- Exportación a Marp (slides)

---

## Stack

- **LLM**: [Claude Code](https://claude.ai/code) (claude-sonnet / opus)
- **Runtime**: Node.js 24+ (ESM)
- **Dependencias**: `turndown` (HTML → Markdown)
- **Viewer**: [Obsidian](https://obsidian.md) (opcional) o cualquier editor markdown
- **Inspiración**: [Karpathy](https://x.com/karpathy/status/1907464197547720858) · [Carlos Azaustre](https://carlosazaustre.es)
