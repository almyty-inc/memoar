#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const { ensureBinary } = require("../lib/platform");
const packageJson = require("../package.json");

async function main() {
  const binary = await ensureBinary({ version: packageJson.version });
  const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", error => {
    console.error(`memoar: could not start ${binary}: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code === null ? 1 : code;
  });
}

main().catch(error => {
  console.error(`memoar: ${error.message}`);
  process.exitCode = 1;
});
