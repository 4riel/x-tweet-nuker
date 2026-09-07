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

// ---------------------------------------------------------------------------
// The third place a flag has to be registered.
//
// A flag lives in three tables: the parser's known-flag sets in bin/cli.js, the command's own
// `flags` help map, and src/config.js, which is the only one that makes it do anything. The two
// tests above tie the first two together; without this one, a new flag on a destructive command
// can parse cleanly, be advertised in --help, be accepted on the command line - and be silently
// ignored, which on this tool means a `--limit` that does not limit.
// ---------------------------------------------------------------------------

const { buildConfig } = require("../src/config");

/**
 * Flags the CLI answers by itself, before any config exists. These genuinely have nothing to do
 * with buildConfig, and the list is asserted below so it cannot quietly grow.
 */
const CLI_ONLY_FLAGS = ["help", "h", "version"];

/** A value each value-flag can be given that is valid and different from the default. */
const PROBE_VALUES = {
  "data-dir": null, // filled in per-case: it must be a real, distinct directory
  session: "probe-session.json",
  state: "probe-state.json",
  log: "probe.log",
  archive: "probe-tweets.js",
  handle: "probehandle",
  "chrome-executable": "/probe/chrome",
  delay: "1234",
  limit: "7",
  "max-rounds": "9",
  ids: "101,102",
};

function configWith(flags) {
  return JSON.stringify(buildConfig(flags, {}));
}

test("every value flag the parser accepts actually reaches the configuration", () => {
  const base = tmpDir();
  const baseline = configWith({ "data-dir": base });
  const ignored = [];
  for (const name of cli.VALUE_FLAGS) {
    const probe = name === "data-dir" ? tmpDir() : PROBE_VALUES[name];
    assert.ok(probe, "no probe value defined for --" + name + " - add one to PROBE_VALUES");
    const withFlag = configWith({ "data-dir": base, [name]: probe });
    if (withFlag === baseline) ignored.push("--" + name);
  }
  assert.deepEqual(ignored, [], "parsed and documented, but ignored by src/config.js: " + ignored.join(", "));
});

test("every boolean flag the parser accepts either reaches the configuration or is CLI-only", () => {
  const base = tmpDir();
  const baseline = configWith({ "data-dir": base });
  const ignored = [];
  for (const name of cli.BOOLEAN_FLAGS) {
    if (CLI_ONLY_FLAGS.includes(name)) continue;
    if (configWith({ "data-dir": base, [name]: true }) === baseline) ignored.push("--" + name);
  }
  assert.deepEqual(ignored, [], "parsed and documented, but ignored by src/config.js: " + ignored.join(", "));
});

test("the list of flags exempt from the config check is exactly the ones the CLI answers itself", () => {
  // Each of these must short-circuit in bin/cli.js before a command ever runs; if one stops doing
  // that, it belongs in the config check above rather than in the exemption list.
  assert.deepEqual([...CLI_ONLY_FLAGS].sort(), ["h", "help", "version"]);
  assert.equal(run(["--version"]).status, 0);
  assert.equal(run(["--help"]).status, 0);
  assert.equal(run(["-h"]).status, 0);
});

