# Second Brain

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org)
[![Inspired by Karpathy](https://img.shields.io/badge/inspired%20by-Karpathy-blue)](https://x.com/karpathy/status/1907464197547720858)

**A self-hosted AI that reads what you save, builds your knowledge base overnight, and briefs you every morning. Runs on a $35 Raspberry Pi.**

Save a link from your phone at midnight. Wake up to a wiki article, cross-linked with everything you already know, with a morning briefing waiting in Telegram.

Not a RAG. Not a chatbot with memory. Not a tool you have to open. An autonomous system that compounds your knowledge while you sleep.

---

## How it feels

```
Monday night — you save three articles from your phone via Telegram.
Tuesday 07:00 — Pi compiles them into wiki articles while you sleep.
Tuesday 08:00 — Telegram briefing arrives: what was compiled, what needs review,
                 any tasks due today.
Tuesday morning — you open http://second-brain:4321 from any device.
                  Everything is already there.
```

No laptop open. No command to run. No maintenance.

---

## Quick Start

**Requirements:** [Claude Code CLI](https://claude.ai/code) · Node.js ≥ 20

```bash
git clone https://github.com/ZenekeZene/second-brain.git
cd second-brain
npm install
```

Open Claude Code inside the directory:

```bash
claude
```

Then type in the chat:

```
brain: save https://example.com/interesting-article
```
```
compile the brain
```

That's it. Your first wiki article will be in `wiki/`.

---

## How it works

```
raw/  →  [LLM compiles]  →  wiki/  →  [queries]  →  outputs/
                                            ↓
                                      feedback loop
                                    (new insights flow
                                     back into wiki/)
```

Raw material goes into `raw/`, an LLM compiles it into interconnected articles in `wiki/`,
and queries feed new insights back into the wiki.

---

## Structure

```
second-brain/
├── CLAUDE.md              ← LLM instructions
├── raw/                   ← Unprocessed source material
│   ├── articles/          ← Web articles (extracted markdown)
│   ├── notes/             ← Quick text notes
│   ├── bookmarks/         ← URLs saved for later processing
│   ├── files/             ← PDFs, markdowns, local files
│   ├── images/            ← Photos, screenshots, diagrams
│   └── x-bookmarks/       ← X/Twitter bookmarks (JSONL)
├── wiki/                  ← Articles compiled by the LLM
├── outputs/               ← Queries, briefings, generated analyses
├── prompts/               ← Reusable prompts for common operations
├── .state/                ← Internal state (pending, routing, compile log)
└── bin/                   ← CLI scripts
    ├── ingest.mjs         ← Content ingestion CLI (URL, note, bookmark, file)
    ├── compile.mjs        ← Compilation via Claude Code CLI (Team/Max subscription, $0/compile)
    ├── compile-lite.mjs   ← Compilation via Anthropic API SDK (pay-per-token, ~$0.50/compile)
    ├── wiki-server.mjs    ← Local wiki viewer + web ingest UI + REST API
    ├── route.mjs          ← Incremental routing engine
    ├── search.mjs         ← Wiki search
    ├── status.mjs         ← Brain status reporter
    ├── telegram-bot.mjs   ← Telegram bot (mobile ingestion)
    ├── sync-x.mjs         ← X/Twitter bookmark sync
    ├── journal.mjs        ← Daily journal generator (post-compilation hook)
    └── lib/
        ├── ingest-helpers.mjs       ← Shared ingest logic (used by CLI, bot, and server)
        ├── brain-query.mjs          ← Wiki search + Claude synthesis (used by bot and server)
        ├── debate.mjs               ← Devil's advocate mode (/challenge command)
        ├── embeddings.mjs           ← Semantic search index for wiki articles (OpenAI embeddings + cosine similarity)
        ├── x-embeddings.mjs         ← Semantic search index for X bookmarks (same model, .state/x-embeddings.json)
        ├── xbookmarks.mjs           ← X bookmarks page: loader, embed logic, search UI
        ├── post-compile.mjs             ← Shared post-compile pipeline (pending, log, Telegram, embeddings, journal, sync)
        ├── post-compile-connections.mjs ← Detects new cross-article connections after compilation and logs them
        ├── task-helpers.mjs         ← Task/reminder storage and Haiku-based parsing
        ├── youtube-helpers.mjs      ← YouTube caption extraction (isYouTubeUrl, fetchYouTubeTranscript)
        ├── yt-transcript.py         ← Python helper: transcript via youtube_transcript_api (any language)
        └── autotag.mjs              ← Auto-tagging library
```

---

## Installation

### Prerequisites

| Tool | Install | Why |
|---|---|---|
| [Claude Code CLI](https://claude.ai/code) | `npm install -g @anthropic-ai/claude-code` | LLM engine for conversational mode and `compile.mjs` (Claude Code backend, $0/compile) |
| Node.js ≥ 20 | [nodejs.org](https://nodejs.org) | Runtime |
| Anthropic API key | [console.anthropic.com](https://console.anthropic.com) | Required for `compile-lite.mjs` (API backend, ~$0.50/compile) and connections/journal features |
| OpenAI API key | [platform.openai.com](https://platform.openai.com/api-keys) | Voice transcription (Whisper) + image analysis (GPT-4o Vision) + semantic search embeddings. Used by the Telegram bot, the web ingest UI, and `wiki-server.mjs`. |
| yt-dlp | `brew install yt-dlp` | YouTube caption extraction fallback. Optional — only needed for `brain: video <url>`. |
| youtube-transcript-api | `pip install youtube-transcript-api` | Primary YouTube transcript library. Handles any language (videos in Spanish, French, etc.). Optional — only needed for `brain: video <url>`. |

> **Two compilation backends are available** — you need at least one. See [Compile Backend](#compile-backend) for details and how to switch between them from the wiki UI.

```bash
git clone https://github.com/ZenekeZene/second-brain.git
cd second-brain
npm install
cp .env.example .env   # fill in your keys if using the Telegram bot
```

---

## Usage

### From Claude Code (conversational mode)

Open Claude Code inside this directory:

```bash
cd second-brain && claude
```

`CLAUDE.md` tells the LLM how the system works. The `brain:` prefix is a chat convention —
type it as a regular message to Claude Code. It is **not** a terminal command.

#### Ingest content

```
brain: save https://example.com/interesting-article
brain: video https://www.youtube.com/watch?v=...
brain: note Distributed caches prioritize availability over consistency
brain: bookmark https://paper.ill-read-later.com
brain: file ~/Downloads/document.pdf
brain: image ~/Desktop/architecture-diagram.png
```

#### Compile pending items

```
compile the brain
```

Claude reads all pending items, integrates them into interconnected wiki articles,
and updates `INDEX.md`.

#### Query the wiki

```
brain: what do I know about strength training?
brain: summarize everything I have on AI agents
brain: compare what I know about REST vs GraphQL
```

The response is saved to `outputs/` and new insights are propagated back to the wiki.

#### Maintenance

```
brain: health check    ← finds orphan articles, broken links, contradictions
brain: lint            ← detects duplicates, oversized/undersized articles
```

```bash
npm run gaps           ← detect [[wikilinks]] with no article (knowledge gaps)
```

---

### From the terminal (CLI scripts)

```bash
npm run status                          # Second Brain: 23 articles | 4 pending | compiled 2h ago
node bin/status.mjs --full             # detailed report

npm run ingest -- url "https://..."    # ingest a URL
npm run ingest -- note "Note text"     # ingest a note
npm run ingest -- bookmark "https://…" # save a bookmark
npm run ingest -- file "/path/to.pdf"  # ingest a local file

npm run search -- "machine learning"   # search wiki by content
npm run search -- --tags react         # search by tag
npm run search -- --recent 10          # last 10 modified articles

npm run compile                        # compile via Claude Code CLI (Team/Max subscription, $0)
npm run compile:lite                   # compile via Anthropic API SDK (~$0.50/run, no CLI needed)
npm run compile -- --dry-run           # preview without executing (either backend)

npm run reactive                       # check thresholds and compile if triggered
node bin/reactive.mjs --check          # inspect trigger status without compiling

npm run digest                         # send morning digest to Telegram
node bin/daily-digest.mjs --dry-run   # preview digest without sending

npm run sync-rss                       # sync all RSS/Atom feeds
node bin/sync-rss.mjs --dry-run        # preview new items without ingesting

npm run gaps                           # detect knowledge gaps (missing [[wikilinks]])
node bin/gap-detect.mjs --telegram     # also send top gaps to Telegram

npm run resurface                      # surface articles due for review (spaced repetition)
node bin/resurface.mjs --dry-run       # preview without sending
node bin/resurface.mjs --all           # show all articles with review scores

npm run wiki                           # local wiki viewer at http://localhost:4321
node bin/wiki-server.mjs --port 8080  # custom port

npm run timeline                       # timeline view → opens in browser
node bin/timeline.mjs --no-open        # generate without opening

npm run graph                          # wikilinks graph → opens in browser
node bin/graph.mjs --no-open           # generate without opening
```

---

## Telegram Bot (mobile ingestion)

The bot provides full mobile ingestion via Telegram. Start it with:

```bash
npm run bot
```

Copy `.env.example` to `.env` and fill in your credentials:

```bash
TELEGRAM_BOT_TOKEN=        # from @BotFather
TELEGRAM_ALLOWED_USER_ID=  # your numeric user ID (find via @userinfobot)
OPENAI_API_KEY=            # for voice transcription and image analysis
```

**Query the wiki from your phone:**

| Message | What happens |
|---|---|
| `/ask hexagonal architecture` | Searches wiki, synthesizes answer with Claude |
| `/challenge hexagonal architecture` | Devil's advocate — challenges your own positions on the topic |
| `¿qué sé sobre running?` | Auto-detected as query (starts with `¿`) |
| `? what do I know about AI` | Auto-detected as query (starts with `?`) |
| `how does X work?` | Auto-detected as query |

**`/challenge` — Debate mode:**

Reads your wiki articles on the topic and generates 3-4 strong counterarguments, flags internal contradictions, weak assumptions, and missing perspectives — then closes with 2-3 uncomfortable questions. **Multi-turn**: reply to the bot's message to continue — full conversation history kept in context. Close with `/challenge_end` to extract insights (weakened positions, new angles, wiki update suggestions) into `raw/notes/` for next compilation. Safety nets: morning briefing warns about open debates >24h old; sessions auto-extract on expiry (7-day TTL). Output saved to `outputs/YYYY-MM-DD-debate-<slug>.md`.

**Ingest content:**

| Input | What happens |
|---|---|
| Plain text | Saved as a note to `raw/notes/` |
| URL | Saved as a bookmark to `raw/bookmarks/` |
| Photo | Analyzed with GPT-4o Vision, description saved to `raw/images/` |
| Voice memo (note) | Transcribed with Whisper, saved as a note to `raw/notes/` |
| Voice memo (question) | If the transcription is detected as a question (`¿...?`, `? ...`, `cómo funciona...`), queries the brain instead of saving |
| Document / file | Saved to `raw/files/`; PDFs are text-extracted automatically |
| `brain: save <url>` | Fetched and saved as a full article |
| `brain: note <text>` | Saved as a note |
| `brain: bookmark <url>` | Saved as a bookmark |

**Set reminders — any channel works:**

| Channel | How to use |
|---|---|
| **Telegram (text)** | `Recuérdame revisar el PR mañana a las 10` |
| **Telegram (voice)** | Say "recuérdame…" — Whisper transcribes, Claude Haiku parses the date |
| **Claude CLI** | `brain: remind revisar el PR mañana a las 10` — Claude parses the date and writes the file directly |
| **Terminal** | `node bin/ingest.mjs remind "revisar el PR" --due "2026-04-15T10:00"` |

Spanish and English are both supported. Relative times work too: `"en 2 horas"`, `"pasado mañana"`, `"next Friday at 9"`.

**View pending reminders:**

| Channel | Command |
|---|---|
| Telegram | `/tasks` — lists all pending tasks with an inline ✅ button per task to complete them directly from the chat |
| Claude CLI | `brain: tasks` |
| Terminal | `node bin/ingest.mjs tasks` |
| Wiki viewer | [`/tasks`](http://localhost:4321/tasks) — tasks grouped by 🔴 overdue / 🟡 today / 🔵 upcoming, with a "Hecho ✓" button per task |

**Completing tasks:** tasks can only be marked done by the user — via the Telegram inline buttons, the wiki viewer, or the CLI. The reminder cron never auto-completes them; it only sets a `notifiedAt` timestamp so the same reminder is not sent twice.

Reminders are stored in `.state/todos/YYYY-MM-DD.json` (daily JSON files, one per due date). A cron running every 15 minutes (`reminder-check.mjs`) sends the Telegram alert when due and marks `notifiedAt` on the task. Legacy `raw/tasks/*.md` files are preserved but no longer written.

**Bot commands:** `/ask`, `/tasks`, `/status`, `/pending`, `/logs`, `/help`

Single-user security: all messages from unauthorized users are silently rejected.

---

## Reactive Compilation

> **Disabled by default.** Reactive compilation is turned off (`REACTIVE_THRESHOLD_ITEMS=9999`, `REACTIVE_THRESHOLD_HOURS=9999` in `.env`). Compilation only runs via the daily cron at 7 AM. This gives more control and produces better results — the model compiles more content at once instead of small batches.

The reactive system still exists and can be re-enabled. After every ingest the system checks two conditions:

| Condition | Default | Override |
|---|---|---|
| Pending items ≥ N | ~~5 items~~ disabled (9999) | `REACTIVE_THRESHOLD_ITEMS=N` |
| Time since last compile ≥ X hours | ~~48 h~~ disabled (9999) | `REACTIVE_THRESHOLD_HOURS=X` |

To re-enable, remove or lower those values in `.env`.

Check the current trigger status without compiling:

```bash
node bin/reactive.mjs --check
# → Reactive: 3 pending — no trigger (threshold: 9999 items or 9999h)
```

---

## Compile Backend

Second Brain can compile using two different LLM backends. You can switch between them from the wiki UI at any time.

| Backend | Script | Cost | Requirements |
|---|---|---|---|
| **Claude Code** | `compile.mjs` | $0 — covered by Claude Team/Max subscription | `npm install -g @anthropic-ai/claude-code` + `claude login` |
| **API** | `compile-lite.mjs` | ~$0.50/compile (Sonnet 4.6 + prompt caching) | `ANTHROPIC_API_KEY` in `.env` |

Both backends produce identical results: same post-compile pipeline (pending state, compile log, Telegram notification, connection detection, semantic search embeddings, journal entry, Pi sync).

### Switching backends from the UI

The wiki viewer (`npm run wiki`) shows a toggle in the compile bar on the Ingest and Pending pages:

```
[ API ] [ Claude Code ]
```

- **API** is always available if `ANTHROPIC_API_KEY` is set.
- **Claude Code** appears only if the `claude` CLI is installed and authenticated on the machine running `wiki-server.mjs`.
- The selected mode is persisted in `localStorage` — survives page reloads.
- If `claude` is not installed, the Claude Code button is disabled automatically.

Set `COMPILE_BACKEND=api` or `COMPILE_BACKEND=claude` in `.env` to control which backend the Telegram `/compile` command uses (see [Telegram compile commands](#telegram-compile-commands) below). Defaults to `claude` if available, otherwise `api`.

### Live compilation log

When you click Compile, a streaming log panel appears above the compile bar showing output in real time — routing decisions, items being processed, files written, embeddings, journal, and sync. The log persists after compilation so you can review what happened.

If you switch tabs mid-compilation and come back, the button stays in "Compiling..." state and the log catches up automatically (the last 100 lines are buffered server-side). Launching a second compile while one is running returns a 409 error.

### Partial failure handling

If compilation fails mid-way (API error, timeout, OOM), the items already processed are cleared from `pending.json` while unprocessed items are preserved for the next run. The frontend shows "N items kept for retry." — click Compile again to continue where it left off.

### API backend internals

`compile-lite.mjs` groups pending items by their routing target articles and processes each group in a separate API call. Each call receives only the articles relevant to that group in its cache block — minimizing token usage. Articles are re-read from disk between groups so each call sees the output of previous groups.

### Claude Code backend details

`compile.mjs` runs `claude -p --dangerously-skip-permissions`, piping the compiled prompt as stdin. Claude Code reads the wiki and raw files itself (full tool access — Read, Write, WebFetch, Bash). After execution, the script detects which files were written via mtime snapshot diff and runs the shared post-compile pipeline.

**Memory:** ~400 MB RAM (vs ~60 MB for the API backend). Fine for a modern machine; may be tight on a Pi 3B with 1 GB.

**Timeout:** 30 minutes. Large batches (15+ items with WebFetch calls) can take 10-25 minutes.

### Running Claude Code backend on a Raspberry Pi

Claude Code CLI is a Node.js package and runs on ARM Linux (Pi 4 / Pi 5):

```bash
# On the Pi
npm install -g @anthropic-ai/claude-code
claude login   # prints an OAuth URL — open it on any browser to authenticate
```

Add `SKIP_PI_SYNC=true` to the Pi's `.env` to prevent `postCompile` from trying to rsync the wiki back to the Pi's own IP:

```bash
echo 'SKIP_PI_SYNC=true' >> ~/second-brain/.env
```

### Cron on the Pi

Use whichever backend you prefer in the Pi crontab:

```
# API backend (lighter, ~60 MB RAM):
0 7 * * *  cd ~/second-brain && node bin/compile-lite.mjs >> .state/compile.log 2>&1

# Claude Code backend ($0, ~400 MB RAM — Pi 4/5 only):
0 7 * * *  cd ~/second-brain && node bin/compile.mjs >> .state/compile.log 2>&1
```

### Telegram compile commands

`wiki-server.mjs` includes a Telegram long-polling loop that accepts two commands from the authorized user:

| Command | What it does |
|---|---|
| `/compile` | Triggers compilation using the configured backend (`COMPILE_BACKEND` env var) |
| `/status` | Reports whether a compilation is running and how long it has been going |

No public HTTPS endpoint is needed — the server polls Telegram's `getUpdates` API in the background. The bot starts automatically when `TELEGRAM_BOT_TOKEN` is set. When compilation finishes, the normal post-compile Telegram notification is sent.

Configure the backend in `.env`:

```bash
COMPILE_BACKEND=api     # always use the API backend
COMPILE_BACKEND=claude  # always use Claude Code (only if installed)
# omit to auto-detect: claude if available, else api
```

---

## Morning Briefing

Every morning the bot sends a unified Telegram summary with five sections:

1. **Tasks** — overdue (🔴) and due today (🟡). Only shown if there are pending tasks for the day.
2. **Yesterday's compilation** — articles created and updated
3. **Pending items** — count + warning if any bookmarks are >3 days old without processing
4. **Time to revisit** — top 1-2 wiki articles overdue for review (spaced repetition scoring: days × backlinks), updates `review-log.json`
5. **Stale bookmarks** — list of bookmark URLs sitting unprocessed for >3 days

```
Second Brain — Morning Briefing
Tuesday, 8 April

Tareas
🔴 Llamar al médico (vencida: ayer a las 09:00)
🟡 Revisar PR (hoy a las 10:00)

Compilación de ayer
Creados: `ai-agents`, `llm-tools`
Actualizados: `hexagonal-architecture`
3 items procesados

Pendientes
4 items sin compilar
⚠️ 2 bookmarks llevan más de 3 días sin procesar

Tiempo de repasar (5 pendientes)
Hexagonal Architecture
_Patrón que separa la lógica de negocio de la infraestructura..._
[[hexagonal-architecture]] — 12d sin ver · 3 backlinks

Bookmarks sin procesar (>3 días)
• https://martinfowler.com/articles/...
• https://github.com/...
```

**Send manually:**

```bash
npm run digest                        # send now
node bin/daily-digest.mjs --dry-run  # preview without sending
```

**Schedule with system cron (runs at 8:00, one hour after compilation):**

```bash
crontab -e
# Add:
0 8 * * * cd /path/to/second-brain && node bin/daily-digest.mjs >> .state/digest.log 2>&1
```

---

## Graph Visualizer

Interactive d3-force node graph of all `[[wikilinks]]` between articles, similar to Obsidian's graph view.

```bash
npm run graph   # generates HTML + opens in browser
```

Features:
- **Nodes** sized by degree (more connections = larger node)
- **Colors** by first tag — articles with the same tag cluster together naturally
- **Missing articles** shown as small grey nodes (referenced but not yet written)
- **Click a node** → side panel slides open with the full article content, without leaving the graph
- **Wikilinks inside the panel** navigate within the graph (no page reload)
- **Hover** → tooltip with title and tags
- **Drag** nodes freely; **scroll** to zoom; pan by dragging the background
- **Tag filter** — show only articles with a specific tag
- **Hide/show** missing (ghost) nodes
- Also available at `http://localhost:4321/graph` when the wiki viewer is running

> Requires internet connection to load d3 from CDN.

---

## Timeline View

Visualize how your knowledge base evolved over time.

```bash
npm run timeline   # generates HTML + opens in browser
```

The report shows:
- **Activity by month** — stacked bar chart colored by type (article, note, bookmark, image)
- **Topics over time** — Gantt-style bars per tag, from first to last activity; grey = inactive >90 days
- **Drifted topics** — tags you haven't touched in over 90 days
- **Stats** — total items, active months, peak month, top tag

Also available at `http://localhost:4321/timeline` when the wiki viewer is running.

---

## Local Wiki Viewer

A minimal web interface for your wiki — no Obsidian required.

```bash
npm run wiki
# → http://localhost:4321
```

Features:
- Article list in the sidebar, sorted by last updated
- **Semantic search** — type ≥3 chars, wait 400ms → results ranked by meaning (OpenAI embeddings), not just text match. Falls back to text filter if unavailable.
- **X Bookmarks gallery** at `/x` — masonry grid with media embeds, linked tweet previews, article badges, semantic search, and a Sync button
- `[[wikilinks]]` rendered as clickable links — blue if the article exists, red/dashed if missing
- Tags displayed as badges
- **Backlinks** section at the bottom of each article (what other articles link here)
- **Graph view** at `/graph` — interactive node graph with side panel
- **Timeline view** at `/timeline` — activity over time
- **Ingest UI** at `/inbox` — drop-anything web form (see below)
- **Tasks** at `/tasks` — pending reminders grouped by overdue / today / upcoming, with "Hecho ✓" button
- **Journal** at `/wiki/journal/YYYY-MM-DD` — auto-generated daily entries: ingestion activity, compilation results, queries, tasks done, and a Haiku narrative (`npm run wiki` then navigate or open directly)
- Custom port: `node bin/wiki-server.mjs --port 8080` or `WIKI_PORT=8080 npm run wiki`

### Web Ingest UI

The wiki viewer includes a drop-anything ingest page at `http://localhost:4321/inbox` (also at `http://second-brain:4321/inbox` if running on a Pi). The old `/ingest` and `/pending` URLs redirect here automatically.

No need to specify what you're dropping — the type is auto-detected:

| Input | Auto-detected as | Processed with |
|---|---|---|
| URL text | Article | Fetch + Markdown conversion |
| Plain text | Note | Saved to `raw/notes/` |
| Image file / pasted screenshot | Image | GPT-4o Vision description |
| Audio file | Voice | Whisper transcription |
| PDF | PDF | Text extraction + `raw/files/` |
| Any other file | File | Saved to `raw/files/` |

**How to use:**
- **Type or paste** a URL or text in the textarea → click "Add to Brain" or press Cmd+Enter
- **Drag & drop** files onto the card (any type, multiple at once)
- **Paste an image** with Cmd+V (e.g. a screenshot) → queued automatically
- **Browse files** button for the file picker

Items are processed one by one in a queue visible below the form. Each shows its detected type, current status (Pending → Uploading → Saved / Error), and any error message.

> Image and audio processing requires `OPENAI_API_KEY` in `.env`.

---

## Spaced Repetition

The wiki is only useful if you re-read it. `resurface` surfaces articles you haven't reviewed in a while, prioritizing the most connected ones (most backlinks from other articles).

```
Time to revisit your wiki
3 articles due for review

d3-force
Módulo D3 que implementa un integrador numérico de Verlet...
[[d3-force]] — 14d ago · 3 backlinks

hexagonal-architecture
Patrón que separa la lógica de negocio de la infraestructura...
[[hexagonal-architecture]] — 21d ago · 5 backlinks
```

Review state is tracked in `.state/review-log.json`. Articles never surfaced are treated as overdue from their creation date.

```bash
npm run resurface                      # surface overdue articles → sends to Telegram
node bin/resurface.mjs --dry-run       # preview without sending
node bin/resurface.mjs --all           # show all articles with review scores
node bin/resurface.mjs --count 5       # surface 5 articles (default: 3)
node bin/resurface.mjs --days 14       # change review interval (default: 7 days)
```

**Schedule with system cron (every Sunday at 9:00):**

```bash
crontab -e
# Add:
0 9 * * 0 cd /path/to/second-brain && node bin/resurface.mjs >> .state/resurface.log 2>&1
```

---

## RSS / Feed Auto-Ingest

Subscribe to blogs and have new posts ingested automatically.

Edit `feeds.json` at the project root to configure your feeds:

```json
[
  { "url": "https://martinfowler.com/feed.atom", "label": "Martin Fowler" },
  { "url": "http://www.paulgraham.com/rss.html",  "label": "Paul Graham"  }
]
```

Supports RSS 2.0 and Atom 1.0. Incremental by default — already-seen items are tracked in `.state/rss-seen.json` and skipped on subsequent runs.

```bash
npm run sync-rss                       # sync all feeds
node bin/sync-rss.mjs --dry-run        # preview new items without ingesting
node bin/sync-rss.mjs --force          # re-ingest already-seen items
```

**Schedule with system cron (every 6 hours):**

```bash
crontab -e
# Add:
0 */6 * * * cd /path/to/second-brain && node bin/sync-rss.mjs >> .state/rss.log 2>&1
```

New articles are added to `raw/articles/` and queued for compilation. Reactive compilation triggers automatically if the pending threshold is reached.

---

## YouTube Video Ingestion

Ingest any YouTube video as a transcript — conference talks, lectures, podcasts — with a single command.

```bash
brain: video https://www.youtube.com/watch?v=...
# or via CLI:
npm run ingest -- url "https://www.youtube.com/watch?v=..."
```

The Telegram bot and web ingest UI also handle YouTube URLs automatically when a link is pasted.

**How it works:**

1. Metadata (title, channel) fetched via YouTube's public oEmbed API — no auth required
2. Transcript extracted via `youtube_transcript_api` (Python) — handles any language, no impersonation needed
3. Falls back to `yt-dlp --write-auto-sub --skip-download` if the Python library is unavailable
4. Saved to `raw/articles/` with `type: video` frontmatter, then compiled into a wiki article like any other source

**Language support:** Works for videos in any language — English, Spanish, French, etc. The transcript is saved as-is; the LLM handles the content at compilation time.

**Cost:** $0 — uses YouTube's own auto-generated captions. Works for ~90% of tech talks, lectures, and podcasts.

**Requires:** `pip install youtube-transcript-api` (primary) and `brew install yt-dlp` (fallback). Direct Node.js access to the YouTube timedtext API is blocked server-side since 2024.

> If a video has no captions at all, the ingest will fail with a clear error message.

---

## X/Twitter Bookmark Sync

Requires [`fieldtheory`](https://npmjs.com/package/fieldtheory) and Chrome with an active X session.

```bash
npm install -g fieldtheory
npm run sync-x              # incremental sync (new bookmarks only)
npm run sync-x:full         # full history sync
npm run sync-x:classify     # sync with LLM classification
ft search "query"           # direct search without compiling
```

### Bookmark gallery — `/x`

The wiki viewer includes a full-featured gallery at `http://localhost:4321/x`:

- **Masonry grid** — 3-column CSS columns layout; cards adapt to tweet length
- **Media tweets** — lazy-loaded via Twitter's `widgets.js` (public embeds, no login needed); appear as full interactive tweet embeds via `IntersectionObserver`
- **Linked tweet previews** — text tweets that link to another tweet (`x.com/*/status/ID`) show an inline embed of the linked tweet beneath the card text
- **Twitter Article badge** — tweets linking to `x.com/i/article/` get an "Article" badge (articles can't be embedded via widgets.js)
- **Wiki article badge** — if a tweet was used as a source in a wiki article, a badge links directly to that article
- **Semantic search** — powered by OpenAI `text-embedding-3-small`; results ranked by meaning, not substring match. Min score: 0.30 (same threshold as wiki article search). Falls back to `indexOf` if the index hasn't been built yet.
- **Sync button** — triggers `ft sync` from the browser, shows new bookmark count, auto-reloads. Also runs incremental indexing on new bookmarks.
- **Filters** — filter by referenced wiki article; toggle newest/oldest sort

### Building the semantic index

First time (one-time cost ~$0.002 for 2000+ tweets):

```bash
curl -X POST http://localhost:4321/api/x-embed
```

Or from the terminal:

```bash
node -e "
import('./bin/lib/x-embeddings.mjs').then(m =>
  m.buildXIndex('.', process.env.OPENAI_API_KEY).then(console.log)
)"
```

After the first build, the Sync button re-indexes only new bookmarks automatically.

---

## Automation

### SessionStart Hook
When Claude Code opens in this directory, the brain status is displayed automatically.
Configured in `.claude/settings.json`.

### Scheduled Agents

Three agents run automatically via Claude Code's scheduler:

| Agent | Schedule | What it does |
|---|---|---|
| `brain-compile` | Daily at 8:00 | Compiles all pending items into wiki articles |
| `brain-lint` | Mondays at 9:00 | Detects duplicates, oversized/undersized articles, tag inconsistencies |
| `brain-health` | Monthly (first Sunday) | Finds orphan articles, broken links, contradictions, and suggests new article candidates |

To register them:
```bash
/schedule create --cron "0 8 * * *"   --name "brain-compile" --prompt "..."
/schedule create --cron "0 9 * * 1"   --name "brain-lint"    --prompt "..."
/schedule create --cron "0 10 0 1 *"  --name "brain-health"  --prompt "..."
```

---

## Wiki Article Format

Every article follows this structure:

```markdown
---
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources:
  - raw/articles/YYYY-MM-DD-source-name.md
tags: [tag1, tag2]
---

# Article Title

> One-line summary of the core concept.

## Executive Summary
## Key Concepts
## In Depth
## Highlighted Resources
## Connections         ← [[wikilinks]] to related articles
## Sources
```

`[[wikilinks]]` are [Obsidian](https://obsidian.md)-compatible —
point Obsidian at this directory for graph view, backlinks, and search.

---

## The Feedback Loop

Core rule: when a query generates a new insight, **it goes back to the wiki**.

All outputs in `outputs/` include a mandatory table:

| Wiki article | What was added | New insight? |
|---|---|---|
| wiki/name.md | description of the change | yes / no |

If the table is empty without justification, the feedback loop is incomplete.

---

## Stack

| Component | Technology |
|---|---|
| LLM engine — Claude Code backend | [Claude Code CLI](https://claude.ai/code) (`claude -p`) — covered by Team/Max subscription |
| LLM engine — API backend | Anthropic SDK (`@anthropic-ai/sdk`) — pay-per-token, prompt caching enabled |
| Vision / Voice | OpenAI (GPT-4o Vision + Whisper) |
| Mobile bot | Telegraf (Telegram) |
| HTML → Markdown | Turndown |
| PDF extraction | pdf-parse |
| File uploads | busboy (streaming multipart) |
| Wiki viewer | [Obsidian](https://obsidian.md) (optional) or built-in at `localhost:4321` |

**Inspiration**: [Karpathy](https://x.com/karpathy/status/1907464197547720858) · [Carlos Azaustre](https://carlosazaustre.es)

---

## Running on a Raspberry Pi

> Tu segundo cerebro en un servidor del tamaño de una tarjeta de crédito. Captura desde el móvil, compila mientras duermes, consulta desde cualquier dispositivo.

A Raspberry Pi 4 (~$55) runs Second Brain 24/7 at ~2W — cheaper than leaving a laptop on. The wiki compiles every morning without your main machine being on, and Tailscale makes it accessible from anywhere.

See [RASPBERRY.md](RASPBERRY.md) for a complete setup guide — flashing the OS, SSH, PM2, cron jobs, and content sync. Or use the one-command setup:

```bash
# On your Pi (after cloning the repo and setting up .env):
curl -fsSL https://raw.githubusercontent.com/ZenekeZene/second-brain/master/bin/setup-pi.sh | bash
```

---

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned features — daily digest, RSS auto-ingest, spaced repetition, graph visualizer, and more.

## Contributing

Contributions, issues and feature requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
