# Second Brain

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org)
[![Inspired by Karpathy](https://img.shields.io/badge/inspired%20by-Karpathy-blue)](https://x.com/karpathy/status/1907464197547720858)

**AI-maintained personal wiki.** Ingest URLs, notes, bookmarks, voice memos and images — an LLM compiles them into an interconnected markdown wiki. You are the editor-in-chief. The AI writes.

Not a RAG. Not a chatbot with memory. A personal Wikipedia that grows, self-corrects, and learns from your own explorations.

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
    ├── compile.mjs        ← Compilation via Claude Code CLI (main machine)
    ├── compile-lite.mjs   ← Compilation via Anthropic SDK (Raspberry Pi / low-memory)
    ├── wiki-server.mjs    ← Local wiki viewer + web ingest UI + REST API
    ├── route.mjs          ← Incremental routing engine
    ├── search.mjs         ← Wiki search
    ├── status.mjs         ← Brain status reporter
    ├── telegram-bot.mjs   ← Telegram bot (mobile ingestion)
    ├── sync-x.mjs         ← X/Twitter bookmark sync
    └── lib/
        ├── ingest-helpers.mjs  ← Shared ingest logic (used by CLI, bot, and server)
        ├── brain-query.mjs     ← Wiki search + Claude synthesis (used by bot and server)
        └── autotag.mjs         ← Auto-tagging library
```

---

## Installation

### Prerequisites

| Tool | Install | Why |
|---|---|---|
| [Claude Code CLI](https://claude.ai/code) | `npm install -g @anthropic-ai/claude-code` | LLM engine for conversational mode and `compile.mjs` |
| Node.js ≥ 20 | [nodejs.org](https://nodejs.org) | Runtime |
| Anthropic API key | [console.anthropic.com](https://console.anthropic.com) | Required for `compile-lite.mjs` (and by Claude Code internally) |
| OpenAI API key | [platform.openai.com](https://platform.openai.com/api-keys) | Voice transcription (Whisper) + image analysis (GPT-4o Vision). Used by the Telegram bot and the web ingest UI. |

> **Note:** Claude Code CLI is only needed for conversational mode (`claude` in the terminal).
> `compile-lite.mjs` calls the Anthropic API directly — no CLI required. This is the recommended mode for the Raspberry Pi.

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

npm run compile                        # compile all pending items (requires Claude Code CLI)
npm run compile:lite                   # compile via Anthropic SDK — lighter, no CLI needed
npm run compile -- --dry-run           # preview without executing

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
| `¿qué sé sobre running?` | Auto-detected as query (starts with `¿`) |
| `? what do I know about AI` | Auto-detected as query (starts with `?`) |
| `how does X work?` | Auto-detected as query |

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

**Bot commands:** `/ask`, `/status`, `/pending`, `/logs`, `/help`

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

## Daily Digest

Every morning the bot sends a Telegram summary with:
- What was compiled yesterday (articles created/updated)
- How many items are pending
- A random wiki article to revisit

```
Second Brain — Morning Digest
Tuesday, 8 April

Yesterday's compilation
Created: `ai-agents`, `llm-tools`
Updated: `hexagonal-architecture`
3 items processed

Pending now
2 items waiting to compile

Article of the day
[[d3-force]]
Módulo D3 que implementa un integrador numérico de Verlet...
```

**Send manually:**

```bash
npm run digest                        # send now
node bin/daily-digest.mjs --dry-run  # preview without sending
```

**Schedule with system cron (runs at 8:00 every day):**

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
- Live search (filters as you type, state persisted across navigation)
- `[[wikilinks]]` rendered as clickable links — blue if the article exists, red/dashed if missing
- Tags displayed as badges
- **Backlinks** section at the bottom of each article (what other articles link here)
- **Graph view** at `/graph` — interactive node graph with side panel
- **Timeline view** at `/timeline` — activity over time
- **Ingest UI** at `/ingest` — drop-anything web form (see below)
- Custom port: `node bin/wiki-server.mjs --port 8080` or `WIKI_PORT=8080 npm run wiki`

### Web Ingest UI

The wiki viewer includes a drop-anything ingest page at `http://localhost:4321/ingest` (also at `http://second-brain:4321/ingest` if running on a Pi).

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

## X/Twitter Bookmark Sync

Requires [`fieldtheory`](https://npmjs.com/package/fieldtheory) and Chrome with an active X session.

```bash
npm install -g fieldtheory
npm run sync-x              # incremental sync (new bookmarks only)
npm run sync-x:full         # full history sync
npm run sync-x:classify     # sync with LLM classification
ft search "query"           # direct search without compiling
```

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
| LLM engine (main machine) | [Claude Code](https://claude.ai/code) (`claude -p`) |
| LLM engine (Raspberry Pi) | Anthropic SDK (`@anthropic-ai/sdk`) via `compile-lite.mjs` |
| Vision / Voice | OpenAI (GPT-4o Vision + Whisper) |
| Mobile bot | Telegraf (Telegram) |
| HTML → Markdown | Turndown |
| PDF extraction | pdf-parse |
| File uploads | busboy (streaming multipart) |
| Wiki viewer | [Obsidian](https://obsidian.md) (optional) or built-in at `localhost:4321` |

**Inspiration**: [Karpathy](https://x.com/karpathy/status/1907464197547720858) · [Carlos Azaustre](https://carlosazaustre.es)

---

## Running on a Raspberry Pi

Want to run Second Brain 24/7 on a Raspberry Pi? See [RASPBERRY.md](RASPBERRY.md) for a complete setup guide — flashing the OS, SSH, PM2, cron jobs, and content sync.

---

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned features — daily digest, RSS auto-ingest, spaced repetition, graph visualizer, and more.

## Contributing

Contributions, issues and feature requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
