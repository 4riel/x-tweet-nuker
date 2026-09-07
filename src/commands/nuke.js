/**
 * `nuke` - delete every tweet listed in a Twitter/X data archive.
 *
 * The archive is the fast path: it hands over every id up front, so the run never has to
 * discover tweets by paging a timeline that is shrinking underneath it. It cannot cover
 * retweets or anything posted after the export, which is what `sweep` is for.
 */
const { createRunContext, resolveTargetHandle } = require("../context");
const { readArchiveIds } = require("../archive");
const { loadState, applyDeleteResult } = require("../state");
const { createRateWindow, PROGRESS_EVERY } = require("../logger");
const { confirmDestruction, requireGate } = require("../confirm");
const { UserError } = require("../errors");

const flags = {
  "--archive <path>": "tweets.js from your archive, or a folder containing it",
  "--dry-run": "report exactly what would be deleted, delete nothing",
  "--limit <n>": "stop after N deletions",
  "--delay <ms>": "pause between deletions (default 400)",
  "--yes, -y": "skip the typed confirmation (for automation)",
};

/**
 * @param {object} config
 * @param {object} [options] internal reuse hooks for the `run` command
 */
async function run(config, options = {}) {
  const ctx = options.ctx || createRunContext(config);
  const { logger, client, session } = ctx;
  const gate = requireGate(ctx);

  const archive = readArchiveIds(config.archivePath);
  if (archive.total === 0) {
    throw new UserError(
      "No tweet ids found at " + config.archivePath + ".",
      "Download your archive from X (Settings > Your account > Download an archive of your data), " +
        "unzip it and copy data/tweets.js next to where you run this command, or point at it with " +
        "--archive <path>. If you would rather not wait for the archive, run `x-tweet-nuker sweep` instead."
    );
  }

  // A dry run writes nothing, so it must not take the lock away from a real run.
  const state = loadState(config.stateFile, { lock: !config.dryRun, logger });
  let todo = archive.ids.filter((id) => !state.isHandled(id));
  // "handled" is the word for deleted-or-gone everywhere in this tool; the local that feeds the
  // `alreadyHandled` line below used to be called `skipped`, which named nothing else.
  const alreadyHandled = archive.total - todo.length;
  // Tracked, not just applied: a run cut short by --limit finishes with tweets still in the
  // archive, and has to say so instead of exiting 0 like a completed pass.
  const outstanding = todo.length;
  const stoppedAtLimit = config.limit > 0 && outstanding > config.limit;
  if (config.limit > 0) todo = todo.slice(0, config.limit);

  logger.info("Archive loaded", {
    files: archive.files.length,
    tweets: archive.total,
    alreadyHandled,
    queued: todo.length,
  });

  if (todo.length === 0) {
    logger.info("Nothing left to delete from the archive.");
    return 0;
  }

  if (config.dryRun) {
    logger.plain("");
    logger.plain("  DRY RUN - nothing will be deleted.");
    logger.plain("  Would delete " + todo.length + " tweet(s) from the archive.");
    logger.plain("  First ids: " + todo.slice(0, 10).join(", "));
    if (todo.length > 10) logger.plain("  ... and " + (todo.length - 10) + " more.");
    logger.plain("");
    return 0;
  }

  // Keyed on the gate, so `run` confirming once covers both passes and nothing else can skip it.
  if (!gate.armed) {
    const target = await resolveTargetHandle(ctx);
    await confirmDestruction({
      handle: target.handle,
      verified: target.verified,
      userId: session.myUserId,
      action: "delete every tweet listed in your archive",
      count: todo.length,
      assumeYes: config.assumeYes,
      logger,
      gate,
    });
  }

  const summary = { deleted: 0, gone: 0, failed: 0 };
  const rate = createRateWindow();

  try {
    for (let i = 0; i < todo.length; i++) {
      const id = todo[i];
      const result = await client.deleteTweet(id);

      const recorded = applyDeleteResult(state, id, result, summary);
      if (recorded === "failed") {
        logger.warn("Delete failed", { id, http: result.http, message: result.message });
      } else {
        rate.record();
      }

      state.saveThrottled();
      if ((i + 1) % PROGRESS_EVERY === 0) {
        logger.info("Progress " + (i + 1) + "/" + todo.length, {
          ...summary,
          remaining: todo.length - (i + 1),
          // Recent-window, not a lifetime average, and no ETA. See createRateWindow.
          perMinute: rate.perMinute(),
        });
      }
      if (config.delayMs > 0) await client.sleep(config.delayMs);
    }
  } finally {
    state.save();
  }

  logger.info("Archive pass complete", summary);
  if (summary.failed > 0) {
    logger.warn(
      "Some deletions failed. Re-running `nuke` retries them; ids and messages are in " + config.stateFile + "."
    );
  }
  if (stoppedAtLimit) {
    ctx.stoppedAtLimit = true;
    logger.plain("");
    logger.plain(
      "  STOPPED EARLY - --limit " +
        config.limit +
        " reached; " +
        (outstanding - todo.length) +
        " archive tweet(s) were never attempted."
    );
    logger.plain("  This run was incomplete on purpose. Re-run without --limit to finish the job.");
    logger.plain("");
  }
  // Non-zero so a script can tell "the archive is cleared" from "some of it is still there".
  if (summary.failed > 0 || stoppedAtLimit) return 1;
  return 0;
}

module.exports = { run, flags, description: "Delete every tweet listed in your archive's tweets.js" };
