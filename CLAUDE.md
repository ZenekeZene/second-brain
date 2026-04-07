# Second Brain

Este es el segundo cerebro personal de Hector. Un LLM (tú) ingesta material en bruto y lo compila
en una wiki interconectada de artículos markdown. El usuario es el editor jefe; la IA escribe.

**Regla fundamental**: Nunca borres archivos de `raw/`. Son la fuente de verdad. La wiki puede
regenerarse a partir de `raw/` si fuera necesario.

---

## Estructura

```
raw/         → Material sin procesar (artículos, notas, bookmarks, ficheros, imágenes)
wiki/        → Artículos compilados y mantenidos por el LLM
outputs/     → Resultados de queries, briefings, análisis
prompts/     → Prompts reutilizables para operaciones habituales
.state/      → Estado interno (pending.json, compile-log.json)
bin/         → Scripts CLI
INDEX.md     → Índice maestro de toda la wiki
```

---

## Comandos de ingesta

Cuando el usuario diga cualquiera de estas formas, ejecuta el flujo correspondiente:

### `brain: save <url>` o `brain: artículo <url>`
1. Usa WebFetch para obtener el contenido de la URL
2. Convierte a markdown limpio (elimina nav, footer, sidebar, banners)
3. Genera un slug kebab-case a partir del título
4. Escribe en `raw/articles/YYYY-MM-DD-<slug>.md` con frontmatter:
   ```yaml
   ---
   source: <url>
   title: <título del artículo>
   ingested: <ISO timestamp>
   type: article
   status: pending
   tags: [tag1, tag2, tag3]
   ---
   ```
   Genera 3-5 tags relevantes basados en el contenido. Usa tags consistentes con los existentes en `wiki/`.
5. Añade el item a `.state/pending.json`
6. Confirma: "Guardado en raw/articles/. N items pendientes de compilación."

### `brain: nota <texto>` o `brain: note <texto>`
1. Genera un slug kebab-case a partir del texto (primeras 5-6 palabras)
2. Genera 3-5 tags relevantes basados en el texto. Usa tags consistentes con los existentes en `wiki/`.
3. Escribe en `raw/notes/YYYY-MM-DD-<slug>.md`:
   ```yaml
   ---
   ingested: <ISO timestamp>
   type: note
   status: pending
   tags: [tag1, tag2, tag3]
   ---

   <texto de la nota>
   ```
4. Añade a pending.json
5. Confirma: "Nota guardada. N items pendientes."

### `brain: bookmark <url>` o `brain: guarda <url>`
1. Infiere 2-3 tags a partir de la URL (dominio, path keywords).
2. Añade a `raw/bookmarks/YYYY-MM-DD-bookmarks.md` (un fichero por día, múltiples bookmarks):
   - Si el fichero no existe, créalo con frontmatter incluyendo `tags: [...]`
   - Si ya existe, añade solo la línea del bookmark
   ```markdown
   - [ ] <url> — (procesar)
   ```
3. Añade a pending.json con type: bookmark
4. Confirma: "Bookmark guardado. N items pendientes."

### `brain: file <path>`
1. Lee el fichero desde la ruta indicada
2. Si es PDF: extrae el texto que puedas leer
3. Si es markdown/txt: copia el contenido tal cual
4. Escribe en `raw/files/YYYY-MM-DD-<nombre-original>.md` con frontmatter type: file
5. Añade a pending.json

### `brain: image <path>`
1. Lee la imagen con capacidades de visión
2. Genera una descripción detallada del contenido
3. Escribe en `raw/images/YYYY-MM-DD-<slug>.md`:
   ```yaml
   ---
   source_image: <path original>
   ingested: <ISO timestamp>
   type: image
   status: pending
   ---

   ## Descripción
   <descripción generada por visión>

   ## Contexto
   <!-- El usuario puede añadir contexto aquí antes de compilar -->
   ```
4. Añade a pending.json

### `brain: sync x` o `brain: sync bookmarks`
1. Ejecuta `npm run sync-x` (que llama a `bin/sync-x.mjs`)
2. El script hace `ft sync` para descargar desde X, luego exporta los nuevos a `raw/x-bookmarks/`
3. Confirma cuántos bookmarks nuevos se han añadido y cuántos items hay pendientes.
4. Si el usuario dice `brain: sync x --classify`, ejecuta `npm run sync-x:classify`
   para que Field Theory clasifique los bookmarks con LLM antes de exportarlos.

