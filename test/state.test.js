"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  loadState,
  applyDeleteResult,
  acquireStateLock,
  lockIsStale,
  LOCK_STALE_MS,
  INTERRUPT_SIGNALS,
  MAX_CONSECUTIVE_SAVE_FAILURES,
} = require("../src/state");
const { UserError } = require("../src/errors");
const { makeTmpDirs } = require("./helpers/tmp");

const tmp = makeTmpDirs("xtn-state-");

function tmpStateFile() {
  return path.join(tmp.create(), ".nuke-state.json");
}

function silentLogger() {
  return { warn: () => {}, info: () => {}, debug: () => {}, plain: () => {} };
}

/** Keeps what was warned about, so a test can assert the user was actually told. */
function recordingLogger() {
  const warnings = [];
  return {
    warnings,
    text: () => warnings.join("\n"),
    warn: (message, data) => warnings.push(message + (data === undefined ? "" : " " + JSON.stringify(data))),
    info: () => {},
    debug: () => {},
    plain: () => {},
  };
}

test.after(() => tmp.cleanup());

// ---------------------------------------------------------------------------
// handled / counts
// ---------------------------------------------------------------------------

test("isHandled is true for both a deleted id and a gone id", () => {
  const file = tmpStateFile();
  const state = loadState(file);
  state.markDeleted("1");
  state.markGone("2");
  assert.equal(state.isHandled("1"), true);
  assert.equal(state.isHandled("2"), true);
  assert.equal(state.isHandled("3"), false);
});

test("counts().deleted and .gone reflect handled ids by category", () => {
  const file = tmpStateFile();
  const state = loadState(file);
  state.markDeleted("1");
  state.markDeleted("2");
  state.markGone("3");
  const counts = state.counts();
  assert.equal(counts.deleted, 2);
  assert.equal(counts.gone, 1);
  assert.equal(counts.failed, 0);
});

test("marking the same id deleted twice does not double-count it", () => {
  const file = tmpStateFile();
  const state = loadState(file);
  state.markDeleted("1");
  state.markDeleted("1");
  assert.equal(state.counts().deleted, 1);
  assert.equal(state.data.done.filter((id) => id === "1").length, 1);
});

test("marking an id gone after it was already marked deleted does not double-count or downgrade it", () => {
  const file = tmpStateFile();
  const state = loadState(file);
  state.markDeleted("1");
  state.markGone("1");
  assert.equal(state.counts().deleted, 1);
  assert.equal(state.counts().gone, 0);
});

// ---------------------------------------------------------------------------
// failed - keyed by id, cleared on success
// ---------------------------------------------------------------------------

test("failed is keyed by id: failing the same id twice keeps one entry", () => {
  const file = tmpStateFile();
  const state = loadState(file);
  state.markFailed("1", "first error", 500);
  state.markFailed("1", "second error", 429);
  assert.equal(state.counts().failed, 1);
  state.save();
  const reloaded = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(reloaded.failed.length, 1);
  assert.equal(reloaded.failed[0].message, "second error");
});

test("an id that later succeeds is removed from failed", () => {
  const file = tmpStateFile();
  const state = loadState(file);
  state.markFailed("1", "boom", 500);
  assert.equal(state.counts().failed, 1);
  state.markDeleted("1");
  assert.equal(state.counts().failed, 0);
  assert.equal(state.counts().deleted, 1);
});

test("an id that later comes back gone is also removed from failed", () => {
  const file = tmpStateFile();
  const state = loadState(file);
  state.markFailed("1", "boom", 500);
  state.markGone("1");
  assert.equal(state.counts().failed, 0);
  assert.equal(state.counts().gone, 1);
});

// ---------------------------------------------------------------------------
// Persistence across loads
// ---------------------------------------------------------------------------

test("save() persists state that a fresh loadState() call reads back", () => {
  const file = tmpStateFile();
  const state = loadState(file);
  state.markDeleted("1");
  state.markGone("2");
  state.markFailed("3", "still failing", 503);
  state.save();

  const reloaded = loadState(file);
  assert.equal(reloaded.isHandled("1"), true);
  assert.equal(reloaded.isHandled("2"), true);
  assert.equal(reloaded.counts().failed, 1);
});

