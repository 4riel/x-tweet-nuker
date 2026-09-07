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
 * Interrupts that a run should survive gracefully, with the exit code a shell expects for each
 * (128 + signal number). SIGBREAK is Ctrl-Break on Windows; SIGHUP arrives there when the console
 * window is closed.
 */
const INTERRUPT_SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGBREAK: 149 };

/**
 * Consecutive failed writes of the state file before a run stops rather than carries on deleting
 * tweets it can no longer record. One transient EPERM (antivirus or a sync client holding the
 * file) must not kill an hours-long run; a disk that is genuinely full or read-only must not let
 * the run delete thousands more ids it will have to rediscover.
 */
const MAX_CONSECUTIVE_SAVE_FAILURES = 5;

/** The one state object currently answering interrupts in this process. See loadState. */
let signalOwner = null;
let interruptHandlersInstalled = false;

/**
 * One listener per signal for the whole process, installed the first time a run opens the state
 * for writing. Registering a fresh set per state object would pile up listeners (`run` opens the
 * state twice) and trip Node's max-listeners warning; this dispatches to whichever state is
 * currently in charge instead.
 */
function installInterruptHandlers() {
  if (interruptHandlersInstalled) return;
  interruptHandlersInstalled = true;
  for (const signal of Object.keys(INTERRUPT_SIGNALS)) {
    try {
      process.on(signal, () => {
        const owner = signalOwner;
        if (owner) owner.handleInterrupt(signal);
        // Nothing is writing state, so behave like an unhandled signal would have.
        else process.exit(INTERRUPT_SIGNALS[signal]);
      });
    } catch (e) {
      // Not every signal exists on every platform; the ones that do are enough.
    }
  }
}

/**
 * How long a lock left by a process on ANOTHER machine (a shared data directory) stays
 * believable. It has to outlast the longest legitimate gap between two saves - a run can sit in
 * escalating rate-limit waits for the better part of an hour without writing anything (about 75
 * minutes at the default caps) - so this is deliberately generous. It applies to locks from this
 * machine too: a live pid alone is not proof, because pids get recycled.
 */
const LOCK_STALE_MS = 90 * 60 * 1000;

/**
 * The vocabulary, in one place, because this file writes it to disk and three other files read
 * it back:
 *
 *  - deleted : this run asked X to delete the id and X confirmed it. On disk the list is called
 *              `done`, and it keeps that name forever: users have interrupted runs whose state
 *              files are already on disk, and renaming the field would silently restart them
 *              from zero. `done` is the storage name; `deleted` is what it means everywhere else
 *              (markDeleted, counts().deleted, "Deleted so far").
 *  - gone    : X answered that the id no longer exists. Also finished, just not by us.
 *  - handled : deleted OR gone - the union, and the only thing isHandled answers. A handled id is
 *              skipped by every future run forever, which is why a failure must never join it.
 *  - failed  : attempted and neither confirmed deleted nor confirmed gone. Retried next run.
 */
function emptyState() {
  return { done: [], gone: [], failed: [], startedAt: new Date().toISOString(), updatedAt: null };
}

/**
 * Record one delete attempt against the run state and the run's counters.
 *
 * Extracted because `nuke` and `sweep` each carried their own verbatim copy of it, untested in
 * both, and the invariant it enforces is the one that cannot be walked back: an id that is
 * marked handled is skipped by every future run of this tool, forever. So anything that is not
 * an explicit "deleted" or "gone" from X - an error, a network failure, a status this tool has
 * never heard of - is recorded as a failure and stays eligible for retry.
 *
 * @param {object} state a state object from loadState
 * @param {string} id the tweet id that was attempted
 * @param {{status?: string, message?: string, http?: number}} result what the client returned
 * @param {{deleted: number, gone: number, failed: number}} summary counters, mutated in place
 * @returns {"deleted"|"gone"|"failed"} what it was recorded as
 */
function applyDeleteResult(state, id, result, summary) {
  const status = result && result.status;
  if (status === "deleted") {
    state.markDeleted(id);
    summary.deleted++;
    return "deleted";
  }
  if (status === "gone") {
    state.markGone(id);
    summary.gone++;
    return "gone";
  }
  state.markFailed(id, result && result.message, result && result.http);
  summary.failed++;
  return "failed";
}

