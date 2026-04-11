# Second Brain

## Response Style

When presenting URLs (tweets, articles, repos, tools, bookmarks, search results), always format them as clickable markdown links `[label](url)`. Use a table when there are multiple resources.

A personal second brain powered by an LLM. The AI ingests raw material and compiles it
into an interconnected wiki of markdown articles. The user is the editor-in-chief; the AI writes.

**Fundamental rule**: Never delete files from `raw/`. They are the source of truth. The wiki can
be regenerated from `raw/` if necessary.

**Sync rule**: After every wiki write (new article, edit, or compilation), always run `node bin/sync-pi.mjs` automatically — no need to ask. The Pi serves the wiki at http://second-brain:4321 and must stay up to date.

---

## Structure

```
raw/         → Unprocessed material (articles, notes, bookmarks, files, images)
wiki/        → Articles compiled and maintained by the LLM
outputs/     → Query results, briefings, analyses
prompts/     → Reusable prompts for common operations
.state/      → Internal state (pending.json, compile-log.json)
bin/         → CLI scripts
INDEX.md     → Master index of the entire wiki
```

---

## Ingestion Commands

When the user says any of the following, execute the corresponding flow:

### `brain: save <url>` or `brain: article <url>`
1. Use WebFetch to retrieve the content from the URL
2. Convert to clean markdown (remove nav, footer, sidebar, banners)
3. Generate a kebab-case slug from the title
4. Write to `raw/articles/YYYY-MM-DD-<slug>.md` with frontmatter:
   ```yaml
   ---
   source: <url>
   title: <article title>
   ingested: <ISO timestamp>
   type: article
   status: pending
   tags: [tag1, tag2, tag3]
   ---
   ```
   Generate 3-5 relevant tags based on the content. Use tags consistent with those in `wiki/`.
5. Add the item to `.state/pending.json`
6. Run `node bin/reactive.mjs` — reactive compilation is disabled (threshold=9999); cron compiles daily at 7 AM.
7. Confirm: "Saved to raw/articles/. N items pending compilation."

### `brain: note <text>`
1. Generate a kebab-case slug from the text (first 5-6 words)
2. Generate 3-5 relevant tags based on the text. Use tags consistent with those in `wiki/`.
3. Write to `raw/notes/YYYY-MM-DD-<slug>.md`:
   ```yaml
   ---
   ingested: <ISO timestamp>
   type: note
   status: pending
   tags: [tag1, tag2, tag3]
   ---

   <note text>
   ```
4. Add to pending.json
5. Run `node bin/reactive.mjs` — reactive compilation is disabled (threshold=9999); cron compiles daily at 7 AM.
6. Confirm: "Note saved. N items pending."

### `brain: bookmark <url>` or `brain: save <url>`
1. Infer 2-3 tags from the URL (domain, path keywords).
2. Add to `raw/bookmarks/YYYY-MM-DD-bookmarks.md` (one file per day, multiple bookmarks):
   - If the file doesn't exist, create it with frontmatter including `tags: [...]`
   - If it already exists, append only the bookmark line
   ```markdown
   - [ ] <url> — (process)
   ```
3. Add to pending.json with type: bookmark
4. Run `node bin/reactive.mjs` — reactive compilation is disabled (threshold=9999); cron compiles daily at 7 AM.
5. Confirm: "Bookmark saved. N items pending."

### `brain: file <path>`
1. Read the file from the given path
2. If PDF: extract as much text as possible
3. If markdown/txt: copy content as-is
4. Write to `raw/files/YYYY-MM-DD-<original-name>.md` with frontmatter type: file
5. Add to pending.json

### `brain: image <path>`
1. Read the image using vision capabilities
2. Generate a detailed description of the content
3. Write to `raw/images/YYYY-MM-DD-<slug>.md`:
   ```yaml
   ---
   source_image: <original path>
   ingested: <ISO timestamp>
   type: image
   status: pending
   ---

   ## Description
   <vision-generated description>

   ## Context
   <!-- User can add context here before compiling -->
   ```
4. Add to pending.json

### `brain: remind <text>` or `brain: recuérdame <text>`