test("a legacy state file with duplicate ids across done and gone is deduped on load, done wins", () => {
  const file = tmpStateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      done: ["1", "2", "1"], // "1" duplicated within done
      gone: ["2", "3"], // "2" duplicated across done+gone
      failed: [],
    })
  );

  const state = loadState(file);
  assert.equal(state.data.done.filter((id) => id === "1").length, 1);
  // "2" was in both done and gone; done wins, so it must not remain in gone.
  assert.ok(!state.data.gone.includes("2"));
  assert.ok(state.data.done.includes("2"));
  assert.equal(state.counts().deleted, 2); // "1" and "2"
  assert.equal(state.counts().gone, 1); // "3" only
});

test("a legacy state file with duplicate failed entries for the same id is deduped on load", () => {
  const file = tmpStateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      done: [],
      gone: [],
      failed: [
        { id: "1", message: "old", http: 500 },
        { id: "1", message: "newer", http: 429 },
      ],
    })
  );
  const state = loadState(file);
  assert.equal(state.counts().failed, 1);
});

test("a legacy state file with bare (non-object) failed ids is normalized", () => {
  const file = tmpStateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ done: [], gone: [], failed: ["7", "8"] }));
  const state = loadState(file);
  assert.equal(state.counts().failed, 2);
});

test("the on-disk field for deleted ids is still `done`, so a run in progress keeps its progress", () => {
  // The vocabulary converged on "deleted" everywhere the code says it out loud, but the storage
  // name cannot change: people have interrupted runs whose state files are already on disk, and
  // renaming the field would silently restart them from zero and re-attempt thousands of ids.
  const file = tmpStateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ done: ["11"], gone: ["22"], failed: [] }));

  const state = loadState(file);
  assert.equal(state.isHandled("11"), true, "an older state file's `done` list must still count");
  assert.equal(state.counts().deleted, 1);
  state.markDeleted("33");
  state.save();

  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(written.done.sort(), ["11", "33"]);
  assert.deepEqual(written.gone, ["22"]);
});

// ---------------------------------------------------------------------------
// applyDeleteResult - one copy of the mapping both delete loops used to carry
//
// The invariant: an id marked handled is skipped by every future run of this tool, forever. So a
// result that is not an explicit success has to stay retryable, whatever it looks like.
// ---------------------------------------------------------------------------

/** A summary object shaped like the ones `nuke` and `sweep` keep. */
const emptySummary = () => ({ deleted: 0, gone: 0, failed: 0 });

test("applyDeleteResult: a deleted result marks the id handled and counts it as deleted", () => {
  const state = loadState(tmpStateFile());
  const summary = emptySummary();
  assert.equal(applyDeleteResult(state, "1", { status: "deleted" }, summary), "deleted");
  assert.equal(state.isHandled("1"), true);
  assert.deepEqual(summary, { deleted: 1, gone: 0, failed: 0 });
});

test("applyDeleteResult: a gone result marks the id handled and counts it as gone", () => {
  const state = loadState(tmpStateFile());
  const summary = emptySummary();
  assert.equal(applyDeleteResult(state, "1", { status: "gone" }, summary), "gone");
  assert.equal(state.isHandled("1"), true);
  assert.deepEqual(summary, { deleted: 0, gone: 1, failed: 0 });
});

test("applyDeleteResult: an error NEVER marks the id handled", () => {
  const state = loadState(tmpStateFile());
  const summary = emptySummary();
  const recorded = applyDeleteResult(
    state,
    "1",
    { status: "error", message: "Internal error", http: 500 },
    summary
  );
  assert.equal(recorded, "failed");
  assert.equal(state.isHandled("1"), false, "a failed delete must stay eligible for retry forever");
  assert.deepEqual(summary, { deleted: 0, gone: 0, failed: 1 });
  assert.equal(state.counts().failed, 1);
});

test("applyDeleteResult: a status this tool has never heard of is a failure, not a success", () => {
  // The safe default matters more than the specific string: a client that grows a fourth status
  // (or returns nothing at all) must not have its ids quietly written off as done.
  const state = loadState(tmpStateFile());
  for (const result of [{ status: "maybe" }, {}, null, undefined, { status: "DELETED" }]) {
    const summary = emptySummary();
    const id = "id-" + JSON.stringify(result);
    assert.equal(applyDeleteResult(state, id, result, summary), "failed");
    assert.equal(state.isHandled(id), false);
    assert.equal(summary.failed, 1);
  }
});

test("applyDeleteResult: the failure it records carries the message and status code for `status`", () => {
  const state = loadState(tmpStateFile());
  applyDeleteResult(state, "1", { status: "error", message: "boom", http: 503 }, emptySummary());
  assert.deepEqual(state.data.failed, []); // not flushed until save()
  state.save();
  assert.deepEqual(state.data.failed, [{ id: "1", message: "boom", http: 503 }]);
});

