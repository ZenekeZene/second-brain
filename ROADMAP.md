# Roadmap

Planned improvements grouped by impact and complexity. Contributions and ideas welcome — open an issue to discuss.

---

## Done

| Feature | Description |
|---------|-------------|
| **Auto-tagging on ingest** | A lightweight LLM assigns tags automatically at ingest time, improving routing quality. |
| **Reactive compilation** | Compiles automatically when N items are pending (default: 5) or X hours pass since last compile (default: 48h). Covers CLI, Telegram bot, and conversational ingestion. |
| **Daily digest via Telegram** | Every morning the bot sends a summary: what was compiled yesterday, pending count, and a random wiki article to revisit. Schedule with system cron at 8:00. |
| **RSS / feed auto-ingest** | Subscribe to blogs (Martin Fowler, Paul Graham, etc.) via RSS 2.0 and Atom 1.0. New posts are ingested automatically, tracked in rss-seen.json to avoid duplicates. Schedule with cron every 6 hours. |
| **Automatic knowledge gap detection** | Scans all [[wikilinks]] across wiki articles, detects references to non-existent articles, and ranks missing topics by frequency. Output to console, outputs/ report, and optional Telegram notification. |
| **Spaced repetition / resurfacing** | Surfaces overdue articles via Telegram, prioritizing the most connected ones (most backlinks). Score = days_since × (1 + backlinks × 0.4). Tracks review state in review-log.json. |
| **Local wiki web viewer** | Minimal Node http server — article list, live search, clickable [[wikilinks]] (blue=exists, red=missing), tags, backlinks section. No Obsidian needed. `npm run wiki` → localhost:4321. |
| **Timeline view** | Self-contained HTML report with monthly activity bar chart (stacked by type), per-tag Gantt chart (first→last activity, grey=inactive >90d), drifted topics table, and stats. Also at /timeline in the wiki viewer. |
| **Graph visualizer** | Interactive d3-force node graph of [[wikilinks]]. Nodes sized by degree, colored by tag, missing articles as grey ghosts. Click=panel, drag, zoom, tag filter. Also at /graph in wiki viewer. |

---

## High Impact, Low Complexity

| Feature | Description |
|---------|-------------|
~~| **Daily digest via Telegram** | Every morning the bot sends a summary: what was compiled yesterday, what's pending, and a random wiki article to revisit ("today you could re-read [[ia-llms-2026]]"). |~~
~~| **RSS / feed auto-ingest** | Subscribe to blogs (Martin Fowler, Paul Graham, etc.) and have new posts automatically ingested into `raw/articles/`. |~~

---

## High Impact, Medium Complexity

| Feature | Description |
|---------|-------------|
~~| **Spaced repetition / resurfacing** | The wiki is only useful if you re-read it. The bot periodically surfaces articles you haven't reviewed in X days, prioritizing the most connected ones. |~~
~~| **Automatic knowledge gap detection** | Detect topics heavily referenced in `[[wikilinks]]` that have no article yet, and suggest what to ingest to fill the gaps. |~~
~~| **Reactive compilation** | Instead of compiling manually, trigger automatically when N new items arrive or X time has passed since the last compilation. |~~

---

## Medium Impact, Interesting

| Feature | Description |
|---------|-------------|
~~| **Local wiki web viewer** | A minimal Express server that renders the wiki as a navigable website with clickable wikilinks, without depending on Obsidian. |~~
| **Debate mode** | `brain: debate <topic>` generates an output with arguments for and against using only what's in the wiki, identifying where information is missing. |
~~| **Timeline view** | Visualize how topics evolved over time: when you started saving things about AI, peak activity, topics you abandoned. |~~
~~| **Graph visualizer** | Interactive node graph of `[[wikilinks]]` between articles, similar to Obsidian's graph view. Candidate implementation: [d3-force](wiki/d3-force.md). |~~
