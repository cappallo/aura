#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const cliPath = path.join("dist", "cli.js");

function runCommand(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runExpectFailure(description, command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status === 0) {
    console.error(description);
    process.exit(1);
  }
}

runCommand("node", [cliPath, "test", "examples/median.lx"]);
runCommand("node", [cliPath, "test", "examples/logging.lx"]);
runCommand("node", [cliPath, "test", "examples/contracts.lx"]);
runCommand("node", [cliPath, "test", "examples/builtins.lx"]);
runCommand("node", [cliPath, "test", "examples/property_basics.lx"]);
runCommand("node", [cliPath, "test", "examples/comments.lx"]);
runCommand("node", [cliPath, "test", "--input=ast", "examples/ast_demo.json"]);
runCommand("node", [cliPath, "run", "--input=ast", "examples/ast_demo.json", "app.ast_demo.add", "2", "3"]);

const tmpDir = path.join("tmp");
fs.mkdirSync(tmpDir, { recursive: true });
const patchedMedian = path.join(tmpDir, "median_patch.lx");
fs.copyFileSync("examples/median.lx", patchedMedian);
runCommand("node", [cliPath, "patch-body", patchedMedian, "app.stats.median", "examples/patches/median_body.lxsnip"]);
runCommand("node", [cliPath, "check", patchedMedian]);
fs.unlinkSync(patchedMedian);

runExpectFailure(
  "Expected contract failure when clamp is called with min > max",
  "node",
  [cliPath, "run", "examples/contracts.lx", "app.contracts.clamp", "0", "5", "3"],
);

runExpectFailure(
  "Expected type checker failure for incorrect return type",
  "node",
  [cliPath, "check", "examples/type_error.lx"],
);

runExpectFailure(
  "Expected type checker failure for hole expressions",
  "node",
  [cliPath, "check", "examples/hole_example.lx"],
);