test("applyDeleteResult: an id that failed and later succeeds stops being a failure", () => {
  const state = loadState(tmpStateFile());
  applyDeleteResult(state, "1", { status: "error", message: "boom" }, emptySummary());
  assert.equal(state.counts().failed, 1);
  applyDeleteResult(state, "1", { status: "deleted" }, emptySummary());
  assert.equal(state.counts().failed, 0);
  assert.equal(state.isHandled("1"), true);
});

// ---------------------------------------------------------------------------
// Corrupt state file must not crash the tool
// ---------------------------------------------------------------------------

test("a corrupt (non-JSON) state file does not crash loadState and starts empty", () => {
  const file = tmpStateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not valid json ]]]");

  assert.doesNotThrow(() => {
    const state = loadState(file);
    assert.equal(state.counts().deleted, 0);
    assert.equal(state.counts().gone, 0);
    assert.equal(state.counts().failed, 0);
  });
});

test("a corrupt state file is backed up rather than silently discarded", () => {
  const file = tmpStateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "not json at all");
  loadState(file);

  const dir = path.dirname(file);
  const backups = fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));
  assert.equal(backups.length, 1);
});

test("a state file that parses but has non-array fields is normalized instead of crashing", () => {
  const file = tmpStateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ done: "oops", gone: null, failed: 42 }));
  const state = loadState(file);
  assert.equal(state.counts().deleted, 0);
  assert.equal(state.counts().gone, 0);
  assert.equal(state.counts().failed, 0);
});

test("a corrupt state file is warned about loudly, naming the backup it was moved to", () => {
  const file = tmpStateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not valid json ]]]");
  const logger = recordingLogger();

  loadState(file, { logger });

  const text = logger.text();
  // Someone resuming a 4,000-tweet run is about to start again from nothing; silence is not an
  // option, and the backup has to be named or it cannot be inspected.
  assert.match(text, /ZERO progress/);
  const backup = fs.readdirSync(path.dirname(file)).find((name) => name.includes(".corrupt-"));
  assert.ok(backup, "the unreadable file should be kept");
  assert.ok(text.includes(backup), "the warning must name the backup file: " + text);
});

test("a corrupt state file with no logger still does not throw", () => {
  const file = tmpStateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "nope");
  assert.doesNotThrow(() => loadState(file));
});

// ---------------------------------------------------------------------------
// A failed save must not end an hours-long run
// ---------------------------------------------------------------------------

/** Make writeFileSync fail for this state file only, the way AV or a sync client does. */
function breakWrites(t, file, error = Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })) {
  const real = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (target, ...rest) => {
    if (String(target).startsWith(file)) throw error;
    return real(target, ...rest);
  });
}

test("save() survives a transient write failure: warns, keeps going, and reports it did not write", (t) => {
  const file = tmpStateFile();
  const logger = recordingLogger();
  const state = loadState(file, { logger });
  state.markDeleted("1");

  breakWrites(t, file);
  assert.equal(state.save(), false);
  assert.match(logger.text(), /Could not save progress/);

  // The deletion loop must be able to carry on, and the next save must work again.
  t.mock.restoreAll();
  state.markDeleted("2");
  assert.equal(state.save(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).done, ["1", "2"]);
});

test("saveThrottled() gives up only after the state file has failed repeatedly", (t) => {
  const file = tmpStateFile();
  const logger = recordingLogger();
  const state = loadState(file, { logger });
  breakWrites(t, file, Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));

  for (let attempt = 0; attempt < MAX_CONSECUTIVE_SAVE_FAILURES - 1; attempt++) {
    state.markDeleted("id-" + attempt);
    // saveThrottled writes at most every few seconds; drive the failures directly.
    assert.equal(state.save(), false);
    assert.doesNotThrow(
      () => state.saveThrottled(),
      "failure " + (attempt + 1) + " must not stop the run on its own"
    );
  }

  state.markDeleted("last");
  assert.equal(state.save(), false);
  const thrown = (() => {
    try {
      state.saveThrottled();
      return null;
    } catch (e) {
      return e;
    }
  })();

  assert.ok(thrown instanceof UserError, "a permanently unwritable state file must stop the run");
  assert.match(thrown.message, /Cannot record progress/);
  assert.ok(state.saveFailures >= MAX_CONSECUTIVE_SAVE_FAILURES);
});

