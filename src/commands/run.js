/**
 * `run` - the whole job: archive pass first, then sweep until clean.
 *
 * Ordering matters. The archive pass is cheap and removes the bulk in one straight line, which
 * leaves the sweep - the slow part, because it has to page timelines - with very little to do.
 * If there is no archive the command just goes straight to the sweep.
 */
const { createRunContext, requireHandle } = require("../context");
const { readArchiveIds } = require("../archive");
const { confirmDestruction } = require("../confirm");
const nuke = require("./nuke");
const sweep = require("./sweep");

const flags = {
  "--archive <path>": "tweets.js from your archive, or a folder containing it",
  "--dry-run": "report what both passes would do, delete nothing",
  "--limit <n>": "stop each pass after N deletions",
  "--max-rounds <n>": "give up sweeping after N rounds (default 30, min 1)",
  "--delay <ms>": "pause between deletions (default 400)",
  "--yes, -y": "skip the typed confirmation (for automation)",
};

async function run(config) {
  const ctx = createRunContext(config);
  const { logger } = ctx;

  const archive = readArchiveIds(config.archivePath);
  if (archive.total === 0) {
    logger.warn("No archive found at " + config.archivePath + " - skipping the archive pass.");
    logger.warn("The sweep alone still removes everything, it is just slower.");
  }

  if (!config.dryRun) {
    await confirmDestruction({
      handle: await requireHandle(ctx),
      action:
        archive.total > 0
          ? "delete your entire archive (" + archive.total + " tweets), then sweep your timelines until empty"
          : "sweep your timelines and delete every post found, until none are left",
      count: null,
      assumeYes: config.assumeYes,
      logger,
    });
  }

  const passOptions = { ctx, alreadyConfirmed: true };

  let archiveCode = 0;
  if (archive.total > 0) {
    logger.info("=== Pass 1 of 2: archive ===");
    archiveCode = await nuke.run(config, passOptions);
  }

  logger.info("=== Pass 2 of 2: timeline sweep ===");
  const sweepCode = await sweep.run(config, passOptions);

  logger.plain("");
  if (config.dryRun) {
    logger.plain("  Dry run finished - nothing was deleted. Re-run without --dry-run to delete.");
  } else if (sweepCode !== 0) {
    logger.plain("  NOT finished - the sweep stopped before a clean pass. Run `x-tweet-nuker sweep`");
    logger.plain("  again in a few minutes, then confirm with `x-tweet-nuker verify`.");
  } else if (archiveCode !== 0) {
    logger.plain("  The sweep finished clean, but some archive deletions failed - see");
    logger.plain("  " + config.stateFile + ". Re-run `x-tweet-nuker run` to retry them.");
  } else {
    logger.plain("  Done. Confirm it independently with `x-tweet-nuker verify` - X's own post");
    logger.plain("  counter on your profile is cached and lags days behind a bulk deletion.");
  }
  logger.plain("");
  return sweepCode || archiveCode;
}

module.exports = { run, flags, description: "Archive pass, then sweep until clean (the usual choice)" };
