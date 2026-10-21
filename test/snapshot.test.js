import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createTranscriptReader } from "../src/claude.js";
import { buildSnapshot, possiblePermissionPrompt, sharedResourceUse } from "../src/snapshot.js";
import { age, claudeHome, proc, S1, S2, S3, transcriptPath, validator } from "./helpers.js";

const NOW = Date.parse("2026-01-15T12:00:00.000Z");

function scenario() {
  const home = claudeHome();
  age(transcriptPath(home, "-work-demo-app", S1), NOW, 5_000); // active
  age(transcriptPath(home, "-work-demo-app", S2), NOW, 20 * 60_000); // idle
  age(transcriptPath(home, "-work-api-server", S3), NOW, 10 * 60_000); // quiet with a tool pending
  const procs = [
    // listed first, without --session-id: must not steal S1, which pid 200 names exactly
    proc(100, "/usr/local/bin/claude --continue"),
    proc(200, `/usr/local/bin/claude --session-id ${S1}`),
    proc(300, `/usr/local/bin/claude --dangerously-skip-permissions --session-id ${S3} -p run-tests`),
    proc(400, "/usr/local/bin/claude --session-id 99999999-9999-4999-8999-999999999999"),
    proc(500, "/usr/local/bin/claude remote-control --remote-control-session-name-prefix home"),
    proc(600, "codex exec --sandbox read-only -C /work/demo-app"),
    proc(601, "/opt/codex/bin/codex exec --sandbox read-only -C /work/demo-app", { ppid: 600 }),
    proc(700, "/opt/homebrew/bin/codex"),
    proc(800, "/bin/zsh -c claude"),
  ];
  const cwds = {
    100: "/work/demo-app",
    200: "/work/demo-app",
    300: "/work/api-server",
    400: "/work/x",
    700: "/work/cli",
  };
  const snap = buildSnapshot({
    procs,
    cwds,
    projectsDir: join(home, "projects"),
    readTranscript: createTranscriptReader(),
    now: NOW,
  });
  return { home, snap, byPid: new Map(snap.claude.sessions.map((s) => [s.pid, s])) };
}

describe("buildSnapshot", () => {
  test("output validates against the v1 JSON schema", () => {
    const { snap } = scenario();
    const validate = validator();
    const ok = validate({ tool: "agents-top", toolVersion: "0.0.0", ...snap });
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    expect(snap.schemaVersion).toBe(1);
  });

  test("exact --session-id match with full Claude metrics", () => {
    const { byPid, home } = scenario();
    const s = byPid.get(200);
    expect(s.transcript).toEqual({ path: transcriptPath(home, "-work-demo-app", S1), match: "session-id" });
    expect(s).toMatchObject({
      sessionId: S1,
      model: "claude-opus-5-5",
      contextTokens: 43000,
      outputTokens: 375,
      title: "Fix the login redirect",
      gitBranch: "feature/login",
      state: "active",
      idleSeconds: 5,
      pendingTool: "mcp__claude-in-chrome__navigate",
      possiblePermissionPrompt: false,
      headless: false,
    });
  });

  test("a process without --session-id gets the newest unclaimed transcript in its cwd (heuristic)", () => {
    const { byPid, home } = scenario();
    const s = byPid.get(100);
    expect(s.transcript).toEqual({ path: transcriptPath(home, "-work-demo-app", S2), match: "cwd-newest" });
    expect(s.sessionId).toBe(S2);
    expect(s.state).toBe("idle");
  });

  test("a quiet pending tool is 'waiting', but never a permission prompt in bypassPermissions mode", () => {
    const s = scenario().byPid.get(300);
    expect(s.state).toBe("waiting");
    expect(s.pendingTool).toBe("Bash");
    expect(s.permissionMode).toBe("bypassPermissions");
    expect(s.possiblePermissionPrompt).toBe(false);
    expect(s.headless).toBe(true);
  });

  test("no transcript: state unknown, metrics null, not zero", () => {
    const s = scenario().byPid.get(400);
    expect(s).toMatchObject({
      transcript: null,
      state: "unknown",
      model: null,
      contextTokens: null,
      outputTokens: null,
      idleSeconds: null,
    });
  });

  test("remote-control hosts are listed separately; shells that mention claude are ignored", () => {
    const { snap, byPid } = scenario();
    expect(snap.claude.remoteControlHosts).toEqual([{ pid: 500, uptime: "05:00", uptimeSeconds: 300, name: "home" }]);
    expect(byPid.has(500)).toBe(false);
    expect(byPid.has(800)).toBe(false);
    expect([...byPid.keys()].sort()).toEqual([100, 200, 300, 400]);
  });

  test("sessions are sorted most recently active first", () => {
    expect(scenario().snap.claude.sessions.map((s) => s.pid)).toEqual([200, 300, 100, 400]);
  });

  test("Codex is process info only: wrapper chains collapse, no model/tokens/tool fields", () => {
    const { snap } = scenario();
    expect(snap.codex.processes.map((p) => p.pid)).toEqual([601, 700]);
    const [exec, cli] = snap.codex.processes;
    expect(exec).toMatchObject({ kind: "cli-exec", sandbox: "read-only", cwd: "/work/demo-app" });
    expect(cli).toMatchObject({ kind: "cli", sandbox: null, cwd: "/work/cli" });
    for (const p of snap.codex.processes)
      expect(Object.keys(p).sort()).toEqual(
        ["cpuPercent", "cwd", "kind", "pid", "ppid", "rssKb", "sandbox", "uptime", "uptimeSeconds"].sort(),
      );
  });

  test("Chrome use is reported while a Chrome tool is pending, even if it started long ago", () => {
    const { snap } = scenario();
    expect(snap.sharedResources).toEqual([
      { resource: "chrome", sessions: [{ pid: 200, inUseNow: true }], contention: false },
    ]);
  });
});

