// Smoke test under Node (the tests run under Bun): the CLI starts, honors the
// agent contract, and its --json output matches the schema.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (...args) =>
  spawnSync(process.execPath, [join(root, "bin", "agents-top.js"), ...args], { encoding: "utf8" });

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.equal(run("--version").stdout.trim(), pkg.version);
assert.equal(run("--help").status, 0);
const bad = run("--nope");
assert.equal(bad.status, 2);
assert.equal(bad.stdout, "");

const json = run("--json");
assert.equal(json.status, 0, json.stderr);
const ajv = new Ajv({ strict: false });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(join(root, "schema", "agents-top.v1.schema.json"), "utf8")));
assert.ok(validate(JSON.parse(json.stdout)), JSON.stringify(validate.errors));

const text = run();
assert.equal(text.status, 0, text.stderr);
assert.ok(!text.stdout.includes("\x1b["), "piped output must not contain ANSI escapes");
console.log(`node ${process.version}: smoke ok`);
