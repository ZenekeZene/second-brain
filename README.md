# 🧠 Second Brain

AI-maintained personal wiki. Raw material in, interconnected markdown articles out. Telegram bot, X sync, and scheduled agents for daily compilation, weekly linting, and monthly health checks.

Inspired by [Karpathy](https://x.com/karpathy/status/1907464197547720858).
Raw material goes into `raw/`, an LLM compiles it into interconnected articles in `wiki/`,
and queries feed insights back into the wiki. You are the editor-in-chief. The AI writes.

---

## Concept

```
raw/  →  [LLM compiles]  →  wiki/  →  [queries]  →  outputs/
                                           ↓
                                     feedback loop
                                   (new insights flow
                                    back into wiki/)
```

Not a RAG, not a chatbot with memory. A personal Wikipedia that grows over time,
self-corrects, and learns from your own explorations.

---

## Structure

```
second-brain/
├── CLAUDE.md              ← LLM instructions (do not edit)
├── INDEX.md               ← Master wiki index (maintained by LLM)
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
├── .state/
│   ├── pending.json       ← Items pending compilation
│   ├── routing.json       ← Incremental routing cache
│   └── compile-log.json   ← Compilation history
└── bin/                   ← CLI scripts
    ├── ingest.mjs         ← Content ingestion (URL, note, bookmark, file)
    ├── compile.mjs        ← Compilation orchestrator
    ├── route.mjs          ← Incremental routing engine
    ├── search.mjs         ← Wiki search
    ├── status.mjs         ← Brain status reporter
    ├── telegram-bot.mjs   ← Telegram bot (mobile ingestion)
    ├── sync-x.mjs         ← X/Twitter bookmark sync
    └── lib/
        └── autotag.mjs    ← Auto-tagging library
```

---

## Installation

```bash
git clone <repo>
cd second-brain
npm install
```

Requirements:
- [Claude Code CLI](https://claude.ai/code) installed (`claude --version`)
- Node.js 24+ (ESM)

---

## Usage

### From Claude Code (conversational mode)

Open Claude Code inside this directory (`cd second-brain && claude`).
`CLAUDE.md` tells the LLM how the system works.

The `brain:` prefix is a chat convention — just type it as a regular message
to Claude Code and it knows what to do. It is not a terminal command.

#### Ingest content

Type in the Claude Code chat:

```
brain: save https://example.com/interesting-article
```
```
brain: note Distributed caches prioritize availability over consistency
```
```
brain: bookmark https://paper.ill-read-later.com
```
```
brain: file ~/Downloads/document.pdf
```
```
brain: image ~/Desktop/architecture-diagram.png
```

Claude downloads/reads the content, saves it to `raw/`, and updates `.state/pending.json`.

#### Compile pending items

Once you've accumulated material, type in the chat:

```
compile the brain
```

Claude reads all pending items, integrates them into interconnected wiki articles,
and updates `INDEX.md`.

#### Query the wiki

```
brain: what do I know about strength training?
```
```
brain: summarize everything I have on AI agents
```
```
brain: compare what I know about REST vs GraphQL
```

The response is saved to `outputs/` and new insights are propagated back to the wiki.

#### Health check and linting

```
brain: health check
```
```
brain: lint
```

---

### From the terminal (CLI scripts)

#### `npm run status`
Quick brain status:
```
🧠 Second Brain: 23 articles | ⏳ 4 pending | compiled 2h ago
```

With more detail:
```bash
node bin/status.mjs --full
```

#### `npm run ingest`
Ingest content without opening Claude Code:
```bash
npm run ingest -- url "https://example.com/post"
npm run ingest -- note "Note text here"
npm run ingest -- bookmark "https://url.com"
npm run ingest -- file "/path/to/file.pdf"
```

#### `npm run search`
Search the wiki:
```bash
npm run search -- "machine learning"
npm run search -- --tags react
npm run search -- --recent 10
```

#### `npm run compile`
Launch compilation from the terminal:
```bash
npm run compile                  # compile all pending items
npm run compile -- --dry-run     # preview without executing
```

---

## Telegram Bot (mobile ingestion)

The bot provides full mobile ingestion via Telegram. Start it with:

```bash
npm run bot
```

Required environment variables in `.env`:
```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_ID=...
OPENAI_API_KEY=...
```

**Supported input types:**

| Input | What happens |
|---|---|
| Plain text | Saved as a note to `raw/notes/` |
| URL | Saved as a bookmark to `raw/bookmarks/` |
| Photo | Analyzed with GPT-4o Vision, description saved to `raw/images/` |
| Voice memo | Transcribed with Whisper, saved as a note to `raw/notes/` |
| `brain: save <url>` | Fetched and saved as a full article |
| `brain: nota <text>` | Saved as a note |
| `brain: bookmark <url>` | Saved as a bookmark |

**Bot commands:** `/status`, `/pending`, `/help`

Single-user security: all messages from unauthorized users are silently rejected.

---

## X/Twitter Bookmark Sync

Requires [`fieldtheory`](https://npmjs.com/package/fieldtheory) and Chrome with an active X session.

```bash
npm run sync-x              # incremental sync (new bookmarks only)
npm run sync-x:full         # full history sync
npm run sync-x:classify     # sync with LLM classification
```

Or use direct search without compiling:
```bash
ft search "query"
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

To register them manually:
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
created: 2026-04-06
updated: 2026-04-06
sources:
  - raw/articles/2026-04-06-source-name.md
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
point Obsidian at this directory to browse the wiki with graph view, backlinks, and search.

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
| LLM engine | [Claude Code](https://claude.ai/code) (`claude -p`) |
| Vision / Voice | OpenAI (GPT-4o Vision + Whisper) |
| Mobile bot | Telegraf (Telegram) |
| HTML → Markdown | Turndown |
| Wiki viewer | [Obsidian](https://obsidian.md) (optional) or any markdown editor |

**Inspiration**: [Karpathy](https://x.com/karpathy/status/1907464197547720858) · [Carlos Azaustre](https://carlosazaustre.es)