1. Parse the date and time from the text. You know today's date from context.
   - "mañana a las 10" → tomorrow at 10:00
   - "el viernes a las 9" → next Friday at 09:00
   - "en 2 horas" → current time + 2h
   - "pasado mañana" → day after tomorrow at 09:00
   - If no time given → 09:00
   - If no date given → tomorrow at 09:00
2. Extract the clean task description (strip "recuérdame", "remind me", "brain: remind", etc.)
3. Generate a kebab-case slug from the task text (first 5-6 words)
4. Write to `raw/tasks/YYYY-MM-DD-<slug>.md` where YYYY-MM-DD is the **due date**:
   ```yaml
   ---
   text: "<task description>"
   due: YYYY-MM-DDTHH:MM
   done: false
   created: <current ISO timestamp>
   ---

   <task description>
   ```
5. Confirm: "Recordatorio guardado: «task» — <human readable due date>"

Note: `raw/tasks/` files are NOT added to `pending.json` — they are not wiki content, just reminders. The cron `reminder-check.mjs` handles them independently.

### `brain: tasks` or `brain: recordatorios`

1. Read all files in `raw/tasks/`
2. Filter `done: false`
3. Sort by `due` ascending
4. Display as a table: task | due date | days remaining

### `brain: sync x` or `brain: sync bookmarks`
1. Run `npm run sync-x` (which calls `bin/sync-x.mjs`)
2. The script runs `ft sync` to download from X, then exports new ones to `raw/x-bookmarks/`
3. Confirm how many new bookmarks were added and how many items are pending.
4. If the user says `brain: sync x --classify`, run `npm run sync-x:classify`
   so Field Theory classifies the bookmarks with LLM before exporting them.

**Prerequisite**: `npm install -g fieldtheory` and Chrome with an active X session.
**Direct search**: the user can run `ft search "query"` in the terminal to search
all their bookmarks without needing to compile them first.

---

## Compilation

When the user says "compile", "compile the brain", "process pending items", or when
`bin/compile.mjs` is run:

### Step 1: Review pending items
Read `.state/pending.json`. If there are no pending items, inform the user and stop.

### Step 2: Incremental routing
Read `.state/routing.json` if it exists (generated by `bin/route.mjs`).
The routing already indicates which wiki articles each pending item should affect.
- If routing exists → use it directly, without reading the entire wiki
- If no routing → read `INDEX.md` and Glob `wiki/*.md` for orientation

Routing format per item:
```json
{ "path": "raw/...", "routing": { "action": "update|create|both", "articles": ["wiki/..."] } }
```

### Step 3: Process each pending item
For each item in pending.json:

**Decide**: Does it fit into an existing article or does it need a new one?
- If the content expands, corrects, or adds to an existing article → update that article
- If it's a topic with no coverage or its own identity → create a new article in `wiki/`
- If it's too thin (a single sentence without context) → leave it pending, it may be combined with future items
- Unprocessed bookmarks: use WebFetch to expand them before compiling

**Items of type `x-bookmarks`** (JSONL files in `raw/x-bookmarks/`):
- Read the file line by line; each line is a JSON object of a bookmarked tweet
- Relevant fields: `full_text` or `text` (content), `author_handle` or `author` (author), `id` (tweet ID), `category` and `domain` (if already classified by `ft classify`)
- Group bookmarks by topic before compiling: do not create one article per tweet
- For tweets with a relevant external URL, use WebFetch to expand the content
- The resulting wiki article should cite the source as `https://x.com/<author>/status/<id>`

**Naming**: Articles use kebab-case. Examples: `ai-agents.md`, `strength-training.md`, `hexagonal-architecture.md`

**Dynamic categories**: There are no fixed categories. The LLM creates whatever wiki files the content requires.
An article about cooking goes to `wiki/fermentation-recipes.md`. One about running goes to `wiki/running-training.md`.

### Step 4: Wiki article format

Every wiki article MUST have this structure:

```markdown
---
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources:
  - raw/articles/YYYY-MM-DD-slug.md
tags: [tag1, tag2]
---

# Article Title

> One sentence summarizing the core concept.

## Executive Summary

2-3 paragraphs capturing the essentials. What you need to know if you only have 2 minutes.

## Key Concepts

- **Concept A**: concise definition
- **Concept B**: concise definition

## In Depth

Sections with detailed content. Use subsections (###) when necessary.

## Highlighted Resources

- [Resource title](source) — why it's relevant and what it contributes
- ...

## Connections

- Related to [[another-article]] because...
- Contrasts with [[opposite-article]]
- Prerequisite: [[base-article]]

## Sources

- [Title](url) (ingested YYYY-MM-DD)
```

