import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranscriptReader, findTranscript, projectDirNames, sharedKind } from "../src/claude.js";
import { age, claudeHome, FIXTURES, S1, S2, S3, transcriptPath } from "./helpers.js";

const fixture = (dir, sid) => join(FIXTURES, "claude", "projects", dir, `${sid}.jsonl`);

describe("transcript parsing", () => {
  test("reads model, tokens, title, branch, tools from a Claude transcript", () => {
    const t = createTranscriptReader()(fixture("-work-demo-app", S1));
    expect(t.model).toBe("claude-opus-5-5");
    // last main-conversation request: 900 + 41000 + 1100
    expect(t.contextTokens).toBe(43000);
    // 150 + 95 (msg_02 written twice, counted once at its final value) + 70 (subagent) + 60
    expect(t.outputTokens).toBe(375);
    expect(t.title).toBe("Fix the login redirect");
    expect(t.gitBranch).toBe("feature/login");
    expect(t.permissionMode).toBe("default");
    expect(t.lastTool).toBe("mcp__claude-in-chrome__navigate");
    expect([...t.pending.values()]).toEqual(["mcp__claude-in-chrome__navigate"]);
    expect(t.shared.chrome).toBe(Date.parse("2026-01-15T10:00:20.000Z"));
  });

  test("subagent (sidechain) turns don't set the main model, context or pending tool", () => {
    const t = createTranscriptReader()(fixture("-work-demo-app", S1));
    expect(t.model).not.toBe("claude-haiku-5-5");
    expect(t.contextTokens).toBeLessThan(500000);
    expect([...t.pending.values()]).not.toContain("Grep");
  });

  test("permission mode from user records", () => {
    expect(createTranscriptReader()(fixture("-work-demo-app", S2)).permissionMode).toBe("acceptEdits");
    expect(createTranscriptReader()(fixture("-work-api-server", S3)).permissionMode).toBe("bypassPermissions");
  });

  test("answered tool calls are not pending", () => {
    const t = createTranscriptReader()(fixture("-work-demo-app", S2));
    expect(t.pending.size).toBe(0);
    expect(t.lastTool).toBe("Read");
  });

  test("missing file returns null", () => {
    expect(createTranscriptReader()("/nonexistent/x.jsonl")).toBeNull();
  });

  test("incremental reads match a full read, even split mid-line and mid-character", () => {
    const full = readFileSync(fixture("-work-demo-app", S1));
    const withEmoji = Buffer.concat([
      full,
      Buffer.from(`${JSON.stringify({ type: "ai-title", aiTitle: "Fix the login redirect ✅" })}\n`),
    ]);
    const dir = mkdtempSync(join(tmpdir(), "agents-top-inc-"));
    const p = join(dir, "t.jsonl");
    const read = createTranscriptReader();
    const cut = withEmoji.lastIndexOf(Buffer.from("✅")) + 1; // one byte into the 3-byte ✅
    writeFileSync(p, withEmoji.subarray(0, 700));
    read(p);
    appendFileSync(p, withEmoji.subarray(700, cut));
    expect(read(p).title).toBe("Fix the login redirect");
    appendFileSync(p, withEmoji.subarray(cut));
    const inc = read(p);
    expect(inc.title).toBe("Fix the login redirect ✅");
    expect(inc.outputTokens).toBe(375);
    expect(inc.contextTokens).toBe(43000);
  });

  test("a truncated (rewritten) file is re-read from the start", () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-top-trunc-"));
    const p = join(dir, "t.jsonl");
    const read = createTranscriptReader();
    writeFileSync(p, readFileSync(fixture("-work-demo-app", S1)));
    expect(read(p).outputTokens).toBe(375);
    writeFileSync(p, readFileSync(fixture("-work-api-server", S3)));
    const t = read(p);
    expect(t.outputTokens).toBe(30);
    expect(t.title).toBe("Upgrade dependencies");
  });
});