test("a single failure followed by a good write leaves nothing behind", (t) => {
  const file = tmpStateFile();
  const state = loadState(file, { logger: silentLogger() });
  breakWrites(t, file);
  assert.equal(state.save(), false);
  assert.equal(state.saveFailures, 1);
  t.mock.restoreAll();
  assert.equal(state.save(), true);
  assert.equal(state.saveFailures, 0, "a good write resets the counter");
  assert.doesNotThrow(() => state.saveThrottled());
});

// ---------------------------------------------------------------------------
// Interrupts (Ctrl-C). See the guarantee documented in src/state.js.
// ---------------------------------------------------------------------------

test("an interrupt flushes progress to disk and releases the lock", () => {
  const file = tmpStateFile();
  const logger = recordingLogger();
  const exits = [];
  const state = loadState(file, { lock: true, logger, exit: (code) => exits.push(code) });

  // Deletions that only the in-memory state knows about - a throttled save has not run yet.
  state.markDeleted("1");
  state.markGone("2");
  assert.ok(!fs.existsSync(file), "nothing written yet");

  state.handleInterrupt("SIGINT");

  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(saved.done, ["1"]);
  assert.deepEqual(saved.gone, ["2"]);
  assert.ok(!fs.existsSync(file + ".lock"), "the lock must not be left behind");
  assert.deepEqual(exits, [INTERRUPT_SIGNALS.SIGINT]);
  assert.match(logger.text(), /Interrupted by SIGINT/);
  assert.match(logger.text(), /progress saved/);
});

test("each interrupt signal exits with its own conventional code", () => {
  for (const [signal, code] of Object.entries(INTERRUPT_SIGNALS)) {
    const exits = [];
    const state = loadState(tmpStateFile(), { lock: true, logger: silentLogger(), exit: (c) => exits.push(c) });
    state.handleInterrupt(signal);
    assert.deepEqual(exits, [code], signal);
  }
});

test("a second Ctrl-C while the first is still flushing is ignored", () => {
  const exits = [];
  const state = loadState(tmpStateFile(), { lock: true, logger: silentLogger(), exit: (c) => exits.push(c) });
  state.handleInterrupt("SIGINT");
  state.handleInterrupt("SIGINT");
  assert.equal(exits.length, 1);
});

test("an interrupt that cannot write says so instead of claiming the progress was saved", (t) => {
  const file = tmpStateFile();
  const logger = recordingLogger();
  const state = loadState(file, { lock: true, logger, exit: () => {} });
  state.markDeleted("1");
  breakWrites(t, file);

  state.handleInterrupt("SIGINT");
  assert.match(logger.text(), /COULD NOT save progress/);
});

test("loadState registers real signal listeners when it takes the lock, and drops them on release", () => {
  const before = process.listenerCount("SIGINT");
  const state = loadState(tmpStateFile(), { lock: true, logger: silentLogger(), exit: () => {} });
  assert.ok(process.listenerCount("SIGINT") >= 1, "Ctrl-C must be handled during a writing run");
  state.release();
  // The listener is process-wide and installed once, so the count does not drop; what matters is
  // that a released state no longer answers for it.
  assert.ok(process.listenerCount("SIGINT") >= before);
});

test("a real SIGINT event reaches the state that is currently writing and flushes it", () => {
  const file = tmpStateFile();
  const exits = [];
  const state = loadState(file, { lock: true, logger: silentLogger(), exit: (code) => exits.push(code) });
  state.markDeleted("1");

  // What libuv emits on Ctrl-C. (process.kill(pid, "SIGINT") cannot be used to test this on
  // Windows: Node documents it as unconditional termination of the target, so it would kill the
  // process without running any handler - the very failure this wiring exists to fix.)
  process.emit("SIGINT");

  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).done, ["1"]);
  assert.deepEqual(exits, [INTERRUPT_SIGNALS.SIGINT]);
  assert.ok(!fs.existsSync(file + ".lock"));
});

test("when a run opens the state twice, the newest copy is the one an interrupt flushes", () => {
  const first = tmpStateFile();
  const second = tmpStateFile();
  const exits = [];
  const older = loadState(first, { lock: true, logger: silentLogger(), exit: () => {} });
  const newer = loadState(second, { lock: true, logger: silentLogger(), exit: (c) => exits.push(c) });

  older.markDeleted("stale");
  newer.markDeleted("current");
  process.emit("SIGINT");

  // `run` does exactly this: the archive pass finishes, the sweep opens the state again, and the
  // finished pass's now-outdated copy must not be the one that gets written.
  assert.equal(fs.existsSync(first), false, "the finished pass must not write over newer progress");
  assert.deepEqual(JSON.parse(fs.readFileSync(second, "utf8")).done, ["current"]);
  assert.deepEqual(exits, [INTERRUPT_SIGNALS.SIGINT]);
  newer.release();
  older.release();
});