describe("sharedResourceUse (heuristic)", () => {
  const session = (pid, chrome, pendingTools = []) => ({
    pid,
    pendingTool: pendingTools.at(-1) ?? null,
    pendingTools,
    sharedResourcesLastUsed: {
      chrome: chrome == null ? null : new Date(NOW - chrome).toISOString(),
      computerUse: null,
    },
  });
  test("uses within 15 minutes count; two sessions are contention", () => {
    expect(sharedResourceUse([session(1, 60_000), session(2, 14 * 60_000), session(3, 16 * 60_000)], NOW)).toEqual([
      {
        resource: "chrome",
        sessions: [
          { pid: 1, inUseNow: false },
          { pid: 2, inUseNow: false },
        ],
        contention: true,
      },
    ]);
  });
  test("nothing recent, nothing reported", () => {
    expect(sharedResourceUse([session(1, 30 * 60_000), session(2, null)], NOW)).toEqual([]);
  });
});

describe("review regressions", () => {
  const run = (procs, cwds = {}) =>
    buildSnapshot({
      procs,
      cwds,
      projectsDir: join(claudeHome(), "projects"),
      readTranscript: createTranscriptReader(),
      now: NOW,
    });

  test("a prompt that mentions remote-control is a session, not a host", () => {
    const snap = run([proc(1, "/usr/local/bin/claude -p explain remote-control options")]);
    expect(snap.claude.remoteControlHosts).toEqual([]);
    expect(snap.claude.sessions.map((s) => s.pid)).toEqual([1]);
  });

  test("an npm-installed remote-control host is a host", () => {
    const snap = run([
      proc(1, "node --no-warnings /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js remote-control"),
    ]);
    expect(snap.claude.remoteControlHosts.map((h) => h.pid)).toEqual([1]);
    expect(snap.claude.sessions).toEqual([]);
  });

  test("identical Codex parent and child in different directories are both kept", () => {
    const snap = run([proc(10, "/usr/local/bin/codex"), proc(11, "/usr/local/bin/codex", { ppid: 10 })], {
      10: "/work/a",
      11: "/work/b",
    });
    expect(snap.codex.processes.map((p) => p.pid)).toEqual([10, 11]);
  });

  test("an independent Codex session that starts `codex exec` is kept", () => {
    const snap = run([
      proc(10, "/usr/local/bin/codex"),
      proc(11, "/usr/local/bin/codex exec --sandbox read-only review", { ppid: 10 }),
    ]);
    expect(snap.codex.processes.map((p) => p.pid)).toEqual([10, 11]);
  });

  test("a relative -C is resolved against the process cwd", () => {
    const snap = run([proc(10, "/usr/local/bin/codex exec -C sub/dir")], { 10: "/work/demo-app" });
    expect(snap.codex.processes[0].cwd).toBe("/work/demo-app/sub/dir");
  });
});

describe("parallel pending tools", () => {
  test("a still-pending Chrome call counts even when a later tool is the newest", () => {
    const s = {
      pid: 1,
      pendingTool: "Bash",
      pendingTools: ["mcp__claude-in-chrome__navigate", "Bash"],
      sharedResourcesLastUsed: { chrome: new Date(NOW - 60 * 60_000).toISOString(), computerUse: null },
    };
    expect(sharedResourceUse([s], NOW)).toEqual([
      { resource: "chrome", sessions: [{ pid: 1, inUseNow: true }], contention: false },
    ]);
  });
});

describe("possiblePermissionPrompt (heuristic)", () => {
  const base = { pendingTool: "Bash", idleMs: 61_000, permissionMode: "default" };
  test("flags a tool quiet for over 60s", () => expect(possiblePermissionPrompt(base)).toBe(true));
  test("not before 60s", () => expect(possiblePermissionPrompt({ ...base, idleMs: 59_000 })).toBe(false));
  test("not without a pending tool", () =>
    expect(possiblePermissionPrompt({ ...base, pendingTool: null })).toBe(false));
  test("not in bypassPermissions mode", () =>
    expect(possiblePermissionPrompt({ ...base, permissionMode: "bypassPermissions" })).toBe(false));
  test("not for AskUserQuestion", () =>
    expect(possiblePermissionPrompt({ ...base, pendingTool: "AskUserQuestion" })).toBe(false));
  test("unknown permission mode still flags", () =>
    expect(possiblePermissionPrompt({ ...base, permissionMode: null })).toBe(true));
});
