# Plan Fase 1: Pipeline de Ingestión Python + Qdrant Local

## Objetivo

Un usuario ejecuta `python bin/rag-ingest.py ./docs/` y los PDFs quedan indexados en Qdrant local con chunks, metadatos y embeddings. El comando `brain: rag status` muestra cuántos docs/chunks hay.

---

## Grafo de Dependencias

```
docker-compose.yml (Qdrant)
        │
        ▼
requirements.txt
        │
        ▼
rag/ingest/extractor.py          ← sin deps internas
        │
        ▼
rag/ingest/chunker.py            ← depende de extractor.py
        │
        ▼
rag/ingest/metadata.py           ← depende de chunker.py
        │
        ▼
rag/ingest/embedder.py           ← depende de chunker.py + metadata.py + Qdrant
        │
        ▼
bin/rag-ingest.py                ← orquesta extractor → chunker → metadata → embedder
        │
        ▼
bin/rag-query.mjs                ← lee .state/rag-state.json, implementa `brain: rag status`
```

---

## Secuencia de Implementación

```
Tarea 1 (infra)
    ↓
Tarea 2 (extractor)
    ↓
Tarea 3 (chunker)
    ↓
CHECKPOINT A
    ↓
Tarea 4 (metadata)
    ↓
Tarea 5 (embedder)
    ↓
CHECKPOINT B
    ↓
Tarea 6 + 7 (en paralelo)
    ↓
Tarea 8 (smoke tests)
    ↓
CHECKPOINT C
```

---

## Tareas

### TAREA 1 — Infraestructura: Qdrant + dependencias

**Ficheros**: `docker-compose.yml`, `requirements.txt`

**docker-compose.yml**: servicio `qdrant` en puerto 6333, volumen `./qdrant_storage`

**requirements.txt**: `pdfplumber`, `pytesseract`, `Pillow`, `python-docx`, `tiktoken`, `openai`, `qdrant-client`, `anthropic`

**Verificación**:
```bash
docker compose up -d
curl http://localhost:6333/healthz
python -c "import pdfplumber, qdrant_client, openai, anthropic, tiktoken; print('OK')"
```

---

### TAREA 2 — extractor.py: extracción de texto PDF con fallback OCR

**Ficheros**: `rag/ingest/__init__.py`, `rag/ingest/extractor.py`

**Interfaz**:
```python
def extract_pages(pdf_path: str) -> list[dict]:
    # [{"page": 1, "text": "...", "ocr_used": False}, ...]

def needs_ocr(text: str, threshold: int = 50) -> bool:
    # True si len(text.strip()) < threshold
```

**Regla**: si `pdfplumber` extrae <50 caracteres en una página → activar `pytesseract`

**Verificación**:
```bash
python -c "
from rag.ingest.extractor import extract_pages
pages = extract_pages('test/fixtures/native.pdf')
assert all(not p['ocr_used'] for p in pages)
pages_scan = extract_pages('test/fixtures/scanned.pdf')
assert any(p['ocr_used'] for p in pages_scan)
print('extractor OK')
"
```

---

### TAREA 3 — chunker.py: chunking inteligente ~500 tokens

**Ficheros**: `rag/ingest/chunker.py`

**Interfaz**:
```python
def chunk_pages(pages: list[dict], max_tokens: int = 500) -> list[dict]:
    # [{"text": "...", "token_count": 480, "chunk_index": 0, "page": 1, "ocr_used": False}, ...]
```

**Reglas**:
1. Dividir por párrafos (`\n\n`)
2. Acumular párrafos mientras `token_count <= max_tokens`
3. Si un párrafo solo supera `max_tokens`, dividir por oraciones
4. Descartar chunks <20 tokens silenciosamente

**Verificación**:
```bash
python -c "
from rag.ingest.extractor import extract_pages
from rag.ingest.chunker import chunk_pages
chunks = chunk_pages(extract_pages('test/fixtures/native.pdf'))
assert all(c['token_count'] <= 600 for c in chunks)
print(f'chunker OK: {len(chunks)} chunks')
"
```

---

### CHECKPOINT A — Tras Tareas 1-3

- [ ] `curl http://localhost:6333/healthz` responde OK
- [ ] `python -c "import pdfplumber, tiktoken, qdrant_client"` sin error
- [ ] extractor procesa native.pdf sin OCR
- [ ] extractor procesa scanned.pdf con OCR en ≥1 página
- [ ] chunker produce chunks ≤600 tokens con página correcta

---

### TAREA 4 — metadata.py: extracción de metadatos via Claude Haiku

**Ficheros**: `rag/ingest/metadata.py`

**Interfaz**:
```python
def extract_metadata(chunk_text: str, doc_name: str) -> dict:
    # {"fecha_mencionada": ["2024-03-15"], "personas": ["Juan García"], "tipo_doc": "declaración"}

def build_payload(chunk: dict, doc_name: str, metadata: dict) -> dict:
    # Schema completo para Qdrant
```

**Prompt a Claude Haiku**:
```
Extrae del siguiente fragmento:
1. Fechas mencionadas (formato ISO YYYY-MM-DD)
2. Nombres de personas (nombre + apellido cuando sea posible)
3. Tipo de documento: declaración|correo|informe|contrato|otro
Responde SOLO en JSON sin explicación.
Fragmento: {chunk_text}
```

**Si la llamada falla**: devuelve `{"fecha_mencionada": [], "personas": [], "tipo_doc": "otro"}` sin lanzar excepción.

