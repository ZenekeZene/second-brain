# SPEC: Second Brain RAG Corpus

> Sistema de consulta anti-alucinación sobre corpus documentales masivos (PDFs, docs).
> Diseñado para pasar la prueba: 700 documentos de acoso laboral, preguntas concretas, cero invención de hechos.

---

## 1. Objetivo

Permitir que un usuario ingeste un corpus de documentos (PDFs, .docx, .txt) y haga cualquier tipo de pregunta sobre él, recibiendo respuestas **grounded** — ancladas exclusivamente en el texto de los documentos, con citas exactas `[doc, página]`.

**Usuario objetivo**: Profesional (abogado, ingeniero, investigador) que necesita extraer información precisa de un corpus grande sin riesgo de alucinación.

**Prueba de aceptación final**:
1. Ingestar 700 PDFs de un caso de acoso laboral
2. Responder preguntas concretas con citas exactas — sin inventar ningún hecho
3. Generar un informe redactado descargable en PDF

---

## 2. Comandos CLI

```bash
# Ingestión
brain: rag ingest ./docs/              # Ingesta un directorio completo
brain: rag ingest ./docs/file.pdf      # Ingesta un fichero
brain: rag status                      # Muestra corpus cargado (N docs, N chunks, N embeddings)

# Consulta (también disponible vía web)
brain: rag ask "¿Qué pasó el 15 de marzo?"
brain: rag ask "Ordena cronológicamente los hechos de enero a marzo"
brain: rag ask "¿Hay contradicciones sobre el incidente X?"

# Exportar respuesta como PDF
brain: rag ask "Redacta un informe sobre las denuncias de X" --pdf
brain: rag ask "Timeline completo del caso" --pdf

# Gestión
brain: rag reset                       # Vacía el corpus (pide confirmación)
brain: rag list                        # Lista documentos ingestados
```

---

## 3. Modos de Query

El sistema detecta automáticamente el tipo de pregunta y aplica el modo correcto:

| Modo | Cuándo | Output |
|------|--------|--------|
| **CITA** | Pregunta factual exacta | Chunks literales + `[doc, pág]` |
| **INFORME** | Síntesis, redacción, resumen | Texto redactado con fuentes al pie |
| **TIMELINE** | Fechas, cronología, "entre X e Y" | Lista ordenada de hechos con refs |
| **RELACIONAL** | Personas, entidades, "qué dice X sobre Y" | Fragmentos agrupados por entidad |
| **CONTRADICCIÓN** | "¿Hay versiones distintas?", "¿contradice?" | Pares de fragmentos enfrentados |
| **CUANTITATIVA** | Conteos, frecuencias, "cuántos" | Número + fragmentos de muestra |
| **AUSENCIA** | "¿Hay evidencia de X?", "¿Se tomaron medidas?" | Respuesta honesta + búsqueda exhaustiva |
| **DOCUMENTAL** | Metadatos, tipos de doc, firmantes | Resumen del corpus o del documento |
| **PATRÓN** | "¿Hay un patrón?", tendencias | Análisis con citas de soporte |
| **ESTRATÉGICA** | "¿Qué me respalda?", puntos débiles | Análisis con advertencia de limitación |

**Regla anti-alucinación universal**: Si la información no está en los documentos, el sistema responde explícitamente "No encontrado en el corpus". Nunca rellena con conocimiento propio.

---

## 4. Arquitectura y Stack

### Pipeline de ingestión (Python)

```
PDFs / DOCX / TXT
  → extracción de texto (pdfplumber, python-docx)
  → chunking inteligente (~500 tokens, respeta párrafos)
  → extracción de metadatos por chunk via LLM:
      { fecha_mencionada[], personas[], tipo_doc, doc_origen, página }
  → embeddings: OpenAI text-embedding-3-large
  → Qdrant (colección por corpus)
```

### Servidor de query (Node.js)

```
HTTP API / CLI
  → clasificador de intención (Claude Haiku, 1 llamada barata)
  → estrategia de recuperación según modo
  → Qdrant: búsqueda semántica + filtros de metadatos
  → LLM redactor (Claude Sonnet/Opus) con grounding estricto
  → respuesta con citas | PDF export (puppeteer)
```

### Stack completo

| Capa | Tecnología |
|------|-----------|
| Extracción PDF | Python: `pdfplumber`, `python-docx` |
| Embeddings | OpenAI `text-embedding-3-large` |
| Vector DB | Qdrant (local via Docker) |
| LLM clasificador | Claude Haiku (barato, rápido) |
| LLM redactor | Claude Sonnet 3.5 (grounded) |
| Backend API | Node.js + Express |
| Web UI | Node.js + HTML/CSS vanilla o minimal framework |
| PDF export | Puppeteer (Node.js) |
| CLI | Node.js (integrado con bin/ existente) |

---

## 5. Estructura de Ficheros

