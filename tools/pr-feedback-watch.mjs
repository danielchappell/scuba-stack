#!/usr/bin/env node

const USAGE = `Usage: pr-feedback-watch.mjs <snapshot|poll|replay|status> [options]

Scuba PR feedback watcher placeholder.

The shared tool is installed by S01 so later reliability slices can add the
watcher state and GitHub collection contract without changing target install
layout again.
`;

const [, , command] = process.argv;

if (!command || command === "--help" || command === "-h" || command === "help") {
  process.stdout.write(USAGE);
  process.exit(0);
}

if (["snapshot", "poll", "replay", "status"].includes(command)) {
  process.stderr.write(`pr-feedback-watch.mjs ${command} is not implemented until the later watcher slices.\n`);
  process.exit(30);
}

process.stderr.write(`Unknown pr-feedback-watch.mjs command: ${command}\n\n${USAGE}`);
process.exit(30);
