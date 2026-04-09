# TODO Fase 1 — RAG Ingestión

## Grupo A: Infraestructura base

- [ ] **T1** — `docker-compose.yml` + `requirements.txt`
- [ ] **T2** — `rag/ingest/extractor.py` (texto nativo + OCR fallback)
- [ ] **T3** — `rag/ingest/chunker.py` (chunking ~500 tokens)
- [ ] **CHECKPOINT A** ✓

## Grupo B: LLM + Vector DB

- [ ] **T4** — `rag/ingest/metadata.py` (Claude Haiku → fechas, personas, tipo_doc)
- [ ] **T5** — `rag/ingest/embedder.py` (OpenAI embeddings → Qdrant upsert)
- [ ] **CHECKPOINT B** ✓

## Grupo C: CLI + Integración

- [ ] **T6** — `bin/rag-ingest.py` (orquestador CLI con aviso privacidad)
- [ ] **T7** — `bin/rag-query.mjs` + update CLAUDE.md (`brain: rag status`)
- [ ] **T8** — `test/fixtures/` + `test/rag-smoke.sh`
- [ ] **CHECKPOINT C** ✓