```
second-brain/
├── bin/
│   ├── rag-ingest.py          # Pipeline ingestión (Python)
│   ├── rag-query.mjs          # CLI query (Node.js)
│   └── rag-server.mjs         # Servidor web (Node.js)
├── rag/
│   ├── ingest/
│   │   ├── extractor.py       # Extracción texto de PDFs/DOCX
│   │   ├── chunker.py         # Chunking inteligente
│   │   ├── metadata.py        # Extracción metadatos via LLM
│   │   └── embedder.py        # Generación embeddings + escritura Qdrant
│   ├── query/
│   │   ├── classifier.mjs     # Clasificador de intención
│   │   ├── retriever.mjs      # Búsqueda en Qdrant
│   │   ├── modes/
│   │   │   ├── citation.mjs   # Modo CITA
│   │   │   ├── report.mjs     # Modo INFORME
│   │   │   ├── timeline.mjs   # Modo TIMELINE
│   │   │   ├── relational.mjs # Modo RELACIONAL
│   │   │   └── ...            # Resto de modos
│   │   └── grounded-prompt.mjs # Prompt anti-alucinación base
│   ├── export/
│   │   └── pdf-generator.mjs  # Exportación PDF via Puppeteer
│   └── web/
│       ├── server.mjs         # Express server
│       ├── public/
│       │   ├── index.html     # UI principal
│       │   └── style.css
│       └── routes/
│           ├── ingest.mjs     # POST /ingest
│           ├── query.mjs      # POST /query
│           └── export.mjs     # POST /export/pdf
├── docker-compose.yml         # Qdrant local
├── requirements.txt           # Deps Python
└── SPEC-RAG.md                # Este fichero
```

---

## 6. Prompt Anti-alucinación Base

Todo modo hereda este contrato:

```
Eres un asistente que SOLO puede afirmar hechos presentes en los fragmentos proporcionados.

REGLAS ABSOLUTAS:
1. Cada afirmación factual debe terminar con su referencia: [nombre_doc, p.N]
2. Si la información no está en los fragmentos: escribe "No encontrado en el corpus."
3. No uses conocimiento propio sobre el caso. Solo los fragmentos.
4. Si los fragmentos son contradictorios, muestra ambas versiones con sus referencias.
5. No inferas ni especules. Si algo es ambiguo, dilo explícitamente.
```

---

## 7. Criterios de Aceptación

### Ingestión
- [ ] Ingesta correcta de PDF con texto nativo (no escaneado)
- [ ] Ingesta correcta de PDF escaneado (OCR fallback via `pytesseract`)
- [ ] Detección automática: si `pdfplumber` no extrae texto, activa OCR
- [ ] Aviso al usuario si >20% de los docs requieren OCR (coste y tiempo aumentan)
- [ ] Chunks con metadatos completos: `{doc, página, fecha[], personas[]}`
- [ ] 700 documentos con texto nativo ingestados en < 30 min
- [ ] 700 documentos escaneados ingestados en < 3 h (OCR es lento)
- [ ] `brain: rag status` muestra conteo correcto y % docs con OCR

### Queries
- [ ] CITA: respuesta incluye texto literal del doc + referencia exacta
- [ ] INFORME: cada párrafo tiene fuentes al pie, ningún hecho inventado
- [ ] TIMELINE: hechos ordenados cronológicamente con referencias
- [ ] RELACIONAL: agrupa fragmentos por persona/entidad con referencias
- [ ] CONTRADICCIÓN: detecta y muestra versiones enfrentadas con sus fuentes
- [ ] CUANTITATIVA: devuelve conteo exacto + fragmentos de muestra con referencias
- [ ] AUSENCIA: si no hay evidencia, lo dice claramente (no inventa)
- [ ] DOCUMENTAL: describe el corpus o un documento concreto desde sus metadatos
- [ ] PATRÓN: sintetiza patrones con citas de soporte, sin especular más allá
- [ ] ESTRATÉGICA: análisis con advertencia explícita de que es interpretación, no hecho

### Anti-alucinación
- [ ] Ninguna respuesta contiene hechos no presentes en los documentos
- [ ] Prueba manual: preguntar sobre algo que NO está en los docs → responde "No encontrado"
- [ ] Prueba manual: comparar cita del sistema con el PDF original → texto idéntico

### Interfaz
- [ ] Web UI: subir docs via drag & drop o selector
- [ ] Web UI: campo de query + selección de modo (o detección automática)
- [ ] Web UI: respuesta con referencias clicables al fragmento
- [ ] PDF export: genera documento descargable para cualquier query
- [ ] CLI funciona sin servidor (modo standalone)

---

## 8. Límites

### Siempre
- Toda respuesta factual lleva cita `[doc, pág]`
- Si no está en el corpus, decirlo explícitamente
- Qdrant corre local por defecto (Docker) — los datos no salen de la máquina
- Antes de la primera ingestión, mostrar este aviso al usuario:

```
⚠️  AVISO DE PRIVACIDAD
El texto de los documentos se envía a la API de OpenAI para generar embeddings.
Los documentos NO se almacenan por OpenAI (política de uso via API), pero el
texto sale de tu máquina. Si el corpus contiene datos sensibles o confidenciales,
usa el modo local (--local) que sustituye OpenAI por nomic-embed-text vía Ollama.
Confirma con [s/n]:
```

- El flag `--local` siempre debe estar disponible como alternativa offline

### Preguntar primero
- Cambiar el modelo LLM (impacta coste y calidad)
- Activar modo online para embeddings en corpus con datos sensibles
- Mergear esta rama a master

### Nunca
- Inventar hechos, fechas, nombres o citas
- Responder sin indicar las fuentes usadas
- Borrar un corpus sin confirmación explícita del usuario

---

## 9. Fases de Implementación

**Fase 1 — Ingestión**: Python pipeline, 10 PDFs de prueba, Qdrant funcionando  
**Fase 2 — Query básica**: Modo CITA y modo INFORME, CLI funcional  
**Fase 3 — Modos avanzados**: TIMELINE, RELACIONAL, CONTRADICCIÓN, AUSENCIA  
**Fase 4 — Web UI**: Upload, query, visualización de referencias  
**Fase 5 — PDF export**: Generación de informes descargables  
**Fase 6 — Prueba de estrés**: 700 documentos reales, validación anti-alucinación  