**Prerequisito**: `npm install -g fieldtheory` y Chrome con sesión de X activa.
**Búsqueda directa**: el usuario puede hacer `ft search "query"` en terminal para buscar
en todos sus bookmarks sin necesidad de compilarlos primero.

---

## Compilación

Cuando el usuario diga "compila", "compila el brain", "procesa los pendientes", o cuando se ejecute
`bin/compile.mjs`:

### Paso 1: Revisar pendientes
Lee `.state/pending.json`. Si no hay items pendientes, informa y termina.

### Paso 2: Routing incremental
Lee `.state/routing.json` si existe (generado por `bin/route.mjs`).
El routing ya indica qué artículos wiki debe tocar cada item pendiente.
- Si hay routing → úsalo directamente, sin leer toda la wiki
- Si no hay routing → lee `INDEX.md` y haz Glob de `wiki/*.md` para orientarte

El routing tiene este formato por item:
```json
{ "path": "raw/...", "routing": { "action": "update|create|both", "articles": ["wiki/..."] } }
```

### Paso 3: Procesar cada item pendiente
Para cada item en pending.json:

**Decide**: ¿encaja en un artículo existente o necesita uno nuevo?
- Si el contenido amplía, corrige o añade a un artículo existente → actualiza ese artículo
- Si es un tema sin cobertura o con entidad propia → crea un nuevo artículo en `wiki/`
- Si es demasiado delgado (una sola frase sin contexto) → déjalo pendiente, puede combinarse con items futuros
- Los bookmarks sin procesar: usa WebFetch para expandirlos antes de compilar

**Items de tipo `x-bookmarks`** (ficheros JSONL en `raw/x-bookmarks/`):
- Lee el fichero línea a línea; cada línea es un JSON de un tweet bookmarkeado
- Campos relevantes: `full_text` o `text` (contenido), `author_handle` o `author` (autor), `id` (ID tweet), `category` y `domain` (si ya están clasificados por `ft classify`)
- Agrupa los bookmarks por tema antes de compilar: no crees un artículo por tweet
- Para tweets con URL externa relevante, usa WebFetch para expandir el contenido
- El artículo wiki resultante debe citar la fuente como `https://x.com/<author>/status/<id>`

**Naming**: Los artículos usan kebab-case. Ejemplos: `ai-agents.md`, `entrenamiento-fuerza.md`, `arquitectura-hexagonal.md`

**Categorías dinámicas**: No hay categorías fijas. El LLM crea los ficheros wiki que necesita según el contenido.
Un artículo sobre cocina va a `wiki/recetas-fermentacion.md`. Uno sobre correr va a `wiki/entrenamiento-running.md`.

### Paso 4: Formato de artículo wiki

Cada artículo wiki DEBE tener esta estructura:

```markdown
---
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources:
  - raw/articles/YYYY-MM-DD-slug.md
tags: [tag1, tag2]
---

# Título del Artículo

> Una frase que resume el concepto principal.

## Resumen ejecutivo

2-3 párrafos que capturan lo esencial. Lo que necesitas saber si solo tienes 2 minutos.

## Conceptos clave

- **Concepto A**: definición concisa
- **Concepto B**: definición concisa

## En profundidad

Secciones con el contenido detallado. Usa subsecciones (###) cuando sea necesario.

## Recursos destacados

- [Título del recurso](fuente) — por qué es relevante y qué aporta
- ...

## Conexiones

- Relacionado con [[otro-articulo]] porque...
- Contrasta con [[articulo-opuesto]]
- Prerequisito: [[articulo-base]]

## Fuentes

- [Título](url) (ingestado YYYY-MM-DD)
```

### Paso 5: Cross-linking
Después de actualizar/crear artículos, repasa las **Conexiones** de cada artículo tocado.
Usa `[[wikilinks]]` estilo Obsidian (solo el nombre del fichero sin extensión ni ruta).
Busca oportunidades de enlazar con otros artículos existentes en la wiki.

### Paso 6: Actualizar INDEX.md
Reconstruye el INDEX.md con:
- Fecha de última compilación
- Conteo de artículos y pendientes
- Lista de artículos por categoría (agrupados manualmente por proximidad temática)
- Lista de los 5 artículos más recientemente actualizados

