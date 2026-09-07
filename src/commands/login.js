/**
 * `login` - open a browser, sign in to X, and save the session every other command needs.
 *
 * Nothing here deletes anything. It is safe to re-run at any time, and it is the fix for
 * every 401/403 the other commands can hit.
 */
const { createLogger } = require("../logger");
const { captureSession } = require("../session");

const flags = {
  "--headless": "run the browser headless (only works if this profile is already signed in)",
  "--handle <name>": "skip handle detection and use this handle",
  "--data-dir <path>": "where to keep the session, state, logs and browser profile",
};

async function run(config) {
  const logger = createLogger({ logFile: config.logFile, verbose: config.verbose });
  logger.info("Starting X login", { profile: config.browserProfileDir });

  const session = await captureSession({ config, logger });

  logger.plain("");
  logger.plain("  Signed in as @" + session.handle + " (id " + session.myUserId + ")");
  logger.plain("  Timeline operations captured: " + (Object.keys(session.timelineUrls).length || "none"));
  logger.plain("");
  logger.plain("  Next: `x-tweet-nuker status` to review, or `x-tweet-nuker run` to delete everything.");
  logger.plain("");
  return 0;
}

module.exports = { run, flags, description: "Sign in to X and capture the session (start here)" };
