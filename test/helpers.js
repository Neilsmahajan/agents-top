import { cpSync, mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURES = join(ROOT, "test", "fixtures");

export const S1 = "11111111-1111-4111-8111-111111111111"; // demo-app, busy, Chrome tool pending
export const S2 = "22222222-2222-4222-8222-222222222222"; // demo-app, finished
export const S3 = "33333333-3333-4333-8333-333333333333"; // api-server, bypassPermissions, Bash pending

/** Copy the synthetic Claude config dir to a temp dir so tests can set mtimes. */
export function claudeHome() {
  const dir = mkdtempSync(join(tmpdir(), "agents-top-test-"));
  cpSync(join(FIXTURES, "claude"), dir, { recursive: true });
  return dir;
}

export const transcriptPath = (home, projectDir, sid) => join(home, "projects", projectDir, `${sid}.jsonl`);

/** Set a file's mtime to `ageMs` before `now`. */
export function age(path, now, ageMs) {
  const t = new Date(now - ageMs);
  utimesSync(path, t, t);
}

export function validator() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(JSON.parse(readFileSync(join(ROOT, "schema", "agents-top.v1.schema.json"), "utf8")));
}

/** A fake `ps` row. */
export const proc = (pid, args, extra = {}) => ({
  pid,
  ppid: 1,
  etime: "05:00",
  cpu: 1.5,
  rssKb: 1000,
  args,
  ...extra,
});
