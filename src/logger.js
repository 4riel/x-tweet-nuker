/**
 * Timestamped logging to the console and, when a log file is configured, to disk.
 *
 * Runs last for hours and gets killed by the OS more often than anyone would like, so every
 * line is flushed synchronously - a truncated log after a hard kill is worse than a slow one.
 */
const fs = require("fs");
const path = require("path");

/**
 * @param {{ logFile?: string|null, verbose?: boolean, quiet?: boolean }} options
 */
function createLogger(options = {}) {
  const logFile = options.logFile || null;
  const verbose = Boolean(options.verbose);

  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
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

function safeJson(data) {
  try {
    return JSON.stringify(data);
  } catch (e) {
    return String(data);
  }
}

module.exports = { createLogger };
