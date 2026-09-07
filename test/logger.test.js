"use strict";
/**
 * The logger is the first thing every command builds, so it is the first thing a bad --data-dir,
 * a read-only volume or a full disk hits - before any command has run and before there is any
 * context to put in an error message. It used to throw a raw Node stack out of that.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createLogger, createRateWindow, PROGRESS_EVERY } = require("../src/logger");
const { UserError } = require("../src/errors");
const { makeTmpDirs } = require("./helpers/tmp");

const tmp = makeTmpDirs("xtn-logger-");
test.after(() => tmp.cleanup());

test("a log path whose parent cannot be created fails as an actionable UserError, not a stack trace", () => {
  const dir = tmp.create();
  // A file where a directory needs to be: mkdirSync gives ENOTDIR/EEXIST, the same class of
  // failure as a permission denial or a full disk.
  const blocker = path.join(dir, "not-a-directory");
  fs.writeFileSync(blocker, "i am a file");

  const error = (() => {
    try {
      createLogger({ logFile: path.join(blocker, "nested", "x-tweet-nuker.log") });
      return null;
    } catch (e) {
      return e;
    }
  })();

  assert.ok(error instanceof UserError, "expected a UserError, got " + error);
  assert.match(error.message, /Cannot create the directory for the log file/);
  assert.match(error.message, /not-a-directory/, "the failing path must be named");
  assert.ok(error.hint, "and it must say what to do about it");
  assert.match(error.hint, /--data-dir/);
});

test("a usable log path creates the directory and writes lines to it", () => {
  const file = path.join(tmp.create(), "nested", "run.log");
  const logger = createLogger({ logFile: file });
  logger.info("hello", { a: 1 });
  logger.warn("careful");
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /hello \{"a":1\}/);
  assert.match(text, /WARN careful/);
});

test("a log file that cannot be appended to never takes a deletion run down", (t) => {
  const file = path.join(tmp.create(), "run.log");
  const logger = createLogger({ logFile: file });
  t.mock.method(fs, "appendFileSync", () => {
    throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
  });
  assert.doesNotThrow(() => logger.info("still running"));
});

test("no log file configured means no directory work at all", () => {
  assert.doesNotThrow(() => createLogger({ logFile: null }));
  assert.doesNotThrow(() => createLogger({}));
});

test("debug output is suppressed unless verbose is set", () => {
  const file = path.join(tmp.create(), "run.log");
  const quiet = createLogger({ logFile: file });
  quiet.debug("noise");
  assert.equal(fs.existsSync(file), false);

  const loud = createLogger({ logFile: file, verbose: true });
  loud.debug("detail");
  assert.match(fs.readFileSync(file, "utf8"), /DEBUG detail/);
});

// ---------------------------------------------------------------------------
// createRateWindow - the `rate` figure in a progress line.
//
// A lifetime average is misleading exactly when a user leans in to read it: one rate-limit stall
// drags it down and it never recovers, so the tool reports 30/min while it is doing 90/min. The
// window forgets stalls that have passed. Times are injected, so no test waits for real minutes.
// ---------------------------------------------------------------------------

const MINUTE = 60 * 1000;

test("createRateWindow says nothing until it has seen enough to say something", () => {
  const rate = createRateWindow();
  assert.equal(rate.perMinute(0), null, "no data is not a rate of zero");
  rate.record(0);
  assert.equal(rate.perMinute(1000), null, "one deletion is not a rate either");
});

test("createRateWindow reports the pace of the recent window", () => {
  const rate = createRateWindow();
  // 60 deletions, one per second, over a minute.
  for (let i = 0; i <= 60; i++) rate.record(i * 1000);
  assert.equal(rate.perMinute(60 * 1000), 61);
});

test("a stall that has scrolled out of the window stops dragging the figure down", () => {
  const rate = createRateWindow(5 * MINUTE);
  // A burst, then a 20-minute rate-limit wall, then a fast stretch.
  for (let i = 0; i < 100; i++) rate.record(i * 100);
  const afterStall = 25 * MINUTE;
  for (let i = 0; i <= 60; i++) rate.record(afterStall + i * 1000);

  const now = afterStall + 60 * 1000;
  const windowed = rate.perMinute(now);
  const lifetime = Math.round((161 / now) * 60000); // what the old figure would have said
  assert.equal(windowed, 61);
  assert.ok(lifetime < 10, "the lifetime average really is the misleading one here: " + lifetime);
});

test("a rate window that has gone quiet reports nothing rather than a stale number", () => {
  const rate = createRateWindow(5 * MINUTE);
  for (let i = 0; i < 10; i++) rate.record(i * 1000);
  assert.equal(rate.perMinute(60 * MINUTE), null);
});

test("PROGRESS_EVERY is shared, so both delete loops report at the same interval", () => {
  assert.equal(typeof PROGRESS_EVERY, "number");
  assert.ok(PROGRESS_EVERY > 0);
  const sweep = fs.readFileSync(path.join(__dirname, "..", "src", "commands", "sweep.js"), "utf8");
  const nuke = fs.readFileSync(path.join(__dirname, "..", "src", "commands", "nuke.js"), "utf8");
  for (const [name, source] of [["sweep", sweep], ["nuke", nuke]]) {
    assert.match(source, /% PROGRESS_EVERY === 0/, name + " must log progress on the shared interval");
  }
});
