// Human-readable table for a snapshot.

export function makeColors(enabled) {
  const c = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { dim: c("2"), bold: c("1"), green: c("32"), yellow: c("33"), red: c("31"), cyan: c("36") };
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

export const shortModel = (m) => (m ? m.replace(/^claude-/, "").replace(/-\d{8}$/, "") : "?");

export const fmtTokens = (n) => {
  if (n == null) return "?";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
};

export const fmtAge = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
};

export const shortTool = (t) =>
  t
    ? t
        .replace(/^mcp__claude-in-chrome__/, "chrome:")
        .replace(/^mcp__computer-use__/, "computer:")
        .replace(/^mcp__plugin_github_github__/, "gh:")
        .replace(/^mcp__/, "")
    : "";

const truncate = (s, n) => (s && s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : (s ?? ""));

function table(rows, headers, dim) {
  const widths = headers.map((h, i) => Math.max(stripAnsi(h).length, ...rows.map((r) => stripAnsi(r[i] ?? "").length)));
  const fmtRow = (cells) =>
    cells
      .map((cell, i) => (cell ?? "") + " ".repeat(Math.max(0, widths[i] - stripAnsi(cell ?? "").length)))
      .join("  ")
      .trimEnd();
  return [dim(fmtRow(headers)), ...rows.map(fmtRow)].join("\n");
}

/**
 * @param {object} snap      buildSnapshot() output
 * @param {object} o
 * @param {boolean} o.color
 * @param {number} [o.width] terminal columns
 * @param {string} [o.home]  shown as "~" in paths
 */
export function render(snap, { color = false, width = 140, home = "" } = {}) {
  const { dim, bold, green, yellow, red, cyan } = makeColors(color);
  const prettyDir = (p) =>
    p ? (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p) : "?";
  const sessions = snap.claude.sessions;
  const codex = snap.codex.processes;
  const hosts = snap.claude.remoteControlHosts;
  const out = [];

  const active = sessions.filter((s) => s.state === "active").length;
  const time = new Date(snap.generatedAt).toLocaleTimeString();
  out.push(
    `${bold("agents-top")}${dim(` — ${time}  `)}${sessions.length} claude session${sessions.length === 1 ? "" : "s"} (${green(`${active} active`)})` +
      (codex.length ? `, ${codex.length} codex` : "") +
      (hosts.length ? dim(`, ${hosts.length} remote-control host${hosts.length === 1 ? "" : "s"}`) : ""),
  );

  const byPid = new Map(sessions.map((s) => [s.pid, s]));
  for (const use of snap.sharedResources) {
    const label = use.resource === "chrome" ? "Chrome (claude-in-chrome)" : "computer use";
    const who = use.sessions
      .map(({ pid, inUseNow }) => {
        const s = byPid.get(pid);
        const name = truncate(s?.title ?? prettyDir(s?.cwd), 40);
        return inUseNow ? red(`${name} [in tool now]`) : name;
      })
      .join(dim(" | "));
    const mark = use.contention || use.sessions.some((s) => s.inUseNow) ? red("⚠") : yellow("•");
    out.push(
      `${mark} ${bold(label)} used in the last 15m by ${use.sessions.length}: ${who}` +
        (use.contention ? red("  ← may contend (guess)") : ""),
    );
  }

  const headers = ["", "PID", "DIR", "MODEL", "CTX", "OUT", "CPU%", "UP", "LAST", "TOOL", "TITLE"];
  const body = sessions.map((s) => {
    const idle = s.idleSeconds;
    const state = {
      active: green("●"),
      waiting: yellow("⚠"),
      idle: dim("◌"),
      unknown: dim("?"),
    }[s.state];
    const tool = s.pendingTool ?? s.lastTool;
    const toolName = truncate(shortTool(tool), s.possiblePermissionPrompt ? 20 : 26);
    const toolTxt = tool
      ? (s.pendingTool ? cyan(toolName) : dim(toolName)) + (s.possiblePermissionPrompt ? red(" perm?") : "")
      : "";
    const ctx = s.contextTokens;
    const ctxTxt =
      ctx == null
        ? dim("?")
        : ctx > 180_000
          ? red(fmtTokens(ctx))
          : ctx > 120_000
            ? yellow(fmtTokens(ctx))
            : fmtTokens(ctx);
    return [
      state,
      String(s.pid),
      truncate(prettyDir(s.cwd), 38) +
        (s.headless ? dim(" [-p]") : "") +
        (s.transcript?.match === "cwd-newest" ? dim(" ≈") : ""),
      s.transcript ? shortModel(s.model) : dim("?"),
      ctxTxt,
      s.transcript ? fmtTokens(s.outputTokens) : dim("?"),
      s.cpuPercent.toFixed(0),
      s.uptime,
      idle == null ? "" : fmtAge(idle),
      toolTxt,
      s.title ?? "",
    ];
  });
  // The title takes whatever width the other columns leave.
  const used = headers
    .slice(0, -1)
    .reduce((n, h, i) => n + 2 + Math.max(h.length, ...body.map((r) => stripAnsi(r[i]).length)), 0);
  for (const r of body) r[r.length - 1] = truncate(r[r.length - 1], Math.max(10, width - used - 1));
  out.push("");
  out.push(sessions.length ? table(body, headers, dim) : dim("  (no Claude Code sessions running)"));

  if (codex.length) {
    out.push("");
    out.push(`${bold("codex")} ${dim("(process info only)")}`);
    out.push(
      table(
        codex.map((p) => [
          String(p.pid),
          p.kind,
          p.sandbox ? dim(p.sandbox) : "",
          truncate(prettyDir(p.cwd), 52),
          p.uptime,
        ]),
        ["PID", "KIND", "SANDBOX", "DIR", "UP"],
        dim,
      ),
    );
  }
  if (hosts.length)
    out.push(
      `\n${dim(`remote-control hosts: ${hosts.map((h) => `${h.name ?? "remote-control"} (pid ${h.pid}, up ${h.uptime})`).join(", ")}`)}`,
    );

  return out.join("\n");
}
