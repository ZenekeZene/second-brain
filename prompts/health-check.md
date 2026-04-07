# Prompt: Second Brain Health Check

Run a full health check on the user's second brain.

## Your task

1. Read `INDEX.md` and Glob `wiki/*.md` and `raw/**/*.md`
2. Analyze the wiki state across the following dimensions:

### Structural integrity
- How many articles are in wiki/?
- How many items in `.state/pending.json`?
- When was the last compilation?

### Orphan articles
- Articles in wiki/ that are NOT referenced as `[[wikilink]]` in any other article
- List by name

### Broken links
- `[[wikilinks]]` that appear in articles but have NO corresponding file in wiki/
- These are opportunities to create new articles

### Articles without sources
- Articles whose frontmatter has `sources: []` or no `sources` field

### Possible contradictions
- Articles on similar topics that might have inconsistent information
- Suggest which ones to review manually

### Stale articles
- Articles not updated in more than 90 days (check `updated:` frontmatter field)

### Candidate new articles
- Based on broken links and frequently mentioned topics, suggest 3-5 new articles to create

## Output

Save the report to `outputs/YYYY-MM-DD-health-check.md` using the standard output format
defined in CLAUDE.md. Include concrete metrics and actionable lists.

At the end, give a health score from 1 to 10 with justification.
