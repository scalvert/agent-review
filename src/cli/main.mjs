#!/usr/bin/env node
// The agent-review bin. The command line itself is run.mjs.
import { main } from "./run.mjs";

process.exitCode = main(process.argv.slice(2));
