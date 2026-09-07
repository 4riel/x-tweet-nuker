"use strict";
/**
 * bin/cli.js argument parsing, exercised end-to-end via a child process: every invocation either
 * short-circuits before any command runs (--help, --version, a parse/config error) or uses the
 * fully offline `status` command with an isolated --data-dir - never `run`/`nuke`/`sweep`/
 * `login`/`verify`, which would touch the network or a real browser.
 *
 * The file is also required directly (it only runs a command when it is the process entry point)
 * so the flag tables help prints can be compared against the flags the parser actually accepts.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const pkg = require("../package.json");
const { makeTmpDirs } = require("./helpers/tmp");

const CLI = path.resolve(__dirname, "..", "bin", "cli.js");

const tmp = makeTmpDirs("xtn-cli-");
function tmpDir() {
  return tmp.create();
}

test.after(() => tmp.cleanup());

function run(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd: tmpDir(), // never the repo root: cwd is the data-dir default when --data-dir is omitted
    timeout: 15000,
  });
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

test("--help with no command prints usage and exits 0", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage/);
  assert.match(r.stdout, /Commands/);
});

test("--version prints the package version and exits 0", () => {
  const r = run(["--version"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), pkg.version);
});

test("an unknown command is rejected with a clear message", () => {
  const r = run(["frobnicate"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown command: frobnicate/);
});

test("an unknown flag is rejected rather than silently ignored", () => {
  const r = run(["--this-flag-does-not-exist"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown flag: --this-flag-does-not-exist/);
});

test("--no-<unknown flag> is rejected, not silently accepted as a no-op", () => {
  const r = run(["--no-this-is-not-a-real-flag"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown flag: --no-this-is-not-a-real-flag/);
});

test("a known boolean flag can still be negated (--no-verbose)", () => {
  const r = run(["status", "--no-verbose"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /x-tweet-nuker status/);
});

test("--help on a specific command short-circuits before config/validation runs", () => {
  // --limit=abc would normally be rejected by buildConfig, but --help returns first.
  const r = run(["run", "--limit=abc", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /x-tweet-nuker run -/);
});

test("run --limit abc is rejected before any command executes (no network/browser reached)", () => {
  const r = run(["run", "--limit", "abc", "--data-dir", tmpDir()]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Invalid value for --limit/);
});

test("nuke --limit -5 is rejected before any command executes", () => {
  const r = run(["nuke", "--limit", "-5", "--data-dir", tmpDir()]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Invalid value for --limit/);
});

test("a value flag with no following value is rejected with 'needs a value'", () => {
  const r = run(["run", "--limit"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--limit needs a value/);
});

test("status runs fully offline against an isolated --data-dir and reports no session captured", () => {
  const dataDir = tmpDir();
  const r = run(["status", "--data-dir", dataDir]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /NOT CAPTURED/);
  assert.match(r.stdout, new RegExp(dataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("--archive flag overrides the default archive path shown by status", () => {
  const dataDir = tmpDir();
  const archiveFile = path.join(dataDir, "my-tweets.js");
  fs.writeFileSync(archiveFile, "window.YTD.tweets.part0 = []");
  const r = run(["status", "--data-dir", dataDir, "--archive", archiveFile]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /my-tweets\.js/);
});

// ---------------------------------------------------------------------------
// Help and the parser must describe the same CLI. A flag the parser accepts but help never
// mentions is undiscoverable (`--chrome-executable` was exactly that); a flag help advertises but
// the parser rejects is worse - it is documented advice that errors out when followed.
// bin/cli.js only runs a command when it is the entry point, so it can be required here.
// ---------------------------------------------------------------------------

const cli = require("../bin/cli.js");

/** "--yes, -y" -> ["--yes", "-y"]; "--data-dir <path>" -> ["--data-dir"]. */
function flagTokens(spec) {
  return spec
    .split(",")
    .map((part) => part.trim().split(" ")[0])
    .filter((part) => part.startsWith("-"));
}

function documentedFlags() {
  const documented = new Set();
  for (const spec of Object.keys(cli.GLOBAL_FLAGS)) for (const t of flagTokens(spec)) documented.add(t);
  for (const command of Object.values(cli.COMMANDS)) {
    for (const spec of Object.keys(command.flags || {})) for (const t of flagTokens(spec)) documented.add(t);
  }
  return documented;
}

function acceptedFlags() {
  const accepted = new Set();
  for (const name of [...cli.VALUE_FLAGS, ...cli.BOOLEAN_FLAGS]) {
    accepted.add((name.length === 1 ? "-" : "--") + name);
  }
  return accepted;
}

test("every flag the parser accepts is documented in --help somewhere", () => {
  const documented = documentedFlags();
  const undocumented = [...acceptedFlags()].filter((flag) => !documented.has(flag));
  assert.deepEqual(undocumented, [], "accepted but never shown in help: " + undocumented.join(", "));
});

test("every flag --help advertises is actually accepted by the parser", () => {
  const accepted = acceptedFlags();
  const phantom = [...documentedFlags()].filter((flag) => !accepted.has(flag));
  assert.deepEqual(phantom, [], "advertised in help but rejected by the parser: " + phantom.join(", "));
});

test("--chrome-executable is both accepted and shown in the top-level help", () => {
  const r = run(["--help"]);
  assert.match(r.stdout, /--chrome-executable/);
  const status = run(["status", "--chrome-executable", "C:/nowhere/chrome.exe"]);
  assert.equal(status.status, 0);
});

test("every command's own --help lists that command's flags", () => {
  for (const [name, command] of Object.entries(cli.COMMANDS)) {
    const r = run([name, "--help"]);
    assert.equal(r.status, 0, name + " --help should exit 0");
    for (const spec of Object.keys(command.flags || {})) {
      const token = flagTokens(spec)[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(r.stdout, new RegExp(token), name + " --help must list " + spec);
    }
  }
});

test("help does not offer `npx x-tweet-nuker` as a way to run this - the package is not on npm", () => {
  const r = run(["--help"]);
  // No usage/step line starts with it. (Help does mention it once, to say it will not work.)
  assert.equal(/^\s*(\d+\.\s*)?npx x-tweet-nuker/m.test(r.stdout), false);
  assert.match(r.stdout, /not published on npm/);
  // ...and it tells the reader what to run instead.
  assert.match(r.stdout, /node bin\/cli\.js <command>/);
});

// ---------------------------------------------------------------------------
// --max-rounds: rejected at the boundary, before any command can run.
// ---------------------------------------------------------------------------

test("sweep --max-rounds 0 is rejected before anything runs, not silently defaulted to 30", () => {
  const r = run(["sweep", "--max-rounds", "0", "--data-dir", tmpDir()]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Invalid value for --max-rounds/);
  assert.match(r.stderr, /1 or more/);
});
