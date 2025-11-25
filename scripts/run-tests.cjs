#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const cliPath = path.join("dist", "cli.js");

function runCommand(command, args) {
  process.stdout.write(`Running: ${command} ${args.join(" ")} ... `);
  const result = spawnSync(command, args, { stdio: "pipe" });
  if (result.status !== 0) {
    console.log("❌ FAIL");
    console.log(result.stdout.toString());
    console.error(result.stderr.toString());
    process.exit(result.status ?? 1);
  }
  console.log("✅ PASS");
}

function runExpectFailure(description, command, args) {
  process.stdout.write(`Running negative test: ${description} ... `);
  const result = spawnSync(command, args, { stdio: "pipe" });
  if (result.status === 0) {
    console.log("❌ FAIL (Unexpected Success)");
    console.log(result.stdout.toString());
    process.exit(1);
  }
  console.log("✅ PASS (Expected Failure)");
}

runCommand("node", [cliPath, "test", "examples/median.lx"]);
runCommand("node", [cliPath, "test", "examples/logging.lx"]);
runCommand("node", [cliPath, "test", "examples/contracts.lx"]);
runCommand("node", [cliPath, "test", "examples/builtins.lx"]);
runCommand("node", [cliPath, "test", "examples/parallel.lx"]);
runCommand("node", [cliPath, "test", "examples/property_basics.lx"]);
runCommand("node", [cliPath, "test", "--seed=42", "examples/property_deterministic.lx"]);
runCommand("node", [cliPath, "test", "examples/comments.lx"]);
runCommand("node", [cliPath, "test", "examples/let_annotations.lx"]);
runCommand("node", [cliPath, "test", "examples/actor_basic.lx"]);
runCommand("node", [cliPath, "test", "examples/actor_async_group.lx"]);
runCommand("node", [cliPath, "test", "--scheduler=deterministic", "examples/actor_scheduler.lx"]);
runCommand("node", [cliPath, "test", "examples/actor_supervision.lx"]);
runCommand("node", [cliPath, "test", "examples/refactor_sample.lx"]);
runCommand("node", [cliPath, "test", "examples/alias_test.lx"]);
runCommand("node", [cliPath, "test", "examples/active_comments.lx"]);
runCommand("node", [cliPath, "active-comments", "--format=json", "examples/active_comments.lx"]);
runCommand("node", [cliPath, "test", "--input=ast", "examples/ast_demo.json"]);
runCommand("node", [cliPath, "run", "--input=ast", "examples/ast_demo.json", "app.ast_demo.add", "2", "3"]);

const tmpDir = path.join("tmp");
fs.mkdirSync(tmpDir, { recursive: true });
const patchedMedian = path.join(tmpDir, "median_patch.lx");
fs.copyFileSync("examples/median.lx", patchedMedian);
runCommand("node", [cliPath, "patch-body", patchedMedian, "app.stats.median", "examples/patches/median_body.lxsnip"]);
runCommand("node", [cliPath, "check", patchedMedian]);
fs.unlinkSync(patchedMedian);
const refactorTarget = path.join(tmpDir, "refactor_sample.lx");
fs.copyFileSync("examples/refactor_sample.lx", refactorTarget);
runCommand("node", [cliPath, "apply-refactor", refactorTarget, "rename_email_entities"]);
runCommand("node", [cliPath, "check", refactorTarget]);
fs.unlinkSync(refactorTarget);

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
  "Expected type checker failure for mismatched let annotations",
  "node",
  [cliPath, "check", "examples/let_annotation_type_error.lx"],
);

runExpectFailure(
  "Expected type checker failure for hole expressions",
  "node",
  [cliPath, "check", "examples/hole_example.lx"],
);

runExpectFailure(
  "Expected type checker failure for mismatched actor message parameter types",
  "node",
  [cliPath, "check", "examples/actor_type_error.lx"],
);
runExpectFailure(
  "Expected type checker failure for incorrect async task usage",
  "node",
  [cliPath, "check", "examples/async_group_type_error.lx"],
);
runExpectFailure(
  "Expected type checker failure when parallel primitives receive effectful functions",
  "node",
  [cliPath, "check", "examples/parallel_type_error.lx"],
);

runExpectFailure(
  "Expected doc spec validation failure for mismatched parameter names",
  "node",
  [cliPath, "check", "examples/docspec_error.lx"],
);

runExpectFailure(
  "Expected runtime failure when an actor crashes without supervision",
  "node",
  [cliPath, "test", "examples/actor_supervision_error.lx"],
);
