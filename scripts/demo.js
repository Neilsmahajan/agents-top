#!/usr/bin/env node
// Runs the real agents-top CLI against synthetic sessions, for the README demo
// (docs/demo.tape). Nothing here reads your actual processes or transcripts.
//
//   node scripts/demo.js [agents-top args...]

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDirNames } from "../src/claude.js";
import { main } from "../src/cli.js";

const HOME = "/home/dev";
const now = Date.now();
const config = mkdtempSync(join(tmpdir(), "agents-top-demo-"));

const sessions = [
  // pid, cwd, model, title, branch, ctx, out, tools, pendingTool, idle seconds, extra args, permission mode
  [
    41207,
    "code/storefront",
    "claude-opus-5-5",
    "Fix checkout tax rounding",
    "fix/tax",
    86_000,
    31_000,
    ["Read", "Edit"],
    "Edit",
    2,
  ],
  [
    41388,
    "code/storefront",
    "claude-sonnet-5-5",
    "Check the cart page in Chrome",
    "fix/tax",
    54_000,
    9_000,
    ["mcp__claude-in-chrome__navigate"],
    "mcp__claude-in-chrome__read_page",
    8,
  ],
  [
    39950,
    "code/api",
    "claude-opus-5-5",
    "Migrate auth to sessions",
    "feat/sessions",
    162_000,
    88_000,
    ["Grep", "Bash"],
    "Bash",
    140,
    [],
    "default",
  ],
  [
    40112,
    "code/docs-site",
    "claude-haiku-5-5",
    "Draft the v2 upgrade guide",
    "docs/v2",
    23_000,
    4_200,
    ["mcp__claude-in-chrome__screenshot", "Write"],
    null,
    420,
  ],
  [
    42001,
    "code/mobile-app",
    "claude-sonnet-5-5",
    "Nightly dependency check",
    "main",
    12_000,
    900,
    ["Bash"],
    null,
    1900,
    ["-p"],
  ],
];

const procs = [];
const cwds = {};
sessions.forEach(
  ([pid, dir, model, title, branch, ctx, out, tools, pending, idle, extra = [], mode = "acceptEdits"], i) => {
    const cwd = `${HOME}/${dir}`;
    const sid = `0000000${i}-demo-4000-8000-00000000000${i}`;
    const proj = join(config, "projects", projectDirNames(cwd)[0]);
    mkdirSync(proj, { recursive: true });
    const ts = new Date(now - idle * 1000).toISOString();
    const lines = [
      { type: "permission-mode", mode },
      { type: "user", cwd, gitBranch: branch, timestamp: ts, message: { role: "user", content: title } },
    ];
    tools.forEach((name, j) => {
      const done = !(pending && j === tools.length - 1 && name === pending);
      lines.push({
        type: "assistant",
        gitBranch: branch,
        timestamp: ts,
        message: {
          id: `msg_${j}`,
          model,
          content: [{ type: "tool_use", id: `toolu_${j}`, name }],
          usage: {
            input_tokens: 500,
            cache_read_input_tokens: ctx - 500,
            output_tokens: Math.round(out / tools.length),
          },
        },
      });
      if (done)
        lines.push({
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${j}` }] },
        });
    });
    if (pending && !tools.includes(pending))
      lines.push({
        type: "assistant",
        timestamp: ts,
        message: {
          id: "msg_p",
          model,
          content: [{ type: "tool_use", id: "toolu_p", name: pending }],
          usage: { input_tokens: 500, cache_read_input_tokens: ctx - 500, output_tokens: 0 },
        },
      });
    lines.push({ type: "ai-title", aiTitle: title });
    const file = join(proj, `${sid}.jsonl`);
    writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const t = new Date(now - idle * 1000);
    utimesSync(file, t, t);
    const up = ["1:02:11", "18:40", "2:45:03", "52:10", "31:45"][i];
    procs.push({
      pid,
      ppid: 1,
      etime: up,
      cpu: [14.2, 6.1, 0.4, 0, 0.1][i],
      rssKb: 300000,
      args: `/usr/local/bin/claude ${extra.join(" ")} --session-id ${sid}`,
    });
    cwds[pid] = cwd;
  },
);
procs.push(
  {
    pid: 43010,
    ppid: 1,
    etime: "03:12",
    cpu: 3,
    rssKb: 90000,
    args: `/usr/local/bin/codex exec --sandbox read-only -C ${HOME}/code/api`,
  },
  { pid: 38001, ppid: 1, etime: "4:10:22", cpu: 0, rssKb: 80000, args: "/usr/local/bin/codex" },
  {
    pid: 30010,
    ppid: 1,
    etime: "6-02:11:09",
    cpu: 0,
    rssKb: 70000,
    args: "/usr/local/bin/claude remote-control --remote-control-session-name-prefix laptop",
  },
);
cwds[38001] = `${HOME}/code/mobile-app`;

const code = main(process.argv.slice(2), {
  env: { ...process.env, CLAUDE_CONFIG_DIR: config },
  home: HOME,
  listProcesses: () => procs,
  cwdsFor: () => cwds,
});
if (typeof code === "number") process.exitCode = code;