### Step 5: Cross-linking
After updating/creating articles, review the **Connections** section of each touched article.
Use Obsidian-style `[[wikilinks]]` (filename only, without extension or path).
Look for opportunities to link to other existing articles in the wiki.

### Step 6: Update INDEX.md
Rebuild INDEX.md with:
- Last compilation date
- Article and pending item counts
- List of articles by category (grouped manually by thematic proximity)
- List of the 5 most recently updated articles

### Step 7: Update state
- In `.state/pending.json`: remove processed items, update `lastCompile`
- In `.state/compile-log.json`: add an entry with date, processed items, created/updated articles

---

## Queries

When the user asks a question with "brain: <question>" or "what do I know about X" or "search the brain":

### Flow
1. Use Grep in `wiki/` to find articles relevant to the topic
2. Read INDEX.md for general orientation
3. Read the most relevant articles (maximum 5-7 to avoid saturating context)
4. Synthesize a response citing articles with `[[wikilinks]]`
5. Save the output to `outputs/YYYY-MM-DD-<slug>.md` with this header:

```markdown
---
query: "<original question>"
date: YYYY-MM-DD
sources: [article1, article2]
type: query-response
---

# <Descriptive Title>

> **Requested by:** User
> **Date:** YYYY-MM-DD
> **Sources used:** [[article1]], [[article2]]

---

## Executive Summary

<!-- 2-3 lines with the main finding -->

---

## Response

<!-- Full response -->

---

## Updated Wiki Articles

<!-- MANDATORY: list what was propagated back to the wiki -->
<!-- If nothing was updated, explain why -->

| Wiki article | What was added/corrected | New insight? |
|---|---|---|
| wiki/name.md | description | yes / no |

> If this section is empty without justification, the feedback loop was not completed.

---

## Derived Ideas

<!-- New connections, emerging questions, detected gaps -->
```

### Feedback loop (mandatory)
If the synthesized response reveals connections, patterns or insights **not present in any wiki article**:
- Propagate those insights back to the relevant articles
- Or create a new article if the insight has its own identity
- Record what was updated in the "Updated Wiki Articles" table

---

## Health Check

When the user says "brain: health check" or it runs from cron:

1. Count articles in wiki/, items in pending.json
2. Find **orphan articles**: articles that have no `[[wikilink]]` pointing to them
3. Find **articles without sources**: articles where `sources:` is empty
4. Look for possible **contradictions**: articles on the same topic with inconsistent information
5. Run `node bin/gap-detect.mjs` — it detects all broken `[[wikilinks]]` and ranks missing topics by frequency. Include its output in the health report.
6. Save the report to `outputs/YYYY-MM-DD-health-check.md`

---

## Weekly Linting

When the user says "brain: lint" or it runs from cron:

1. Detect duplicate or overlapping articles (same topic, different names)
2. Identify articles that are too long (>500 lines) and should be split
3. Detect articles that are too short (<20 lines) and should be merged
4. Check whether the INDEX.md categories are well balanced
5. Save the report to `outputs/YYYY-MM-DD-lint.md`

---

## Boundaries

### Always
- Keep INDEX.md updated after each compilation
- Cite sources in wiki articles with links to raw/
- Use `[[wikilinks]]` for internal links (Obsidian compatibility)
- Use kebab-case for file names
- Update the `updated:` frontmatter field when modifying an article
- Complete the feedback loop on every query (the "Updated Wiki Articles" table)

### Ask first
- Merging two existing articles
- Renaming an article (breaks existing wikilinks)
- Creating a new top-level category that reorganizes the wiki
- Deleting content from an article (not just updating)

### Never
- Delete files from `raw/`
- Edit wiki/ without updating INDEX.md
- Create wiki articles without complete frontmatter
- Leave the "Updated Wiki Articles" field empty without justification
- Invent sources or cite URLs that don't exist in raw/
