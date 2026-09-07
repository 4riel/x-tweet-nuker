/**
 * Resumable run state.
 *
 * A full account wipe takes hours and will be interrupted - by a rate limit that outlasts your
 * patience, a reboot, or an OS low-memory killer. Every tweet id that has been dealt with is
 * recorded so the next run skips it instead of re-issuing thousands of pointless deletes.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { UserError } = require("./errors");

const SAVE_INTERVAL_MS = 5000;

/**
 * How long a lock left by a process on ANOTHER machine (a shared data directory) stays
 * believable. It has to outlast the longest legitimate gap between two saves - a run can sit in
 * escalating rate-limit waits for the better part of an hour without writing anything - so this
 * is deliberately generous. Locks from this machine are settled by pid instead, not by time.
 */
const LOCK_STALE_MS = 90 * 60 * 1000;

function emptyState() {
  return { done: [], gone: [], failed: [], startedAt: new Date().toISOString(), updatedAt: null };
}

function readLock(lockFile) {
  try {
    return JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch (e) {
    return null;
  }
}

/** EPERM means the pid exists but belongs to another user - still alive. */
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e) && e.code === "EPERM";
  }
}

function lockIsStale(lock) {
  if (!lock || !lock.pid) return true;
  // On this machine the pid settles it: alive means a real run still owns the state file, even
  // if it has been silent for an hour riding out a rate limit; gone means Ctrl-C or a crash.
  if (lock.host === os.hostname()) return !processIsAlive(lock.pid);
  // Another machine's process cannot be probed, so fall back to how long it has been quiet.
  const stamp = Date.parse(lock.touchedAt || lock.startedAt || "");
  if (!Number.isFinite(stamp)) return true;
  return Date.now() - stamp > LOCK_STALE_MS;
}

/**
 * Advisory lock around the state file.
 *
 * Running `nuke` in one terminal and `sweep` in another, in the same data directory, is an easy
 * mistake to make: both hold the whole state in memory and each save overwrites the other, so the
 * loser's progress silently disappears and thousands of already-deleted ids get retried. The lock
 * is refreshed on every save, released on exit, and can be taken over once it goes stale.
 */
function acquireStateLock(file, logger) {
  const lockFile = file + ".lock";
  const me = { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() };
  const existing = readLock(lockFile);
  const isMine = Boolean(existing) && existing.pid === me.pid && existing.host === me.host;

  if (existing && !isMine && !lockIsStale(existing)) {
    throw new UserError(
      "Another x-tweet-nuker run is already using " +
        file +
        " (pid " +
        existing.pid +
        " on " +
        existing.host +
        ", started " +
        (existing.startedAt || "unknown") +
        ").",
      "Two runs sharing one data directory overwrite each other's progress. Wait for that run to " +
        "finish, use a separate --data-dir, or - if that run is definitely gone - delete " +
        lockFile +
        " and try again."
    );
  }
  if (existing && !isMine && logger) {
    logger.warn("Taking over a stale run lock", {
      lockFile,
      pid: existing.pid,
      host: existing.host,
      startedAt: existing.startedAt,
    });
  }

  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const write = (extra) => {
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ ...me, ...extra }));
    } catch (e) {
      // A lock we cannot write is a lock we do without; it must never stop a run.
    }
  };
  write();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const current = readLock(lockFile);
    // Never delete a lock that now belongs to somebody else.
    if (current && (current.pid !== me.pid || current.host !== me.host)) return;
    try {
      fs.unlinkSync(lockFile);
    } catch (e) {
      // Already gone.
    }
  };
  process.on("exit", release);

  return {
    file: lockFile,
    touch: () => write({ touchedAt: new Date().toISOString() }),
    release,
  };
}

/**
 * @param {string} file path to the JSON state file
 * @param {{ lock?: boolean, logger?: object }} [options] lock only for commands that write
 */
function loadState(file, options = {}) {
  const lock = options.lock ? acquireStateLock(file, options.logger) : null;
  let raw = emptyState();
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      raw = {
        done: Array.isArray(parsed.done) ? parsed.done : [],
        gone: Array.isArray(parsed.gone) ? parsed.gone : [],
        failed: Array.isArray(parsed.failed) ? parsed.failed : [],
        startedAt: parsed.startedAt || new Date().toISOString(),
        updatedAt: parsed.updatedAt || null,
      };
    } catch (e) {
      // A corrupt state file must not block a run; the worst case is re-deleting ids that are
      // already gone, which the API reports harmlessly as "not found".
      const backup = file + ".corrupt-" + Date.now();
      try {
        fs.renameSync(file, backup);
      } catch (e2) {
        // ignore
      }
    }
  }

  // A state file written by an older version can contain the same id twice (a tweet that lingered
  // on the timeline after a successful delete gets deleted again). Dedupe on load so the reported
  // counts match reality; `done` wins over `gone` for an id that somehow landed in both.
  const doneSet = new Set(raw.done.map(String));
  const goneSet = new Set(raw.gone.map(String));
  for (const id of doneSet) goneSet.delete(id);
  raw.done = Array.from(doneSet);
  raw.gone = Array.from(goneSet);

  const handled = new Set([...raw.done, ...raw.gone]);

  // Failures are keyed by id rather than appended: the same tweet can fail in round after round,
  // and once it finally succeeds it has to leave the list entirely - otherwise `status` keeps
  // reporting failures that are no longer true and the state file grows for the length of the run.
  const failedById = new Map();
  for (const entry of raw.failed) {
    const id = entry && typeof entry === "object" ? entry.id : entry;
    if (id === undefined || id === null || id === "") continue;
    failedById.set(
      String(id),
      typeof entry === "object"
        ? { ...entry, id: String(id) }
        : { id: String(id), message: "", http: null }
    );
  }
  raw.failed = Array.from(failedById.values());

  let lastSave = 0;

  const state = {
    file,
    data: raw,
    handled,

    /** True when this id has already been deleted or confirmed missing in an earlier run. */
    isHandled(id) {
      return handled.has(id);
    },

    markDeleted(id) {
      failedById.delete(id);
      if (handled.has(id)) return;
      handled.add(id);
      raw.done.push(id);
    },

    markGone(id) {
      failedById.delete(id);
      if (handled.has(id)) return;
      handled.add(id);
      raw.gone.push(id);
    },

    markFailed(id, message, http) {
      failedById.set(id, { id, message: (message || "").slice(0, 200), http: http || null });
    },

    counts() {
      return { deleted: raw.done.length, gone: raw.gone.length, failed: failedById.size };
    },

    save() {
      raw.failed = Array.from(failedById.values());
      raw.updatedAt = new Date().toISOString();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(raw));
      fs.renameSync(tmp, file);
      lastSave = Date.now();
      if (lock) lock.touch();
    },

    /** Give up the advisory lock. Also happens automatically when the process exits. */
    release() {
      if (lock) lock.release();
    },

    /** Cheap call site for hot loops: only actually writes every few seconds. */
    saveThrottled() {
      if (Date.now() - lastSave >= SAVE_INTERVAL_MS) state.save();
    },
  };

  return state;
}

module.exports = { loadState, emptyState, acquireStateLock, LOCK_STALE_MS };
