"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadState, acquireStateLock } = require("../src/state");
const { makeTmpDirs } = require("./helpers/tmp");

const tmp = makeTmpDirs("xtn-state-");

function tmpStateFile() {
  return path.join(tmp.create(), ".nuke-state.json");
}

function silentLogger() {
  return { warn: () => {}, info: () => {}, debug: () => {}, plain: () => {} };
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

test("loadState({lock:true}) takes the lock, save() touches it, and it survives across saves", () => {
  const file = tmpStateFile();
  const state = loadState(file, { lock: true, logger: silentLogger() });
  state.markDeleted("1");
  state.save();
  assert.ok(fs.existsSync(file + ".lock"));
  state.release();
  assert.ok(!fs.existsSync(file + ".lock"));
});
