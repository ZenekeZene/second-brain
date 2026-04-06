# Prompt: Linting Semanal del Second Brain

Ejecuta el linting semanal del segundo cerebro de Hector. El objetivo es mantener la wiki
limpia, bien organizada y manejable a medida que crece.

## Tu tarea

1. Lee `INDEX.md` y todos los artículos en `wiki/`
2. Analiza los siguientes aspectos:

### Duplicados y solapamientos
- Artículos con títulos o contenido muy similar que deberían fusionarse
- Ejemplo: `react-hooks.md` y `hooks-de-react.md` son probablemente el mismo tema

### Artículos demasiado largos
- Artículos con más de 400 líneas que deberían dividirse en artículos más específicos
- Sugerir cómo dividirlos y qué nombres darles

### Artículos demasiado cortos
- Artículos con menos de 15 líneas de contenido que deberían fusionarse con otro artículo
- Sugerir dónde integrarlos

### Calidad de wikilinks
- Artículos con pocas o ninguna conexión `[[wikilink]]` (menos de 2)
- Sugerir conexiones que se podrían añadir

### Coherencia de tags
- Tags inconsistentes (ej: `ai`, `AI`, `artificial-intelligence` para el mismo concepto)
- Proponer una normalización

### Balance de categorías
- ¿Hay categorías en INDEX.md con muchos artículos que deberían subdividirse?
- ¿Hay temas sin cobertura que deberían añadirse?

## Output

Guarda el informe en `outputs/YYYY-MM-DD-lint.md`. Sé directo y accionable: para cada
problema encontrado, indica exactamente qué hacer. Prioriza los cambios de mayor impacto.
