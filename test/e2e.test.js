// End to end: real `ps` / lsof / procfs discovery against throwaway processes
// named `claude` and `codex` (symlinks to this JS runtime running an idle
// script), with a synthetic transcript in a temporary CLAUDE_CONFIG_DIR.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDirNames } from "../src/claude.js";
import { FIXTURES, ROOT, S1, validator } from "./helpers.js";

const SID = "55555555-5555-4555-8555-555555555555";
let base;
let children = [];
let workDir;
let claudeDir;

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "agents-top-e2e-")));
  const bin = join(base, "bin");
  workDir = join(base, "work", "demo-app");
  claudeDir = join(base, "claude-config");
  mkdirSync(bin, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  symlinkSync(process.execPath, join(bin, "claude"));
  symlinkSync(process.execPath, join(bin, "codex"));
  const idle = join(base, "idle.js");
  writeFileSync(idle, "setInterval(() => {}, 1000);\n");

  const projDir = join(claudeDir, "projects", projectDirNames(workDir)[0]);
  mkdirSync(projDir, { recursive: true });
  copyFileSync(join(FIXTURES, "claude", "projects", "-work-demo-app", `${S1}.jsonl`), join(projDir, `${SID}.jsonl`));

  const opts = { cwd: workDir, stdio: "ignore" };
  children = [
    spawn(join(bin, "claude"), [idle, "--session-id", SID], opts),
    spawn(join(bin, "codex"), [idle, "exec", "--sandbox", "read-only"], opts),
  ];
  await new Promise((r) => setTimeout(r, 500));
});

afterAll(() => {
  for (const c of children) c.kill();
  if (base) rmSync(base, { recursive: true, force: true });
});

const cli = (args) =>
  spawnSync(process.execPath, [join(ROOT, "bin", "agents-top.js"), ...args], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir },
  });

describe.skipIf(process.platform === "win32")("end to end", () => {
  test("finds real processes, their cwd, and the transcript by --session-id", () => {
    const r = cli(["--json"]);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(validator()(doc)).toBe(true);
    const claude = doc.claude.sessions.find((s) => s.pid === children[0].pid);
    expect(claude).toBeDefined();
    expect(claude).toMatchObject({
      cwd: workDir,
      sessionId: SID,
      transcript: { match: "session-id" },
      model: "claude-opus-5-5",
      contextTokens: 43000,
      title: "Fix the login redirect",
    });
    const codex = doc.codex.processes.find((p) => p.pid === children[1].pid);
    expect(codex).toMatchObject({ kind: "cli-exec", sandbox: "read-only", cwd: workDir });
  });

  test("piped text output has no color or TUI escapes", () => {
    const r = cli(["-w"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Fix the login redirect");
    expect(r.stdout).not.toContain("\x1b[");
    expect(r.stderr).toContain("not a terminal");
  });
});