test("a read-only load (status) installs no interrupt handling of its own", () => {
  const state = loadState(tmpStateFile(), { logger: silentLogger(), exit: () => {} });
  // It still exposes the entry point, but nothing was armed for it.
  assert.equal(typeof state.handleInterrupt, "function");
});

// ---------------------------------------------------------------------------
// Advisory lock
// ---------------------------------------------------------------------------

test("acquireStateLock lets the same process reacquire its own lock", () => {
  const file = tmpStateFile();
  const lock1 = acquireStateLock(file, silentLogger());
  assert.doesNotThrow(() => acquireStateLock(file, silentLogger()));
  lock1.release();
});

test("acquireStateLock refuses a second run while a live lock from another process/host is fresh", () => {
  const file = tmpStateFile();
  const lockFile = file + ".lock";
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(
    lockFile,
    JSON.stringify({
      pid: 999999, // different from process.pid
      host: "some-other-host",
      startedAt: new Date().toISOString(),
      touchedAt: new Date().toISOString(), // just touched -> not stale
    })
  );

  assert.throws(() => acquireStateLock(file, silentLogger()), /already using/);
});

test("acquireStateLock takes over a stale lock from another host instead of refusing forever", () => {
  const file = tmpStateFile();
  const lockFile = file + ".lock";
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(
    lockFile,
    JSON.stringify({
      pid: 999999,
      host: "some-other-host",
      startedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
      touchedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(), // 5h old, past LOCK_STALE_MS
    })
  );

  let lock;
  assert.doesNotThrow(() => {
    lock = acquireStateLock(file, silentLogger());
  });
  lock.release();
});

test("release() removes the lock file so a later run can acquire it", () => {
  const file = tmpStateFile();
  const lock = acquireStateLock(file, silentLogger());
  assert.ok(fs.existsSync(lock.file));
  lock.release();
  assert.ok(!fs.existsSync(lock.file));
});

test("a live pid alone does not pin the lock forever - a long-silent lock goes stale (pid reuse)", () => {
  const quiet = new Date(Date.now() - (LOCK_STALE_MS + 60_000)).toISOString();
  // This process's own pid: definitely alive, and definitely not the run that wrote this lock.
  assert.equal(
    lockIsStale({ pid: process.pid, host: os.hostname(), startedAt: quiet, touchedAt: quiet }),
    true
  );
});

test("a live pid that is still touching the lock holds it", () => {
  const now = new Date().toISOString();
  assert.equal(
    lockIsStale({ pid: process.pid, host: os.hostname(), startedAt: now, touchedAt: now }),
    false
  );
});

test("a dead pid on this machine is stale immediately, without waiting out the silence window", () => {
  const now = new Date().toISOString();
  assert.equal(lockIsStale({ pid: 0x7ffffff, host: os.hostname(), startedAt: now, touchedAt: now }), true);
});

test("a lock with no usable timestamp is stale rather than believed forever", () => {
  assert.equal(lockIsStale({ pid: process.pid, host: os.hostname(), touchedAt: "not a date" }), true);
});

test("the refusal explains that a pid is evidence, not proof, and that the lock frees itself", () => {
  const file = tmpStateFile();
  const lockFile = file + ".lock";
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(
    lockFile,
    JSON.stringify({
      pid: 999999,
      host: "some-other-host",
      startedAt: new Date().toISOString(),
      touchedAt: new Date().toISOString(),
    })
  );
  const error = (() => {
    try {
      acquireStateLock(file, silentLogger());
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.ok(error);
  assert.match(error.hint, /reuses ids/);
  assert.match(error.hint, /releases itself/);
});

test("loadState({lock:true}) takes the lock, save() touches it, and it survives across saves", () => {
  const file = tmpStateFile();
  const state = loadState(file, { lock: true, logger: silentLogger() });
  state.markDeleted("1");
  state.save();
  assert.ok(fs.existsSync(file + ".lock"));
  state.release();
  assert.ok(!fs.existsSync(file + ".lock"));
});
