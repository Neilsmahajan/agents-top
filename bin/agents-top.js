#!/usr/bin/env node
// agents-top — a `top` for coding-agent sessions. See README.md or --help.
import { main } from "../src/cli.js";

const code = main(process.argv.slice(2));
if (typeof code === "number") process.exitCode = code;
