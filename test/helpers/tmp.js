"use strict";
/**
 * Shared temp-directory bookkeeping for tests: every fixture lives under os.tmpdir(), never in
 * the repo, and is best-effort removed afterwards. A single directory that stays briefly locked
 * (e.g. AV/cloud-sync scanning a freshly written file) must not stop the rest from being cleaned,
 * nor fail the suite - it is leftover OS-temp clutter, not repo or user data.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

function makeTmpDirs(prefix) {
  const dirs = [];
  return {
    create() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    cleanup() {
      for (const dir of dirs) {
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        } catch (e) {
          // Best-effort only; see file header.
        }
      }
    },
  };
}

module.exports = { makeTmpDirs };