**Verificación**:
```bash
python -c "
from rag.ingest.metadata import extract_metadata
m = extract_metadata('El día 15 de marzo de 2024 Juan García firmó el contrato.', 'test.pdf')
assert '2024-03-15' in m['fecha_mencionada']
assert any('García' in p for p in m['personas'])
print('metadata OK:', m)
"
```

---

### TAREA 5 — embedder.py: embeddings + escritura en Qdrant

**Ficheros**: `rag/ingest/embedder.py`

**Interfaz**:
```python
COLLECTION_NAME = "rag_corpus"
VECTOR_SIZE = 3072  # text-embedding-3-large

def ensure_collection(client: QdrantClient) -> None: ...
def embed_and_upsert(payloads: list[dict], client: QdrantClient, openai_client: OpenAI) -> dict:
    # {"upserted": 450, "errors": 2}
```

**Detalles**:
- Batches de 100 para embeddings
- ID de punto: `uuid5(namespace, f"{doc_origen}::{chunk_index}")` → idempotencia
- Índices de payload en: `doc_origen`, `tipo_doc`, `ocr_used`
- Si Qdrant no disponible → error con "¿está Docker corriendo?"

**Verificación**:
```bash
python -c "
from qdrant_client import QdrantClient
info = QdrantClient('localhost', port=6333).get_collection('rag_corpus')
print('embedder OK: points =', info.points_count)
"
```

---

### CHECKPOINT B — Tras Tareas 4-5

- [ ] metadata extrae fechas y personas correctamente
- [ ] metadata devuelve `tipo_doc` válido siempre
- [ ] embedder crea colección `rag_corpus`
- [ ] embedder hace upsert de ≥1 chunk e idempotente en segunda ejecución

---

### TAREA 6 — bin/rag-ingest.py: CLI de orquestación

**Ficheros**: `bin/rag-ingest.py`, `.state/rag-state.json`

**Interfaz CLI**:
```bash
python bin/rag-ingest.py ./docs/          # directorio
python bin/rag-ingest.py ./file.pdf       # fichero único
python bin/rag-ingest.py ./docs/ --local  # modo offline (Fase 2+, flag reservado)
python bin/rag-ingest.py --help
```

**Flujo**:
1. Validar `OPENAI_API_KEY` y `ANTHROPIC_API_KEY` → error claro si faltan
2. Validar Qdrant disponible → error con ayuda si no
3. Mostrar aviso de privacidad y pedir `[s/n]` (primera vez o si `--force-confirm`)
4. Descubrir PDFs recursivamente
5. Pipeline por cada doc: `extract_pages` → `chunk_pages` → `extract_metadata` (4 workers) → `embed_and_upsert`
6. Si `ocr_pct > 20%` → aviso destacado
7. Actualizar `.state/rag-state.json`
8. Imprimir resumen

**`.state/rag-state.json`**:
```json
{
  "last_ingest": "2024-04-07T10:30:00Z",
  "total_docs": 12,
  "total_chunks": 847,
  "ocr_docs": 3,
  "ocr_pct": 25.0,
  "collection": "rag_corpus"
}
```

---

### TAREA 7 — bin/rag-query.mjs: `brain: rag status`

**Ficheros**: `bin/rag-query.mjs`, actualización menor de `CLAUDE.md`

**Interfaz CLI**:
```bash
node bin/rag-query.mjs status           # "RAG: 12 docs | 847 chunks | 3 con OCR (25%)"
node bin/rag-query.mjs status --full    # lista detallada por doc
node bin/rag-query.mjs --help
```

**Si no existe `.state/rag-state.json`**: "RAG corpus not initialized. Run: python bin/rag-ingest.py <dir>"

Fuente de datos: `.state/rag-state.json` (no requiere Qdrant corriendo para `status`).

---

### TAREA 8 — Test fixtures + smoke test

**Ficheros**: `test/fixtures/native.pdf`, `test/fixtures/scanned.pdf`, `test/rag-smoke.sh`

- `native.pdf`: PDF con texto nativo ≥2 páginas
- `scanned.pdf`: PDF escaneado o generado con Pillow (imagen de texto)
- `rag-smoke.sh`: ejecuta verificaciones de todas las tareas, usa `QDRANT_COLLECTION=rag_test`

**Verificación**:
```bash
bash test/rag-smoke.sh  # exit 0, sin líneas FAIL
```

---

### CHECKPOINT C — Integración completa

- [ ] `python bin/rag-ingest.py test/fixtures/` completa sin error
- [ ] `.state/rag-state.json` con `total_docs ≥ 2`, `total_chunks ≥ 1`
- [ ] `node bin/rag-query.mjs status` muestra números coherentes
- [ ] `node bin/rag-query.mjs status --full` lista docs ingestados
- [ ] Aviso privacidad aparece en primera ejecución
- [ ] Aviso OCR >20% aparece cuando corresponde
- [ ] `bash test/rag-smoke.sh` pasa completo

---

## Riesgos y Decisiones

| Riesgo | Decisión |
|--------|----------|
| ~7000 llamadas a Haiku para 700 docs | ThreadPoolExecutor(max_workers=4) + rate limit 5 req/s desde Tarea 4 |
| No hay PDF escaneado disponible | Generar `scanned.pdf` con Pillow en el setup del smoke test |
| `rag-query.mjs` sin dep Qdrant en Node | Usar `.state/rag-state.json` como fuente; flag `--live` para Fase 2 |
| Tests contaminan colección producción | Variable de entorno `QDRANT_COLLECTION=rag_test` en smoke tests |
