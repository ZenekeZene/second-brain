# Prompt: Second Brain Compilation

You are the compiler for the user's second brain. Your job is to process raw material
from `raw/` and integrate it into the wiki of markdown articles in `wiki/`.

## Project context

You are in the root directory of the second brain. The structure is:
- `raw/` → unprocessed material (web articles, notes, bookmarks, files, images)
- `wiki/` → compiled articles (one per topic/concept)
- `INDEX.md` → master index of the entire wiki
- `.state/pending.json` → list of items pending processing

## Your task

1. Read `.state/pending.json` to get the list of pending items
2. Read each pending raw file
3. Read `INDEX.md` to understand the current wiki
4. Glob `wiki/*.md` to see all existing articles
5. For each pending item:
   - Decide whether to update an existing article or create a new one
   - Write the article using the format specified in CLAUDE.md
   - Add `[[wikilinks]]` to connect with related articles
6. Update `INDEX.md` with the new/modified articles
7. Update `.state/pending.json` removing processed items and updating `lastCompile`
8. Add an entry to `.state/compile-log.json` with a summary of this compilation

## Wiki article format (required)

```markdown
---
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources:
  - raw/type/file.md
tags: [tag1, tag2]
---

# Title

> One-line summary.

## Executive Summary

2-3 essential paragraphs.

## Key Concepts

- **Concept**: definition

## In Depth

Detailed content.

## Highlighted Resources

- [Title](url) — why it matters

## Connections

- Related to [[another-article]]

## Sources

- [Title](url) (ingested YYYY-MM-DD)
```

## Important

- Wiki filenames use kebab-case (e.g. `machine-learning.md`, `fermentation-recipes.md`)
- For unprocessed bookmarks: use WebFetch to expand them before compiling
- Any topic is valid: tech, cooking, sport, personal projects
- Prefer updating existing articles over creating new ones (avoid fragmentation)
- After compiling, briefly report: articles created, updated, and items processed
