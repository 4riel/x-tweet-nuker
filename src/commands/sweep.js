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
const { createRunContext, resolveTargetHandle } = require("../context");
const { loadState, applyDeleteResult } = require("../state");
const { createRateWindow, PROGRESS_EVERY } = require("../logger");
const { confirmDestruction, requireGate } = require("../confirm");
const { UserError } = require("../errors");

/**
 * Consecutive pages with none of your posts on them before a timeline is considered walked. X
 * interleaves pages that hold nothing of yours, so one is not enough.
 */
const EMPTY_PAGES_BEFORE_DONE = 3;

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
  const gate = requireGate(ctx);

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
    const { items, failedPages, cappedTimelines } = await harvest({ client, config, logger, timelines });
    logger.info("Round " + round + ": found " + items.length + " post(s) still on your timelines");

    // A pass that could not read your timelines found nothing because it looked at nothing, and
    // a pass that stopped paging at the page cap stopped looking before it ran out of timeline.
    // Treating either as "clean" is how a tool reports success while every tweet is still there.
    if (items.length === 0 && (failedPages > 0 || cappedTimelines.length > 0)) {
      logger.warn(
        "Round " +
          round +
          " found no posts, but " +
          failedPages +
          " timeline request(s) failed and " +
          cappedTimelines.length +
          " timeline(s) stopped at the " +
          config.maxTimelinePages +
          "-page cap - that is not proof your timelines are empty, so this pass does not count as clean.",
        { failedPages, cappedTimelines }
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

    // Asked once per run, and keyed on the gate rather than on the round number. `round === 1`
    // was unreachable whenever round 1 ended in the `continue` above, which is exactly what a
    // flaky timeline read produces - and the sweep then deleted the account unprompted.
    if (!gate.armed) {
      const target = await resolveTargetHandle(ctx);
      await confirmDestruction({
        handle: target.handle,
        verified: target.verified,
        userId: session.myUserId,
        action: "delete every post found on your timelines, repeating until none are left",
        count: items.length,
        assumeYes: config.assumeYes,
        logger,
        gate,
      });
    }

    let deletedThisRound = 0;
    const rate = createRateWindow();
    try {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (config.limit > 0 && summary.deleted >= config.limit) {
          // Deliberately incomplete. Exiting 0 here told every caller - and the person reading
          // the last line - that the account was empty when the sweep had just walked away from
          // posts it could still see.
          ctx.stoppedAtLimit = true;
          logger.info("Reached --limit " + config.limit + ", stopping.", summary);
          logger.plain("");
          logger.plain("  STOPPED EARLY - --limit " + config.limit + " reached, and posts are still");
          logger.plain("  on your timelines. This run was incomplete on purpose; nothing here says");
          logger.plain("  your account is empty. Re-run without --limit to finish the job.");
          logger.plain("");
          return 1;
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
        const recorded = applyDeleteResult(state, item.id, result, summary);
        if (recorded === "deleted") deletedThisRound++;
        if (recorded === "failed") {
          logger.warn("Delete failed", { id: item.id, http: result.http, message: result.message });
        } else {
          rate.record();
        }

        state.saveThrottled();
        // The deletion loop used to say nothing at all until the round ended - thirteen silent
        // minutes in a real transcript, indistinguishable from a hang. `nuke` reports every
        // PROGRESS_EVERY ids; so does this.
        if ((i + 1) % PROGRESS_EVERY === 0) {
          logger.info("Round " + round + " progress " + (i + 1) + "/" + items.length, {
            ...summary,
            remaining: items.length - (i + 1),
            // Recent-window, not a lifetime average, and no ETA. See createRateWindow.
            perMinute: rate.perMinute(),
          });
        }
        if (config.delayMs > 0) await client.sleep(config.delayMs);
      }
    } finally {
      state.save();
    }

    logger.info("Round " + round + " deleted " + deletedThisRound, summary);
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
 * Page every captured timeline once and return the account's own posts, de-duplicated.
 *
 * Exported because this is where the sweep decides whether an empty-looking result means "there
 * is nothing left" or "I could not finish looking", and that decision is the difference between
 * a true CLEAN and telling somebody their account is empty while it is not. Both ways of not
 * finishing are reported, and both are treated by `run` exactly alike:
 *
 *  - `failedPages`: pages X refused or answered with something unreadable.
 *  - `cappedTimelines`: timelines that were still paginating when they hit maxTimelinePages.
 *    Hitting that cap used to be invisible - not logged, not counted - and so was indistinguish-
 *    able from having reached the end of a timeline, which is the same "stopped looking" versus
 *    "nothing left" confusion in a different place.
 *
 * @returns {Promise<{items: object[], failedPages: number, cappedTimelines: string[]}>}
 */
async function harvest({ client, config, logger, timelines }) {
  const all = new Map();
  let failedPages = 0;
  const cappedTimelines = [];

  for (const [name, templateUrl] of timelines) {
    let cursor = null;
    let emptyPages = 0;
    let pages = 0;

    for (;;) {
      if (pages >= config.maxTimelinePages) {
        cappedTimelines.push(name);
        logger.warn(
          "Stopped paging " +
            name +
            " at the " +
            config.maxTimelinePages +
            "-page cap while it was still handing out cursors. This pass did not reach the end of " +
            "that timeline, so it cannot count as a clean one; the next round picks it up from the top.",
          { timeline: name, pages, postsSoFar: all.size }
        );
        break;
      }
      if (emptyPages >= EMPTY_PAGES_BEFORE_DONE) break;

      const result = await client.fetchTimelinePage(templateUrl, cursor);
      // Rate limited: the client has already waited, and this cursor has not been read yet. It
      // must not count against the page budget - retrying a cursor is not progress through the
      // timeline, and charging it burned pages the sweep needed to reach the end.
      if (result === null) continue;
      pages++;
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
    logger.debug("Harvested " + name, { pages, totalSoFar: all.size, failedPages });
  }

  return { items: Array.from(all.values()), failedPages, cappedTimelines };
}

module.exports = {
  run,
  harvest,
  flags,
  EMPTY_PAGES_BEFORE_DONE,
  description: "Page your timelines and delete whatever is left, until a pass finds nothing",
};
