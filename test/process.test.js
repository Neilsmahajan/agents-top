import { describe, expect, test } from "bun:test";
import { etimeToSeconds, isClaudeProcess, isCodexProcess, parsePs } from "../src/process.js";

describe("parsePs", () => {
  test("parses pid, ppid, etime, cpu, rss and args", () => {
    const out =
      "  101     1   01:02:03  12.5  20480 /usr/local/bin/claude --session-id abc\n  7 1 05:00 0.0 10 -zsh\ngarbage\n";
    expect(parsePs(out)).toEqual([
      { pid: 101, ppid: 1, etime: "01:02:03", cpu: 12.5, rssKb: 20480, args: "/usr/local/bin/claude --session-id abc" },
      { pid: 7, ppid: 1, etime: "05:00", cpu: 0, rssKb: 10, args: "-zsh" },
    ]);
  });
});

describe("etimeToSeconds", () => {
  test.each([
    ["00:07", 7],
    ["05:00", 300],
    ["01:02:03", 3723],
    ["2-00:00:01", 172801],
    ["bogus", null],
  ])("%s", (etime, secs) => expect(etimeToSeconds(etime)).toBe(secs));
});

describe("process matching", () => {
  test.each([
    ["claude", true],
    ["/usr/local/bin/claude --session-id x", true],
    ["/opt/tools/claude -p hello", true],
    ["/home/dev/.local/share/claude/versions/2.1.0 --print --session-id x", true],
    ["node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume", true],
    ["tmux new-session -d claude", false],
    ["/bin/zsh -lc claude --continue", false],
    ["/usr/local/bin/claude-foo", false],
    ["vim notes-about-claude.md", false],
    ["node my-script.js /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js", false],
    ["node --no-warnings /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js", true],
  ])("claude: %s", (args, want) => expect(isClaudeProcess(args)).toBe(want));

  test.each([
    ["codex", true],
    ["/opt/homebrew/bin/codex exec --sandbox read-only", true],
    ["/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex app-server", true],
    ["node /usr/lib/node_modules/@openai/codex/bin/codex.js", false],
    ["grep codex", false],
  ])("codex: %s", (args, want) => expect(isCodexProcess(args)).toBe(want));
});
