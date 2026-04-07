# Roadmap

Planned improvements grouped by impact and complexity. Contributions and ideas welcome — open an issue to discuss.

---

## ✅ Done

| Feature | Description |
|---------|-------------|
| **Auto-tagging on ingest** | A lightweight LLM assigns tags automatically at ingest time, improving routing quality. |

---

## 🚀 High Impact, Low Complexity

| Feature | Description |
|---------|-------------|
| **Daily digest via Telegram** | Every morning the bot sends a summary: what was compiled yesterday, what's pending, and a random wiki article to revisit ("today you could re-read [[ia-llms-2026]]"). |
| **RSS / feed auto-ingest** | Subscribe to blogs (Martin Fowler, Paul Graham, etc.) and have new posts automatically ingested into `raw/articles/`. |

---

## 🔧 High Impact, Medium Complexity

| Feature | Description |
|---------|-------------|
| **Spaced repetition / resurfacing** | The wiki is only useful if you re-read it. The bot periodically surfaces articles you haven't reviewed in X days, prioritizing the most connected ones. |
| **Automatic knowledge gap detection** | Detect topics heavily referenced in `[[wikilinks]]` that have no article yet, and suggest what to ingest to fill the gaps. |
| **Reactive compilation** | Instead of compiling manually, trigger automatically when N new items arrive or X time has passed since the last compilation. |

---

## 💡 Medium Impact, Interesting

| Feature | Description |
|---------|-------------|
| **Local wiki web viewer** | A minimal Express server that renders the wiki as a navigable website with clickable wikilinks, without depending on Obsidian. |
| **Debate mode** | `brain: debate <topic>` generates an output with arguments for and against using only what's in the wiki, identifying where information is missing. |
| **Timeline view** | Visualize how topics evolved over time: when you started saving things about AI, peak activity, topics you abandoned. |
| **Graph visualizer** | Interactive node graph of `[[wikilinks]]` between articles, similar to Obsidian's graph view. Candidate implementation: [d3-force](wiki/d3-force.md). |
