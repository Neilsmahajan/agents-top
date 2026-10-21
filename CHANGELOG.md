# Changelog

## 0.1.0

First public release.

- One view of every Claude Code session (directory, model, context and output
  tokens, current or last tool, title, git branch) and every Codex process
  (directory, kind, sandbox).
- `--json` with a versioned schema (`schema/agents-top.v1.schema.json`),
  documented exit codes, diagnostics on stderr, and no color or live view when
  stdout isn't a terminal.
- Heuristics are labeled as guesses: possible permission prompts, working /
  waiting / idle state, directory-based transcript matching, and shared
  Chrome / computer-use warnings.
- Works on Node 18+ and Bun, on macOS and Linux.
- `SKILL.md` for coding agents.
