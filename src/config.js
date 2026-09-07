/**
 * Resolves runtime configuration from, in order of precedence: command-line flags, environment
 * variables (including a .env file in the data directory), then defaults.
 *
 * Paths default to the current working directory rather than the package directory so that a
 * globally installed CLI writes state next to the user's archive, not inside its own install.
 */
const fs = require("fs");
const path = require("path");
const { UserError } = require("./errors");

const DEFAULTS = {
  delayMs: 400,
  maxRounds: 30,
  timelinePageSize: 100,
  timelinePageDelayMs: 1200,
  maxTimelinePages: 200,
  /** Cap on any single rate-limit sleep, so a bogus reset header cannot hang the run forever. */
  maxRateLimitWaitMs: 20 * 60 * 1000,
};

const FILE_NAMES = {
  session: ".x-session-data.json",
  state: ".nuke-state.json",
  log: "x-tweet-nuker.log",
  archive: "tweets.js",
  browserProfile: ".chrome-user-data",
  env: ".env",
};

/**
 * Minimal .env reader. A whole dependency for `KEY=value` is not worth it, and this tool
 * deliberately ships with only Playwright.
 */
function loadDotEnv(dataDir, env) {
  const file = path.join(dataDir, FILE_NAMES.env);
  if (!fs.existsSync(file)) return;
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    if (env[key] === undefined || env[key] === "") env[key] = value;
  }
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/**
 * Numeric options coming from a flag or the environment.
 *
 * A given-but-unparseable value is refused rather than quietly replaced by the default: for
 * `--limit` the default is 0, which means "no limit", so `--limit 50tweets` silently turning
 * into a full account wipe is exactly the kind of accident this tool must not have.
 *
 * `min` exists for the same reason. An option whose lowest meaningful value is 1 must say so:
 * accepting 0 and then substituting the default is the same silent-fallback failure, just with
 * a value the user typed on purpose.
 *
 * @param {string} label the flag name, as the user typed it
 * @param {any} value raw value from a flag or the environment
 * @param {number} fallback used only when no value was given at all
 * @param {{min?: number}} [options] lowest accepted value (default 0)
 */
function toNumber(label, value, fallback, options = {}) {
  if (value === undefined) return fallback;
  const min = options.min === undefined ? 0 : options.min;
  const n = Number(String(value).trim());
  if (!Number.isInteger(n) || n < min) {
    throw new UserError(
      "Invalid value for " + label + ": " + JSON.stringify(String(value)),
      label + " needs a whole number of " + (min === 0 ? "zero" : min) + " or more."
    );
  }
  return n;
}

function toBool(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function normalizeHandle(value) {
  if (!value) return null;
  return String(value).trim().replace(/^@/, "").replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i, "").replace(/\/.*$/, "") || null;
}

/**
 * @param {Record<string, any>} flags parsed command-line flags
 * @param {NodeJS.ProcessEnv} [env]
 */
function buildConfig(flags = {}, env = process.env) {
  const dataDir = path.resolve(firstDefined(flags["data-dir"], env.X_NUKER_DATA_DIR, process.cwd()));
  loadDotEnv(dataDir, env);

  const inData = (name) => path.join(dataDir, name);

  return {
    dataDir,
    sessionFile: path.resolve(firstDefined(flags.session, env.SESSION_FILE, inData(FILE_NAMES.session))),
    stateFile: path.resolve(firstDefined(flags.state, env.STATE_FILE, inData(FILE_NAMES.state))),
    logFile: path.resolve(firstDefined(flags.log, env.LOG_FILE, inData(FILE_NAMES.log))),
    archivePath: path.resolve(firstDefined(flags.archive, env.ARCHIVE_FILE, inData(FILE_NAMES.archive))),
    browserProfileDir: inData(FILE_NAMES.browserProfile),

    handle: normalizeHandle(firstDefined(flags.handle, env.X_HANDLE)),
    chromeExecutable: firstDefined(flags["chrome-executable"], env.CHROME_EXECUTABLE) || null,
    headless: firstDefined(toBool(flags.headless), toBool(env.HEADLESS)),

    delayMs: toNumber("--delay", firstDefined(flags.delay, env.DELETE_DELAY_MS), DEFAULTS.delayMs),
    limit: toNumber("--limit", firstDefined(flags.limit, env.LIMIT), 0),
    // Minimum 1, and enforced rather than papered over: a sweep of zero rounds cannot look at
    // anything, so `--max-rounds 0` is a typo, not a request. It used to be silently replaced by
    // the default of 30 - the same silent fallback the numeric parsing above exists to prevent.
    maxRounds: toNumber(
      "--max-rounds",
      firstDefined(flags["max-rounds"], env.MAX_ROUNDS),
      DEFAULTS.maxRounds,
      { min: 1 }
    ),

    ids: firstDefined(flags.ids, env.CHECK_IDS) || "",
    check: Boolean(flags.check),

    dryRun: Boolean(flags["dry-run"]),
    assumeYes: Boolean(flags.yes || flags.y),
    verbose: Boolean(flags.verbose),

    timelinePageSize: DEFAULTS.timelinePageSize,
    timelinePageDelayMs: DEFAULTS.timelinePageDelayMs,
    maxTimelinePages: DEFAULTS.maxTimelinePages,
    maxRateLimitWaitMs: DEFAULTS.maxRateLimitWaitMs,
  };
}

module.exports = { buildConfig, normalizeHandle, DEFAULTS, FILE_NAMES };