### Paso 7: Actualizar estado
- En `.state/pending.json`: elimina los items procesados, actualiza `lastCompile`
- En `.state/compile-log.json`: añade una entrada con fecha, items procesados, artículos creados/actualizados

---

## Queries

Cuando el usuario haga una pregunta con "brain: <pregunta>" o "qué sé sobre X" o "busca en el brain":

### Flujo
1. Usa Grep en `wiki/` para encontrar artículos relevantes al tema
2. Lee INDEX.md para orientación general
3. Lee los artículos más relevantes (máximo 5-7 para no saturar el contexto)
4. Sintetiza una respuesta que cite los artículos con `[[wikilinks]]`
5. Guarda el output en `outputs/YYYY-MM-DD-<slug>.md` con esta cabecera:

```markdown
---
query: "<pregunta original>"
date: YYYY-MM-DD
sources: [articulo1, articulo2]
type: query-response
---

# <Título descriptivo>

> **Solicitado por:** Hector
> **Fecha:** YYYY-MM-DD
> **Fuentes usadas:** [[articulo1]], [[articulo2]]

---

## Resumen ejecutivo

<!-- 2-3 líneas con el hallazgo principal -->

---

## Respuesta

<!-- Respuesta completa -->

---

## Artículos wiki actualizados

<!-- OBLIGATORIO: listar qué se propagó de vuelta a la wiki -->
<!-- Si no se actualizó nada, explicar por qué -->

| Artículo wiki | Qué se añadió/corrigió | ¿Insight nuevo? |
|---|---|---|
| wiki/nombre.md | descripción | sí / no |

> Si esta sección está vacía sin justificación, el feedback loop no se completó.

---

## Ideas derivadas

<!-- Conexiones nuevas, preguntas que surgen, gaps detectados -->
```

### Feedback loop (obligatorio)
Si la respuesta sintetizada revela conexiones, patrones o insights que **no están en ningún artículo wiki**:
- Propaga esos insights de vuelta a los artículos relevantes
- O crea un nuevo artículo si el insight tiene entidad propia
- Registra qué se actualizó en la tabla "Artículos wiki actualizados"

---

## Health Check

Cuando el usuario diga "brain: health check" o se ejecute desde cron:

1. Contar artículos en wiki/, items en pending.json
2. Buscar **artículos huérfanos**: artículos que no tienen ningún `[[wikilink]]` apuntando a ellos
3. Buscar **artículos sin fuente**: artículos donde `sources:` está vacío
4. Buscar posibles **contradicciones**: artículos sobre el mismo tema con información inconsistente
5. Identificar **temas mencionados** en `[[wikilinks]]` que no tienen artículo propio (broken links)
6. Sugerir **nuevos artículos candidatos** basándose en los temas más referenciados sin artículo
7. Guardar el informe en `outputs/YYYY-MM-DD-health-check.md`

---

## Linting semanal

Cuando el usuario diga "brain: lint" o se ejecute desde cron:

1. Detectar artículos duplicados o solapados (mismo tema, diferentes nombres)
2. Identificar artículos demasiado largos (>500 líneas) que deberían dividirse
3. Detectar artículos demasiado cortos (<20 líneas) que deberían fusionarse
4. Revisar si las categorías del INDEX.md están bien balanceadas
5. Guardar el informe en `outputs/YYYY-MM-DD-lint.md`

---

## Boundaries

### Always (siempre hacer)
- Mantener INDEX.md actualizado tras cada compilación
- Citar fuentes en los artículos wiki con enlaces a raw/
- Usar `[[wikilinks]]` para enlaces internos (compatibilidad Obsidian)
- Usar kebab-case para nombres de ficheros
- Actualizar el campo `updated:` del frontmatter al modificar un artículo
- Completar el feedback loop en cada query (tabla "Artículos wiki actualizados")

### Ask first (preguntar antes)
- Fusionar dos artículos existentes
- Renombrar un artículo (rompe wikilinks existentes)
- Crear una nueva categoría de alto nivel que reorganice la wiki
- Eliminar contenido de un artículo (no solo actualizar)

### Never (nunca hacer)
- Borrar ficheros de `raw/`
- Editar wiki/ sin actualizar INDEX.md
- Crear artículos wiki sin frontmatter completo
- Dejar el campo "Artículos wiki actualizados" vacío sin justificación
- Inventar fuentes o citar URLs que no existen en raw/