function readLock(lockFile) {
  try {
    return JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch (e) {
    return null;
  }
}

/**
 * Whether SOME process currently holds this pid. EPERM means the pid exists but belongs to
 * another user - still alive.
 *
 * Deliberately not called "the run that wrote this lock is still going": nothing portable can
 * establish that. `process.kill(pid, 0)` cannot tell this tool from whatever else the OS handed
 * that number to after the original run crashed, and pids are recycled fast on Windows and in
 * containers. So this is only ever one half of the staleness decision.
 */
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e) && e.code === "EPERM";
  }
}

/** How long the lock has been silent, in ms; Infinity when it carries no usable timestamp. */
function lockQuietMs(lock) {
  const stamp = Date.parse((lock && (lock.touchedAt || lock.startedAt)) || "");
  if (!Number.isFinite(stamp)) return Infinity;
  return Math.max(0, Date.now() - stamp);
}

function lockIsStale(lock) {
  if (!lock || !lock.pid) return true;
  // Silence is the backstop on every platform. A live run touches the lock on every save, and
  // its longest legitimate silence is one full rate-limit escalation (about 75 minutes with the
  // default caps), so LOCK_STALE_MS of quiet means the lock is not being held by a live run -
  // whatever the pid says. Without this, a recycled pid pinned the lock forever and the user was
  // told to wait for a process that had been gone for days.
  if (lockQuietMs(lock) > LOCK_STALE_MS) return true;
  // Another machine's process cannot be probed at all, so for those the silence check is all
  // there is. On this machine a dead pid additionally means "stale immediately" - no need to
  // wait out the 90 minutes after an ordinary Ctrl-C or crash.
  if (lock.host !== os.hostname()) return false;
  return !processIsAlive(lock.pid);
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
        "finish, or use a separate --data-dir. That process id is only evidence, not proof - the " +
        "operating system reuses ids, so if nothing is really running there the lock releases " +
        "itself after " +
        Math.round(LOCK_STALE_MS / 60000) +
        " minutes without a write. To stop waiting now, delete " +
        lockFile +
        "."
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
 * @param {object} [options]
 * @param {boolean} [options.lock] take the advisory lock; only for commands that write
 * @param {object} [options.logger]
 * @param {boolean} [options.handleSignals] install interrupt handlers (default: same as `lock`)
 * @param {(code: number) => void} [options.exit] injectable for tests; defaults to process.exit
 */
function loadState(file, options = {}) {
  const logger = options.logger || null;
  const warn = (message, data) => {
    if (logger && typeof logger.warn === "function") logger.warn(message, data);
  };
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
      // already gone, which the API reports harmlessly as "not found". But it must not be
      // discarded in silence either: somebody resuming a 4,000-tweet run is about to start from
      // zero, and the only warning they used to get was the run taking all night again.
      const backup = file + ".corrupt-" + Date.now();
      let movedTo = null;
      try {
        fs.renameSync(file, backup);
        movedTo = backup;
      } catch (e2) {
        // Could not even set it aside; it is overwritten by the first save.
      }
      warn("The saved progress file could not be read, so this run starts from ZERO progress.", {
        file,
        error: e && e.message ? e.message : String(e),
        backup: movedTo,
      });
      warn(
        movedTo
          ? "The unreadable file was kept as " +
              movedTo +
              " - nothing is lost yet, but every id already deleted will be attempted again (X reports those harmlessly as 'not found')."
          : "The unreadable file could not even be renamed, so the first save of this run overwrites it."
      );
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
  let consecutiveSaveFailures = 0;

  const state = {
    file,
    data: raw,
    handled,

    /** True when this id has already been deleted or confirmed missing in an earlier run. */
    isHandled(id) {
      return handled.has(id);
    },

    /** A confirmed deletion. Stored in the on-disk `done` list; see the vocabulary note above. */
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

    /**
     * Write the state file. Never throws: a transient EPERM from antivirus or a sync client
     * holding the file for a moment is a normal event on the platform this tool is used on, and
     * it used to escape the delete loop and end the whole run. A failed save is warned about,
     * retried by the next save, and escalated by saveThrottled if it keeps failing.
     *
     * @returns {boolean} whether the file was actually written
     */
    save() {
      raw.failed = Array.from(failedById.values());
      raw.updatedAt = new Date().toISOString();
      const tmp = file + ".tmp";
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(raw));
        fs.renameSync(tmp, file);
      } catch (e) {
        // Do not retry on the very next id: that turns one locked file into thousands of failed
        // writes a second. The normal throttle interval applies to the retry too.
        lastSave = Date.now();
        consecutiveSaveFailures++;
        warn("Could not save progress - continuing, and will retry on the next save.", {
          file,
          error: e && e.message ? e.message : String(e),
          consecutiveFailures: consecutiveSaveFailures,
        });
        return false;
      }
      lastSave = Date.now();
      consecutiveSaveFailures = 0;
      if (lock) lock.touch();
      return true;
    },

    /** Failed writes in a row, for callers that want to decide for themselves. */
    get saveFailures() {
      return consecutiveSaveFailures;
    },

    /** Give up the advisory lock and stop answering interrupts. */
    release() {
      if (signalOwner === state) signalOwner = null;
      if (lock) lock.release();
    },

    /**
     * Cheap call site for hot loops: only actually writes every few seconds.
     *
     * This is also where a persistently unwritable state file stops the run. Deleting tweets
     * that cannot be recorded is worse than stopping: everything already deleted has to be
     * rediscovered by a full sweep next time.
     */
    saveThrottled() {
      if (consecutiveSaveFailures >= MAX_CONSECUTIVE_SAVE_FAILURES) {
        throw new UserError(
          "Cannot record progress: " +
            file +
            " has failed to save " +
            consecutiveSaveFailures +
            " times in a row. Stopping before deleting anything else.",
          "Free up disk space, or point --data-dir somewhere writable that is not being scanned " +
            "by antivirus or synced by OneDrive/Dropbox. Deletions already recorded are kept."
        );
      }
      if (Date.now() - lastSave < SAVE_INTERVAL_MS) return;
      state.save();
    },
  };

  /**
   * Interrupt handling.
   *
   * `process.on("exit")` alone is not enough. On Windows a Ctrl-C terminates the process without
   * running 'exit' handlers at all, so the lock was left behind and nothing was flushed; and even
   * where 'exit' does run, it must be synchronous, so the `finally { state.save() }` inside the
   * delete loops never gets its turn. Real signal handlers do the synchronous work - flush the
   * state file, drop the lock - and then exit with the conventional 128+signal code.
   *
   * The guarantee that produces: on Ctrl-C (and SIGTERM/SIGHUP/SIGBREAK) every id already
   * resolved is on disk, so at most the single deletion in flight is unrecorded - and that one is
   * harmless, because X reports an already-deleted tweet as "not found" when the next run retries
   * it. Only an unstoppable kill (SIGKILL, an OOM kill, power loss) falls back to the last
   * throttled save, which is at most SAVE_INTERVAL_MS of deletions behind.
   */
  const exit = options.exit || ((code) => process.exit(code));
  let interrupted = false;

  state.handleInterrupt = (signal) => {
    // A second Ctrl-C while the first is still flushing must not re-enter this.
    if (interrupted) return;
    interrupted = true;
    if (signalOwner === state) signalOwner = null;
    const saved = state.save();
    if (lock) lock.release();
    warn(
      saved
        ? "Interrupted by " +
            signal +
            " - progress saved to " +
            file +
            ". Re-run the same command to carry on; at most the one deletion in flight is unrecorded."
        : "Interrupted by " +
            signal +
            " - COULD NOT save progress to " +
            file +
            ". The next run repeats whatever was not written."
    );
    exit(INTERRUPT_SIGNALS[signal] || 130);
  };

  const shouldHandleSignals =
    options.handleSignals === undefined ? Boolean(options.lock) : Boolean(options.handleSignals);
  if (shouldHandleSignals) {
    installInterruptHandlers();
    // Exactly one state object answers interrupts, and it is the newest. `run` opens the state
    // twice - once for the archive pass, once for the sweep - and leaving the finished pass's
    // (by then outdated) copy in charge would flush it over the sweep's newer progress.
    signalOwner = state;
  }

  return state;
}

module.exports = {
  loadState,
  applyDeleteResult,
  emptyState,
  acquireStateLock,
  lockIsStale,
  LOCK_STALE_MS,
  SAVE_INTERVAL_MS,
  MAX_CONSECUTIVE_SAVE_FAILURES,
  INTERRUPT_SIGNALS,
};
