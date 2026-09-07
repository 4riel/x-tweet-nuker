/**
 * `sweep` - page the account's own timelines, remove everything found, repeat until clean.
 *
 * This is the part that finishes the job: it catches retweets (which archives never contain),
 * anything posted after the archive export, and anything the archive pass failed on.
 *
 * Deletion on X is eventually consistent - a tweet can still be served on a timeline for a
 * while after a successful delete - so one empty-looking pass proves nothing. The sweep only
 * stops when a complete pass over every captured timeline finds no tweets at all.
 */
const { createRunContext, requireHandle } = require("../context");
const { loadState } = require("../state");
const { confirmDestruction } = require("../confirm");
const { UserError } = require("../errors");

const flags = {
  "--dry-run": "harvest and report what is still there, delete nothing",
  "--limit <n>": "stop after N deletions",
  "--max-rounds <n>": "give up after N rounds without a clean pass (default 30, min 1)",
  "--delay <ms>": "pause between deletions (default 400)",
  "--yes, -y": "skip the typed confirmation (for automation)",
};

async function run(config, options = {}) {
  const ctx = options.ctx || createRunContext(config);
  const { logger, client, session } = ctx;

  const timelines = Object.entries(session.timelineUrls || {});
  if (timelines.length === 0) {
    throw new UserError(
      "The saved session contains no timeline requests, so there is nothing to page through.",
      "Run `x-tweet-nuker login` again. If it still captures nothing, X has renamed its timeline " +
        "GraphQL operations: the login output lists every operation your browser actually requested, " +
        "and the new name needs adding to KNOWN_TIMELINE_OPS in src/session.js."
    );
  }
  logger.info("Sweeping timelines", { operations: timelines.map(([name]) => name) });

  // A dry run writes nothing, so it must not take the lock away from a real run.
  const state = loadState(config.stateFile, { lock: !config.dryRun, logger });
  const summary = { deleted: 0, gone: 0, failed: 0, unretweeted: 0 };

  for (let round = 1; round <= config.maxRounds; round++) {
    const { items, failedPages } = await harvest({ client, config, logger, timelines });
    logger.info("Round " + round + ": found " + items.length + " post(s) still on your timelines");

    // A pass that could not read your timelines found nothing because it looked at nothing.
    // Treating that as "clean" is how a tool reports success while every tweet is still there.
    if (items.length === 0 && failedPages > 0) {
      logger.warn(
        "Round " +
          round +
          " found no posts, but " +
          failedPages +
          " timeline request(s) failed - that is not proof your timelines are empty, so this pass does not count as clean."
      );
      await client.sleep(5000);
      continue;
    }

    if (items.length === 0) {
      logger.plain("");
      logger.plain("  CLEAN - a full pass over every timeline found nothing left.");
      logger.plain("");
      logger.info("Sweep complete", { rounds: round, ...summary });
      state.save();
      return 0;
    }

    if (config.dryRun) {
      const retweets = items.filter((item) => item.retweetOf).length;
      logger.plain("");
      logger.plain("  DRY RUN - nothing will be deleted.");
      logger.plain("  Would remove " + items.length + " post(s): " + (items.length - retweets) + " own, " + retweets + " retweet(s).");
      logger.plain("  First ids: " + items.slice(0, 10).map((item) => item.id).join(", "));
      logger.plain("");
      logger.plain("  Note: this is one pass. A real sweep repeats until a pass finds nothing,");
      logger.plain("  so the final total is usually higher than what a dry run reports.");
      logger.plain("");
      return 0;
    }

    if (round === 1 && !options.alreadyConfirmed) {
      await confirmDestruction({
        handle: await requireHandle(ctx),
        action: "delete every post found on your timelines, repeating until none are left",
        count: items.length,
        assumeYes: config.assumeYes,
        logger,
      });
    }

    let removedThisRound = 0;
    try {
      for (const item of items) {
        if (config.limit > 0 && summary.deleted >= config.limit) {
          logger.info("Reached --limit " + config.limit + ", stopping.");
          return 0;
        }

        // A retweet only disappears once the retweet relationship is undone; the delete that
        // follows cleans up the retweet's own id.
        if (item.retweetOf) {
          const undo = await client.unretweet(item.retweetOf);
          if (undo.status === "unretweeted") summary.unretweeted++;
          else logger.warn("Unretweet failed", { id: item.id, sourceTweetId: item.retweetOf, http: undo.http, message: undo.message });
          if (config.delayMs > 0) await client.sleep(config.delayMs);
        }

        const result = await client.deleteTweet(item.id);
        if (result.status === "deleted") {
          state.markDeleted(item.id);
          summary.deleted++;
          removedThisRound++;
        } else if (result.status === "gone") {
          state.markGone(item.id);
          summary.gone++;
        } else {
          state.markFailed(item.id, result.message, result.http);
          summary.failed++;
          logger.warn("Delete failed", { id: item.id, http: result.http, message: result.message });
        }

        state.saveThrottled();
        if (config.delayMs > 0) await client.sleep(config.delayMs);
      }
    } finally {
      state.save();
    }

    logger.info("Round " + round + " removed " + removedThisRound, summary);
  }

  logger.warn("Stopped after " + config.maxRounds + " rounds without a clean pass", summary);
  logger.warn(
    "Deletion on X is eventually consistent, so run `x-tweet-nuker sweep` again in a few minutes; " +
      "if the same ids keep coming back, check them with `x-tweet-nuker verify`."
  );
  // Non-zero: the account is NOT known to be empty, and a script must be able to see that.
  return 1;
}

/**
 * Page every captured timeline once and return the account's own posts, de-duplicated, together
 * with the number of pages that could not be read at all.
 */
async function harvest({ client, config, logger, timelines }) {
  const all = new Map();
  let failedPages = 0;

  for (const [name, templateUrl] of timelines) {
    let cursor = null;
    let emptyPages = 0;

    for (let page = 0; page < config.maxTimelinePages && emptyPages < 3; page++) {
      const result = await client.fetchTimelinePage(templateUrl, cursor);
      if (result === null) continue; // rate limited; the client already waited, retry this cursor
      if (result.failed) failedPages++;

      for (const [id, item] of result.items) all.set(id, item);
      // Counted per page, not against the shared map: a page whose posts were all already seen
      // on an earlier timeline is not an empty page, and stopping there would cut this
      // timeline's pagination short and leave posts behind.
      emptyPages = result.items.size === 0 ? emptyPages + 1 : 0;

      const nextCursor = result.cursors.find((value) => value !== cursor);
      if (!nextCursor) break;
      cursor = nextCursor;
      if (config.timelinePageDelayMs > 0) await client.sleep(config.timelinePageDelayMs);
    }
    logger.debug("Harvested " + name, { totalSoFar: all.size, failedPages });
  }

  return { items: Array.from(all.values()), failedPages };
}

module.exports = {
  run,
  flags,
  description: "Page your timelines and delete whatever is left, until a pass finds nothing",
};
