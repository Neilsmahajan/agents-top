---
name: agents-top
description: List the coding-agent sessions running on this machine with the agents-top CLI. For Claude Code sessions it reports directory, model, context size, current tool and state; for Codex it reports processes only (directory, sandbox). Use when asked what other agents are doing, which Claude Code sessions are idle or may be waiting for approval, whether another session is using the shared Chrome browser or computer use, or before starting work that could collide with another agent in the same directory.
---

# agents-top

`agents-top` lists the coding-agent sessions on this machine. It is read-only.

## Use

Always use the JSON form; never the live view.

```sh
agents-top --json
```

Exit codes: `0` success (an empty list is a success), `1` runtime error (message
on stderr), `2` usage error. If the command isn't installed, say so rather than
reading transcripts by hand.

## Reading the output

Top-level keys: `schemaVersion` (1), `generatedAt`, `claude.sessions`,
`claude.remoteControlHosts`, `codex.processes`, `sharedResources`.

Each `claude.sessions[]` entry has `pid`, `cwd`, `sessionId`, `model`,
`contextTokens`, `outputTokens`, `title`, `gitBranch`, `permissionMode`,
`lastTool`, `pendingTool`, `pendingTools`, `idleSeconds`, `state`, `possiblePermissionPrompt`
and `transcript` (`path`, `match`). `null` means unknown, not zero.

`codex.processes[]` has process information only: `pid`, `cwd`, `kind`
(`cli`, `cli-exec`, `chatgpt-app`), `sandbox`, uptime and CPU. There is no
model, token or tool data for Codex, and Cursor isn't detected at all.

## Guesses: say so when you report them

- `possiblePermissionPrompt: true` means a tool call has no result yet and the
  transcript hasn't changed for over 60 seconds. It may be waiting for
  approval, or just running a long command.
  Say "may be waiting for approval", not "is blocked".
- `state` (`active`, `waiting`, `idle`, `unknown`) comes from how recently the
  transcript file changed.
- `transcript.match: "cwd-newest"` means the transcript was matched by
  directory, not by session id, and could belong to another session in the
  same directory.
- `sharedResources` lists sessions that used Chrome or computer use in the last
  15 minutes or are waiting on such a tool now; `contention: true` means two or
  more did, not that they collided.

## Your own session

You are usually one of the listed sessions. Match yourself by `cwd` and the
session id or title you know, and leave yourself out of reports about "other"
agents.

## Don't

- Don't run `agents-top -w` (it's a live view for people; without a terminal
  it prints one snapshot anyway).
- Don't kill, signal or message other sessions based on this output unless the
  user asked you to.
- Don't paste transcript paths or titles into public places: they can reveal
  project names.
