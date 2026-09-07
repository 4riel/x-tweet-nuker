"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { buildConfig, normalizeHandle, DEFAULTS, FILE_NAMES } = require("../src/config");
const { UserError } = require("../src/errors");
const { makeTmpDirs } = require("./helpers/tmp");

const tmp = makeTmpDirs("xtn-config-");
function tmpDir() {
  return tmp.create();
}

test.after(() => tmp.cleanup());

/** Isolated flags/env pair: always pins data-dir to an empty tmp dir, never the repo root. */
function build(flags = {}, env = {}) {
  const dataDir = flags["data-dir"] || tmpDir();
  return buildConfig({ ...flags, "data-dir": dataDir }, env);
}

// ---------------------------------------------------------------------------
// Precedence: flags > env > defaults
// ---------------------------------------------------------------------------

test("delayMs: flag overrides env overrides default", () => {
  assert.equal(build({ delay: "10" }, { DELETE_DELAY_MS: "20" }).delayMs, 10);
  assert.equal(build({}, { DELETE_DELAY_MS: "20" }).delayMs, 20);
  assert.equal(build({}, {}).delayMs, DEFAULTS.delayMs);
});

test("limit: flag overrides env overrides default (0 = unlimited)", () => {
  assert.equal(build({ limit: "5" }, { LIMIT: "50" }).limit, 5);
  assert.equal(build({}, { LIMIT: "50" }).limit, 50);
  assert.equal(build({}, {}).limit, 0);
});

test("handle: flag overrides env, and is normalized", () => {
  assert.equal(build({ handle: "@FromFlag" }, { X_HANDLE: "fromenv" }).handle, "FromFlag");
  assert.equal(build({}, { X_HANDLE: "@fromenv" }).handle, "fromenv");
});

test("sessionFile/stateFile/logFile/archivePath default inside dataDir but flags override", () => {
  const dataDir = tmpDir();
  const cfg = build({ "data-dir": dataDir });
  assert.equal(cfg.sessionFile, path.resolve(dataDir, FILE_NAMES.session));
  assert.equal(cfg.stateFile, path.resolve(dataDir, FILE_NAMES.state));

  const customSession = path.join(dataDir, "custom-session.json");
  const cfg2 = build({ "data-dir": dataDir, session: customSession });
  assert.equal(cfg2.sessionFile, path.resolve(customSession));
});

// ---------------------------------------------------------------------------
// Invalid numeric values are rejected, never silently downgraded to a default.
// ---------------------------------------------------------------------------

test("--limit abc is rejected, not silently treated as 'unlimited'", () => {
  assert.throws(() => build({ limit: "abc" }), UserError);
});

test("--limit -5 is rejected, not silently treated as 'unlimited'", () => {
  assert.throws(() => build({ limit: "-5" }), UserError);
});

test("--delay abc is rejected", () => {
  assert.throws(() => build({ delay: "abc" }), UserError);
});

test("--delay -1 is rejected", () => {
  assert.throws(() => build({ delay: "-1" }), UserError);
});

test("a non-integer numeric string (e.g. '1.5') is rejected", () => {
  assert.throws(() => build({ limit: "1.5" }), UserError);
});

test("--limit 0 is accepted and means unlimited", () => {
  assert.equal(build({ limit: "0" }).limit, 0);
});

test("env LIMIT=abc is rejected exactly like the flag would be", () => {
  assert.throws(() => build({}, { LIMIT: "abc" }), UserError);
});

// ---------------------------------------------------------------------------
// normalizeHandle
// ---------------------------------------------------------------------------

test("normalizeHandle strips a leading @", () => {
  assert.equal(normalizeHandle("@someone"), "someone");
});

test("normalizeHandle extracts the handle from a profile URL", () => {
  assert.equal(normalizeHandle("https://x.com/someone"), "someone");
  assert.equal(normalizeHandle("https://twitter.com/someone/with_replies"), "someone");
});

test("normalizeHandle returns null for empty input", () => {
  assert.equal(normalizeHandle(""), null);
  assert.equal(normalizeHandle(null), null);
});

// ---------------------------------------------------------------------------
// .env file loading (data-dir scoped, never the repo's real .env)
// ---------------------------------------------------------------------------

test(".env in the data dir supplies values when neither flag nor real env provides one", () => {
  const dataDir = tmpDir();
  fs.writeFileSync(path.join(dataDir, ".env"), "DELETE_DELAY_MS=777\nLIMIT=3\n");
  const cfg = buildConfig({ "data-dir": dataDir }, {});
  assert.equal(cfg.delayMs, 777);
  assert.equal(cfg.limit, 3);
});

test("an already-set env value is not overridden by .env", () => {
  const dataDir = tmpDir();
  fs.writeFileSync(path.join(dataDir, ".env"), "DELETE_DELAY_MS=777\n");
  const cfg = buildConfig({ "data-dir": dataDir }, { DELETE_DELAY_MS: "5" });
  assert.equal(cfg.delayMs, 5);
});

test("a flag still wins over a value the .env file supplies", () => {
  const dataDir = tmpDir();
  fs.writeFileSync(path.join(dataDir, ".env"), "DELETE_DELAY_MS=777\n");
  const cfg = buildConfig({ "data-dir": dataDir, delay: "9" }, {});
  assert.equal(cfg.delayMs, 9);
});

// ---------------------------------------------------------------------------
// --max-rounds has a minimum of 1. A sweep of zero rounds cannot look at anything, so 0 is a
// typo, not a request - and it used to be swallowed and replaced by the default of 30, which is
// the exact silent-fallback failure the numeric validation above exists to prevent.
// ---------------------------------------------------------------------------

test("--max-rounds 0 is rejected, not silently replaced by the default", () => {
  assert.throws(() => build({ "max-rounds": "0" }), UserError);
});

test("--max-rounds 0 is rejected from the environment too", () => {
  assert.throws(() => build({}, { MAX_ROUNDS: "0" }), UserError);
});

test("--max-rounds 1 is accepted and honoured exactly", () => {
  assert.equal(build({ "max-rounds": "1" }).maxRounds, 1);
});

test("--max-rounds abc is rejected", () => {
  assert.throws(() => build({ "max-rounds": "abc" }), UserError);
});

test("--max-rounds falls back to the default only when nothing was given", () => {
  assert.equal(build({}, {}).maxRounds, DEFAULTS.maxRounds);
  assert.equal(build({ "max-rounds": "7" }, { MAX_ROUNDS: "9" }).maxRounds, 7);
  assert.equal(build({}, { MAX_ROUNDS: "9" }).maxRounds, 9);
});

test("the --max-rounds rejection says what the minimum is, rather than just 'invalid'", () => {
  assert.throws(
    () => build({ "max-rounds": "0" }),
    (e) => e instanceof UserError && /1 or more/.test(e.hint || "")
  );
});

// A zero minimum still means zero is a legitimate, honoured value for the options where it has a
// meaning: --limit 0 is "no limit" and --delay 0 is "no pause".
test("--delay 0 is accepted and honoured, not replaced by the default", () => {
  assert.equal(build({ delay: "0" }).delayMs, 0);
});
