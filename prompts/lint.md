# Prompt: Second Brain Weekly Lint

Run the weekly lint on the user's second brain. The goal is to keep the wiki
clean, well-organized, and manageable as it grows.

## Your task

1. Read `INDEX.md` and all articles in `wiki/`
2. Analyze the following aspects:

### Duplicates and overlaps
- Articles with very similar titles or content that should be merged
- Example: `react-hooks.md` and `hooks-react.md` are probably the same topic

### Articles too long
- Articles with more than 400 lines that should be split into more specific articles
- Suggest how to split them and what names to give them

### Articles too short
- Articles with fewer than 15 lines of content that should be merged with another article
- Suggest where to integrate them

### Wikilink quality
- Articles with few or no `[[wikilink]]` connections (fewer than 2)
- Suggest connections that could be added

### Tag consistency
- Inconsistent tags (e.g. `ai`, `AI`, `artificial-intelligence` for the same concept)
- Propose a normalization

### Category balance
- Are there categories in INDEX.md with too many articles that should be subdivided?
- Are there topics without coverage that should be added?

## Output

Save the report to `outputs/YYYY-MM-DD-lint.md`. Be direct and actionable: for each
problem found, state exactly what to do. Prioritize the highest-impact changes.