test("help's own arity notation matches how the parser treats each flag", () => {
  // The help maps already encode arity: "--limit <n>" takes a value, "--dry-run" does not. That
  // is derivable, so a flag documented as taking a value while the parser treats it as a boolean
  // (or the reverse) is caught here rather than by a user typing it.
  const specs = [
    ...Object.keys(cli.GLOBAL_FLAGS),
    ...Object.values(cli.COMMANDS).flatMap((command) => Object.keys(command.flags || {})),
  ];
  for (const spec of specs) {
    const takesValue = /<[^>]+>/.test(spec);
    for (const token of flagTokens(spec)) {
      const name = token.replace(/^--?/, "");
      const expected = takesValue ? cli.VALUE_FLAGS : cli.BOOLEAN_FLAGS;
      assert.ok(
        expected.has(name),
        spec + " is documented as " + (takesValue ? "taking a value" : "a boolean") + ", but the parser disagrees"
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Long hints are wrapped. This tool's hints are long on purpose - they explain what to do next
// about something irreversible - and they used to print as one 300-character line.
// ---------------------------------------------------------------------------

test("wrapText breaks on whitespace and keeps every word", () => {
  const text = "one two three four five six seven eight nine ten";
  const wrapped = cli.wrapText(text, 20);
  for (const line of wrapped.split("\n")) assert.ok(line.length <= 20, "too long: " + line);
  assert.equal(wrapped.split("\n").join(" "), text);
});

test("wrapText indents every line it produces, not just the first", () => {
  const wrapped = cli.wrapText("alpha bravo charlie delta echo foxtrot", 20, "  ");
  const lines = wrapped.split("\n");
  assert.ok(lines.length > 1);
  for (const line of lines) {
    assert.match(line, /^ {2}\S/);
    assert.ok(line.length <= 20, "too long: " + line);
  }
});

test("wrapText leaves an unbreakable token (a path, a URL) intact rather than splitting it", () => {
  const url = "https://github.com/4riel/x-tweet-nuker/issues/very/long/path/that/exceeds/the/width";
  const wrapped = cli.wrapText("Report it at " + url + " please", 40);
  assert.ok(wrapped.includes(url), "a URL broken across lines cannot be copied");
});

test("wrapText preserves deliberate line breaks", () => {
  assert.equal(cli.wrapText("one\ntwo", 40), "one\ntwo");
});

test("a long UserError hint is wrapped to a readable width on the way out of the CLI", () => {
  // `nuke` with a session file but no archive: it fails on the archive check, which carries one of
  // the longest hints in the tool, and it does so before anything touches the network.
  const dataDir = tmpDir();
  fs.writeFileSync(
    path.join(dataDir, ".x-session-data.json"),
    JSON.stringify({
      handle: "someone",
      myUserId: "111",
      cookieHeader: "auth_token=x; ct0=y",
      ct0: "y",
      queryIds: { DeleteTweet: "q" },
      timelineUrls: {},
      savedAt: new Date().toISOString(),
    })
  );

  const r = run(["nuke", "--data-dir", dataDir]);
  assert.equal(r.status, 1);

  const lines = r.stderr.split(/\r?\n/);
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  assert.ok(longest <= 80, "a hint line was " + longest + " characters wide: " + r.stderr);
  assert.ok(lines.length > 4, "the hint must actually be spread over several lines");
  // Wrapping must not have eaten or mangled the advice itself.
  const flat = r.stderr.replace(/\s+/g, " ");
  assert.match(flat, /Download your archive from X/);
  assert.match(flat, /run `x-tweet-nuker sweep` instead/);
});

// The npm test script lists every test file explicitly rather than using a glob: Node's own glob
// support in --test landed after Node 20, and Windows shells do not expand globs themselves, so
// `test/*.test.js` silently ran zero files on Windows + Node 20. An explicit list works on every
// shell and every supported Node, but it can drift the moment someone adds a test file - and a
// test file that is never run is worse than no test at all, because it looks like coverage.
test("the npm test script runs every test file in test/", () => {
  const fs = require("fs");
  const pkgPath = path.join(__dirname, "..", "package.json");
  const script = JSON.parse(fs.readFileSync(pkgPath, "utf8")).scripts.test;
  const onDisk = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith(".test.js"))
    .sort();

  const missing = onDisk.filter((f) => !script.includes("test/" + f));
  assert.deepStrictEqual(missing, [], "test files not listed in package.json scripts.test");

  const listed = script.match(/test\/[\w.-]+\.test\.js/g) || [];
  const stale = listed.filter((p) => !fs.existsSync(path.join(__dirname, "..", p)));
  assert.deepStrictEqual(stale, [], "scripts.test lists files that no longer exist");
});