describe("token accounting edge cases", () => {
  const parse = (records) => {
    const dir = mkdtempSync(join(tmpdir(), "agents-top-tok-"));
    const p = join(dir, "t.jsonl");
    writeFileSync(p, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
    return createTranscriptReader()(p);
  };
  const asst = (id, out, extra = {}) => ({
    type: "assistant",
    ...extra,
    message: { id, model: "claude-opus-5-5", usage: { input_tokens: 100, output_tokens: out }, content: [] },
  });

  test("interleaved records of one message are counted once, at the latest value", () => {
    const t = parse([asst("m1", 10), asst("s1", 5, { isSidechain: true }), asst("m1", 12)]);
    expect(t.outputTokens).toBe(17);
  });

  test("synthetic records don't reset context or count tokens", () => {
    const t = parse([
      asst("m1", 10),
      { type: "assistant", message: { id: "x", model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } } },
    ]);
    expect(t.contextTokens).toBe(100);
    expect(t.model).toBe("claude-opus-5-5");
  });
});

describe("rewritten transcripts", () => {
  test("a same-size replacement is re-read", () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-top-rw-"));
    const p = join(dir, "t.jsonl");
    const read = createTranscriptReader();
    writeFileSync(p, `${JSON.stringify({ type: "ai-title", aiTitle: "first title" })}\n`);
    expect(read(p).title).toBe("first title");
    writeFileSync(p, `${JSON.stringify({ type: "ai-title", aiTitle: "other title" })}\n`);
    expect(read(p).title).toBe("other title");
  });

  test("a larger replacement doesn't mix old state with a suffix of the new file", () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-top-rw-"));
    const p = join(dir, "t.jsonl");
    const read = createTranscriptReader();
    writeFileSync(p, readFileSync(fixture("-work-api-server", S3)));
    expect(read(p).outputTokens).toBe(30);
    writeFileSync(p, readFileSync(fixture("-work-demo-app", S1)));
    const t = read(p);
    expect(t.outputTokens).toBe(375);
    expect(t.permissionMode).toBe("default");
  });
});

describe("sharedKind", () => {
  test("classifies browser and desktop tools", () => {
    expect(sharedKind("mcp__claude-in-chrome__navigate")).toBe("chrome");
    expect(sharedKind("mcp__computer-use__screenshot")).toBe("computerUse");
    expect(sharedKind("Bash")).toBeNull();
    expect(sharedKind(null)).toBeNull();
  });
});

describe("finding a transcript", () => {
  test("project dir names cover current and older encodings", () => {
    expect(projectDirNames("/work/demo-app")).toEqual(["-work-demo-app"]);
    expect(projectDirNames("/work/my_app.v2")).toEqual(["-work-my-app-v2", "-work-my_app-v2"]);
  });

  test("--session-id is an exact match, from any project dir", () => {
    const home = claudeHome();
    const projectsDir = join(home, "projects");
    const claimed = new Set();
    expect(findTranscript({ projectsDir, sessionId: S3, cwd: "/elsewhere", claimed })).toEqual({
      path: transcriptPath(home, "-work-api-server", S3),
      match: "session-id",
    });
  });

  test("an unknown --session-id finds nothing instead of guessing", () => {
    const home = claudeHome();
    const r = findTranscript({
      projectsDir: join(home, "projects"),
      sessionId: "99999999-9999-4999-8999-999999999999",
      cwd: "/work/demo-app",
      claimed: new Set(),
    });
    expect(r).toBeNull();
  });

  test("without a session id, the newest unclaimed transcript in the cwd wins (heuristic)", () => {
    const home = claudeHome();
    const now = Date.now();
    age(transcriptPath(home, "-work-demo-app", S1), now, 5_000);
    age(transcriptPath(home, "-work-demo-app", S2), now, 60_000);
    const projectsDir = join(home, "projects");
    const claimed = new Set();
    const first = findTranscript({ projectsDir, cwd: "/work/demo-app", claimed });
    expect(first).toEqual({ path: transcriptPath(home, "-work-demo-app", S1), match: "cwd-newest" });
    claimed.add(first.path);
    expect(findTranscript({ projectsDir, cwd: "/work/demo-app", claimed })?.path).toBe(
      transcriptPath(home, "-work-demo-app", S2),
    );
    claimed.add(transcriptPath(home, "-work-demo-app", S2));
    expect(findTranscript({ projectsDir, cwd: "/work/demo-app", claimed })).toBeNull();
    expect(findTranscript({ projectsDir, cwd: "/no/such/dir", claimed })).toBeNull();
  });
});
