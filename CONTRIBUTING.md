# Contributing to Second Brain

Thank you for your interest in contributing! This is a personal knowledge management tool,
so contributions that improve its generality, reliability, and ease of use are especially welcome.

## Ways to Contribute

- **Bug reports** — open an issue describing what happened, what you expected, and how to reproduce it
- **Feature requests** — open an issue explaining the use case before writing code
- **Pull requests** — fix bugs, improve docs, add tests, or implement discussed features

## Development Setup

```bash
git clone https://github.com/ZenekeZene/second-brain.git
cd second-brain
npm install
cp .env.example .env  # fill in your keys
```

Requirements: Node.js ≥ 20, [Claude Code CLI](https://claude.ai/code)

## Project Structure

```
bin/          CLI scripts (Node.js ESM)
prompts/      LLM prompt files used during compilation and routing
.claude/      Claude Code settings and hooks
```

## Guidelines

- **Keep it simple** — this project intentionally has zero build steps and minimal dependencies
- **No new dependencies** without a strong reason — every dependency is a maintenance burden
- **Scripts must work standalone** — each `bin/*.mjs` should be runnable without the others
- **Security first** — never interpolate user input into shell commands; use `spawnSync`/`execFileSync` with argument arrays
- **English** — all code, comments, CLI output, and prompts should be in English

## Pull Request Process

1. Fork the repo and create a branch (`fix/my-fix` or `feat/my-feature`)
2. Make your changes
3. Test manually: run the affected scripts and verify the output
4. Open a PR with a clear description of what and why

## Reporting Security Issues

Please **do not** open a public issue for security vulnerabilities.
Email the maintainer directly or use GitHub's private vulnerability reporting.
