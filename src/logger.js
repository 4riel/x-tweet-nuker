/**
 * Timestamped logging to the console and, when a log file is configured, to disk.
 *
 * Runs last for hours and gets killed by the OS more often than anyone would like, so every
 * line is flushed synchronously - a truncated log after a hard kill is worse than a slow one.
 */
const fs = require("fs");
const path = require("path");
const { UserError } = require("./errors");

/**
 * @param {{ logFile?: string|null, verbose?: boolean, quiet?: boolean }} options
 */
function createLogger(options = {}) {
  const logFile = options.logFile || null;
  const verbose = Boolean(options.verbose);

  if (logFile) {
    // The logger is the first thing every command builds, so this is the first thing a bad
    // --data-dir, a read-only volume or a full disk hits - and an unwrapped ENOENT/EACCES here
    // came out as a raw Node stack trace, before any command had run and with nothing in it
    // that told the user which path was the problem.
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
    } catch (e) {
      throw new UserError(
        "Cannot create the directory for the log file " + logFile + ": " + e.message,
        "Point --log at a writable file, or --data-dir at a writable directory that exists."
      );
    }
  }

  function write(level, message, data) {
    const stamp = new Date().toISOString();
    const suffix = data === undefined ? "" : " " + safeJson(data);
    const line = "[" + stamp + "] " + (level === "info" ? "" : level.toUpperCase() + " ") + message + suffix;

    if (level === "error") console.error(line);
    else console.log(line);

    if (logFile) {
      try {
        fs.appendFileSync(logFile, line + "\n");
      } catch (e) {
        // A failing log file must never take down a deletion run.
      }
    }
  }

  return {
    logFile,
    info: (message, data) => write("info", message, data),
    warn: (message, data) => write("warn", message, data),
    error: (message, data) => write("error", message, data),
    debug: (message, data) => {
      if (verbose) write("debug", message, data);
    },
    /** Console-only output for menus, banners and prompts that would only clutter the log. */
    plain: (message) => console.log(message),
  };
}

/**
 * Deletions between progress lines. Both delete loops use it, so `sweep` can no longer run for
 * thirteen silent minutes a round while `nuke` reports every fifty ids.
 */
const PROGRESS_EVERY = 50;

/**
 * The `rate` figure in a progress line, measured over a recent window rather than the whole run.
 *
 * A lifetime average (deletions / minutes since the run began) is worst exactly when someone is
 * watching it: one 20-minute rate-limit stall drags it down permanently, so an hour later the
 * tool is deleting at 90/min and still reporting 30/min, and the number never recovers. This
 * keeps the timestamps of recent deletions only, so the figure describes what is happening now.
 *
 * Deliberately no ETA is derived from it. X's throttling is all-or-nothing - full speed, then a
 * wall for up to 20 minutes - so any "time remaining" is wrong by an order of magnitude in one
 * direction or the other, and it is most wrong at the moment a user consults it. The progress
 * line reports the honest pair instead: how many are left, and how fast the last few minutes went.
 *
 * @param {number} [windowMs] how much recent history the figure covers (default 5 minutes)
 */
function createRateWindow(windowMs = 5 * 60 * 1000) {
  const stamps = [];
  return {
    /** Call once per completed deletion. */
    record(now = Date.now()) {
      stamps.push(now);
      const cutoff = now - windowMs;
      while (stamps.length > 0 && stamps[0] < cutoff) stamps.shift();
    },
    /** Deletions per minute over the window, or null while there is not enough history yet. */
    perMinute(now = Date.now()) {
      const cutoff = now - windowMs;
      while (stamps.length > 0 && stamps[0] < cutoff) stamps.shift();
      if (stamps.length < 2) return null;
      const spanMs = now - stamps[0];
      if (spanMs <= 0) return null;
      return Math.round((stamps.length / spanMs) * 60000);
    },
  };
}

function safeJson(data) {
  try {
    return JSON.stringify(data);
  } catch (e) {
    return String(data);
  }
}

module.exports = { createLogger, createRateWindow, PROGRESS_EVERY };
