/**
 * `status` - what the tool knows right now: session, archive, progress, and where its files are.
 *
 * Read-only and offline by default. `--check` adds one authenticated request to X so you can
 * tell an expired session from a working one before starting a long run.
 */
const fs = require("fs");
const { createLogger } = require("../logger");
const { loadSession, sessionAgeHours } = require("../session");
const { createClient } = require("../client");
const { readArchiveIds } = require("../archive");
const { loadState } = require("../state");

const flags = {
  "--check": "also make one request to X to confirm the session still works",
};

async function run(config) {
  const logger = createLogger({ logFile: null, verbose: config.verbose });
  const lines = [];
  const add = (label, value) => lines.push("  " + label.padEnd(22) + value);

  add("Data directory", config.dataDir);
  add("Session file", describeFile(config.sessionFile));
  add("State file", describeFile(config.stateFile));
  add("Log file", describeFile(config.logFile));
  add("Archive", describeFile(config.archivePath));
  lines.push("");

  let session = null;
  try {
    session = loadSession(config.sessionFile);
  } catch (e) {
    add("Session", "NOT CAPTURED - run `x-tweet-nuker login`");
  }

  if (session) {
    const ageHours = sessionAgeHours(session);
    add("Signed in as", session.handle ? "@" + session.handle : "unknown (pass --handle)");
    add("User id", session.myUserId || "unknown");
    add("Session age", ageHours === null ? "unknown" : formatAge(ageHours));
    add("GraphQL queryIds", Object.keys(session.queryIds || {}).join(", ") || "none");
    const timelines = Object.keys(session.timelineUrls || {});
    add("Timelines captured", timelines.length ? timelines.join(", ") : "NONE - re-run login");
    if (timelines.length === 0 && Array.isArray(session.graphqlOperationsSeen)) {
      add("Operations seen", session.graphqlOperationsSeen.join(", ") || "none");
    }
    lines.push("");
  }

  const archive = readArchiveIds(config.archivePath);
  add("Archive tweets", archive.total > 0 ? String(archive.total) : "none found");

  if (fs.existsSync(config.stateFile)) {
    const state = loadState(config.stateFile);
    const counts = state.counts();
    add("Deleted so far", String(counts.deleted));
    add("Already gone", String(counts.gone));
    add("Failed", String(counts.failed));
    if (archive.total > 0) {
      const remaining = archive.ids.filter((id) => !state.isHandled(id)).length;
      add("Archive remaining", String(remaining));
    }
    add("State updated", state.data.updatedAt || "never");
  } else {
    add("Progress", "no run recorded yet");
  }

  if (config.check && session) {
    lines.push("");
    const client = createClient({ session, logger, config });
    const probe = await client.fetchOwnHandle();
    if (probe.ok) add("Live session check", "OK" + (probe.handle ? " (@" + probe.handle + ")" : ""));
    else if (probe.expired) add("Live session check", "EXPIRED - run `x-tweet-nuker login`");
    else add("Live session check", "could not reach X (" + (probe.error || "HTTP " + probe.http) + ")");
  }

  logger.plain("");
  logger.plain("  x-tweet-nuker status");
  logger.plain("");
  for (const line of lines) logger.plain(line);
  logger.plain("");
  return 0;
}

function describeFile(file) {
  if (!fs.existsSync(file)) return file + "  (missing)";
  const stat = fs.statSync(file);
  const size = stat.isDirectory() ? "directory" : formatBytes(stat.size);
  return file + "  (" + size + ")";
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function formatAge(hours) {
  if (hours < 1) return Math.round(hours * 60) + " minutes";
  if (hours < 48) return Math.round(hours) + " hours";
  return Math.round(hours / 24) + " days";
}

module.exports = { run, flags, description: "Show session health, archive size and deletion progress" };
