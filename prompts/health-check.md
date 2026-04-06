# Prompt: Health Check del Second Brain

Ejecuta un health check completo del segundo cerebro de Hector.

## Tu tarea

1. Lee `INDEX.md` y haz Glob de `wiki/*.md` y `raw/**/*.md`
2. Analiza el estado de la wiki en las siguientes dimensiones:

### Integridad estructural
- ¿Cuántos artículos hay en wiki/?
- ¿Cuántos items en `.state/pending.json`?
- ¿Cuándo fue la última compilación?

### Artículos huérfanos
- Artículos en wiki/ que NO aparecen referenciados como `[[wikilink]]` en ningún otro artículo
- Listar por nombre

### Broken links
- `[[wikilinks]]` que aparecen en artículos pero NO tienen un fichero correspondiente en wiki/
- Estas son oportunidades para crear nuevos artículos

### Artículos sin fuente
- Artículos cuyo frontmatter tiene `sources: []` o no tiene campo `sources`

### Posibles contradicciones
- Artículos sobre temas similares que podrían tener información inconsistente
- Sugerir cuáles revisar manualmente

### Artículos obsoletos
- Artículos no actualizados en más de 90 días (revisar campo `updated:` del frontmatter)

### Nuevos artículos candidatos
- Basándose en los broken links y temas frecuentemente mencionados, sugerir 3-5 nuevos artículos a crear

## Output

Guarda el informe en `outputs/YYYY-MM-DD-health-check.md` con el formato estándar de outputs
definido en CLAUDE.md. Incluye métricas concretas y listas accionables.

Al final, da una puntuación de salud del 1 al 10 con justificación.
