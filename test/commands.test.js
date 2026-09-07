"use strict";
/**
 * `nuke`, `sweep` and `run`, end to end against a scripted x.com.
 *
 * These are the tests that were missing when a sweep that deletes without ever asking shipped, so
 * the first two sections are the reviewer's two reproductions, kept as regressions:
 *
 *  1. a flaky first round makes round 1 inconclusive, the sweep continues to round 2 - and must
 *     still refuse to delete anything without confirmation;
 *  2. a handle that is not the session's account must stop the run before a single mutation.
 *
 * Every test asserts on what actually went out over `fetch`, not on a return value: "issued no
 * DeleteTweet" is the only claim worth making about a tool that cannot undo one.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const nuke = require("../src/commands/nuke");
const sweep = require("../src/commands/sweep");
const run = require("../src/commands/run");
const { UserError } = require("../src/errors");
const runs = require("./helpers/run-context");

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});
test.after(() => runs.cleanup());

const ok = (body) => runs.response(200, body);

/** Timeline script: round 1 fails to load, every round after it serves one post. */
function flakyFirstRound(ids = ["555"]) {
  return (n) => (n === 1 ? runs.response(500, "<html>Internal Server Error</html>") : ok(runs.timelinePage(ids)));
}

// ---------------------------------------------------------------------------
// BLOCKER 1 - confirmation is not a position in the flow
// ---------------------------------------------------------------------------

test("sweep: a failed first round does not let deletion past the gate (no terminal, no --yes)", async () => {
  const fake = runs.installFakeX({ timeline: flakyFirstRound() });
  try {
    const { config, ctx, logger } = runs.makeRun({ maxRounds: 3 });
    // No --yes, and confirmDestruction is given a stdin that is not a terminal, exactly as a
    // piped or cron-driven run has.
    const error = await sweep.run(config, { ctx }).catch((e) => e);

    assert.ok(error instanceof UserError, "expected a refusal, got " + error);
    assert.match(error.message, /without confirmation/);
    assert.deepEqual(fake.calls.deleted, [], "no tweet may be deleted on an unconfirmed run");
    // It got as far as round 2 - i.e. the old `round === 1` gate really was skipped.
    assert.match(logger.text(), /Round 2: found 1 post/);
  } finally {
    fake.restore();
  }
});

test("sweep: the round that actually deletes is the round that asks", async () => {
  const fake = runs.installFakeX({ timeline: flakyFirstRound() });
  try {
    const { config, ctx, logger } = runs.makeRun({ flags: { yes: true }, maxRounds: 2 });
    await sweep.run(config, { ctx });

    const banners = logger.lines.filter((line) => /THIS PERMANENTLY DELETES TWEETS/.test(line));
    assert.equal(banners.length, 1, "asked exactly once");
    assert.ok(fake.calls.deleted.length > 0, "and then deleted");
    assert.equal(ctx.gate.armed, true);
  } finally {
    fake.restore();
  }
});

test("sweep: a gate that never gets armed cannot delete, even if the confirmation step is skipped", async () => {
  // Stands in for any future code path that reaches the loop without confirming: the guard is on
  // the destructive call itself, so the failure mode is an error, not a wiped account.
  const fake = runs.installFakeX({ timeline: () => ok(runs.timelinePage(["555"])) });
  try {
    const { config, ctx } = runs.makeRun({ flags: { yes: true }, maxRounds: 1 });
    ctx.gate.arm = () => {}; // confirmation "runs", but the gate stays shut

    const error = await sweep.run(config, { ctx }).catch((e) => e);
    assert.ok(error instanceof UserError);
    assert.match(error.message, /never passed the confirmation gate/);
    assert.deepEqual(fake.calls.deleted, []);
  } finally {
    fake.restore();
  }
});

test("nuke: an unconfirmed archive pass deletes nothing", async () => {
  const fake = runs.installFakeX();
  try {
    const { config, ctx } = runs.makeRun({ archiveIds: ["1", "2", "3"] });
    const error = await nuke.run(config, { ctx }).catch((e) => e);
    assert.ok(error instanceof UserError);
    assert.deepEqual(fake.calls.deleted, []);
  } finally {
    fake.restore();
  }
});

test("run: one confirmation covers both passes, and neither pass asks again", async () => {
  const fake = runs.installFakeX({ timeline: (n) => ok(runs.timelinePage(n === 1 ? ["555"] : [])) });
  try {
    const { config, ctx } = runs.makeRun({ flags: { yes: true }, archiveIds: ["1", "2"], maxRounds: 3 });
    const logger = ctx.logger;
    // `run` confirms once up front and then hands the same armed context to both passes; this is
    // that sequence, without `run`'s own context construction.
    const { confirmDestruction } = require("../src/confirm");
    await confirmDestruction({
      handle: "realaccount",
      action: "delete everything",
      verified: true,
      assumeYes: true,
      logger,
      gate: ctx.gate,
    });
    const before = logger.lines.filter((l) => /THIS PERMANENTLY DELETES/.test(l)).length;

    await nuke.run(config, { ctx });
    await sweep.run(config, { ctx });

    const after = logger.lines.filter((l) => /THIS PERMANENTLY DELETES/.test(l)).length;
    assert.equal(before, 1);
    assert.equal(after, 1, "the passes must not re-ask once the run has been confirmed");
    assert.ok(fake.calls.deleted.length >= 3);
  } finally {
    fake.restore();
  }
});

// ---------------------------------------------------------------------------
// BLOCKER 2 - the gate must not be able to name the wrong account
// ---------------------------------------------------------------------------

test("sweep: --handle naming another account stops the run before any mutation", async () => {
  const fake = runs.installFakeX({ timeline: () => ok(runs.timelinePage(["555"])) });
  try {
    const { config, ctx, logger } = runs.makeRun({
      flags: { handle: "totally-different-account", yes: true },
      maxRounds: 1,
    });
    const error = await sweep.run(config, { ctx }).catch((e) => e);

    assert.ok(error instanceof UserError);
    assert.match(error.message, /@totally-different-account/);
    assert.match(error.message, /@realaccount/);
    assert.deepEqual(fake.calls.deleted, []);
    // And it never printed a banner naming the wrong account.
    assert.equal(/totally-different-account/.test(logger.text()), false);
  } finally {
    fake.restore();
  }
});

test("sweep: the banner names the account X confirmed, and says so", async () => {
  const fake = runs.installFakeX({ timeline: (n) => ok(runs.timelinePage(n === 1 ? ["555"] : [])) });
  try {
    const { config, ctx, logger } = runs.makeRun({ flags: { yes: true }, maxRounds: 3 });
    await sweep.run(config, { ctx });
    assert.match(logger.text(), /Account : @realaccount {2}\(confirmed by X/);
    assert.equal(fake.calls.probe > 0, true, "the identity probe must actually happen");
  } finally {
    fake.restore();
  }
});

test("sweep: an unreachable identity probe still deletes, but the banner says UNVERIFIED", async () => {
  const fake = runs.installFakeX({
    timeline: (n) => ok(runs.timelinePage(n === 1 ? ["555"] : [])),
    probe: () => {
      throw new Error("getaddrinfo ENOTFOUND x.com");
    },
  });
  try {
    const { config, ctx, logger } = runs.makeRun({ flags: { yes: true }, maxRounds: 3 });
    await sweep.run(config, { ctx });
    assert.match(logger.text(), /UNVERIFIED/);
    assert.deepEqual(fake.calls.deleted, ["555"]);
  } finally {
    fake.restore();
  }
});

// ---------------------------------------------------------------------------
// --dry-run issues nothing. Instrumented, not assumed.
// ---------------------------------------------------------------------------

test("sweep --dry-run issues zero mutations and leaves the gate disarmed", async () => {
  const fake = runs.installFakeX({ timeline: () => ok(runs.timelinePage(["1", "2", "3"])) });
  try {
    const { config, ctx, logger } = runs.makeRun({ flags: { "dry-run": true } });
    const code = await sweep.run(config, { ctx });

    assert.equal(code, 0);
    assert.deepEqual(fake.calls.deleted, []);
    assert.deepEqual(fake.calls.unretweeted, []);
    assert.equal(ctx.gate.armed, false);
    assert.match(logger.text(), /DRY RUN - nothing will be deleted/);
  } finally {
    fake.restore();
  }
});

test("nuke --dry-run issues zero mutations", async () => {
  const fake = runs.installFakeX();
  try {
    const { config, ctx, logger } = runs.makeRun({
      flags: { "dry-run": true },
      archiveIds: ["1", "2", "3"],
    });
    const code = await nuke.run(config, { ctx });

    assert.equal(code, 0);
    assert.deepEqual(fake.calls.deleted, []);
    assert.equal(ctx.gate.armed, false);
    assert.match(logger.text(), /Would delete 3 tweet\(s\)/);
  } finally {
    fake.restore();
  }
});

test("run --dry-run issues zero mutations across both passes", async () => {
  const fake = runs.installFakeX({ timeline: () => ok(runs.timelinePage(["9"])) });
  try {
    const { config } = runs.makeRun({ flags: { "dry-run": true }, archiveIds: ["1", "2"] });
    const code = await run.run(config);

    assert.equal(code, 0);
    assert.deepEqual(fake.calls.deleted, []);
    assert.deepEqual(fake.calls.unretweeted, []);
  } finally {
    fake.restore();
  }
});

test("a retweet is un-retweeted and deleted only after confirmation", async () => {
  const retweetPage = {
    data: {
      user: {
        result: {
          timeline: {
            instructions: [
              {
                entries: [
                  {
                    content: {
                      itemContent: {
                        tweet_results: {
                          result: {
                            legacy: {
                              id_str: "700",
                              user_id_str: "111",
                              retweeted_status_result: { result: { rest_id: "700-source" } },
                            },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };
  const fake = runs.installFakeX({ timeline: (n) => ok(n === 1 ? retweetPage : runs.timelinePage([])) });
  try {
    const { config, ctx } = runs.makeRun({ flags: { yes: true }, maxRounds: 3 });
    await sweep.run(config, { ctx });
    assert.deepEqual(fake.calls.unretweeted, ["700-source"]);
    assert.deepEqual(fake.calls.deleted, ["700"]);
  } finally {
    fake.restore();
  }
});

// ---------------------------------------------------------------------------
// --limit must not report success for a run that stopped early on purpose
// ---------------------------------------------------------------------------

test("sweep --limit exits non-zero and says the account is not empty", async () => {
  const fake = runs.installFakeX({ timeline: () => ok(runs.timelinePage(["1", "2", "3", "4", "5"])) });
  try {
    const { config, ctx, logger } = runs.makeRun({ flags: { yes: true, limit: "2" }, maxRounds: 5 });
    const code = await sweep.run(config, { ctx });

    assert.equal(fake.calls.deleted.length, 2);
    assert.notEqual(code, 0, "an intentionally incomplete run must not exit 0");
    assert.match(logger.text(), /STOPPED EARLY/);
    assert.equal(ctx.stoppedAtLimit, true);
  } finally {
    fake.restore();
  }
});

test("nuke --limit exits non-zero while archive tweets are still queued", async () => {
  const fake = runs.installFakeX();
  try {
    const { config, ctx, logger } = runs.makeRun({
      flags: { yes: true, limit: "2" },
      archiveIds: ["1", "2", "3", "4", "5"],
    });
    const code = await nuke.run(config, { ctx });

    assert.equal(fake.calls.deleted.length, 2);
    assert.notEqual(code, 0);
    assert.match(logger.text(), /STOPPED EARLY/);
    assert.match(logger.text(), /3 archive tweet\(s\) were never attempted/);
  } finally {
    fake.restore();
  }
});

test("nuke --limit higher than what is left still exits 0 - the pass really did finish", async () => {
  const fake = runs.installFakeX();
  try {
    const { config, ctx, logger } = runs.makeRun({
      flags: { yes: true, limit: "50" },
      archiveIds: ["1", "2", "3"],
    });
    const code = await nuke.run(config, { ctx });

    assert.equal(fake.calls.deleted.length, 3);
    assert.equal(code, 0);
    assert.equal(/STOPPED EARLY/.test(logger.text()), false);
  } finally {
    fake.restore();
  }
});

test("run --limit never prints 'Done.' and exits non-zero", async () => {
  const fake = runs.installFakeX({ timeline: () => ok(runs.timelinePage(["a", "b", "c", "d"])) });
  const { config } = runs.makeRun({ flags: { yes: true, limit: "2" }, maxRounds: 3 });

  // `run` builds its own logger, and the closing verdict is console-only, so read the console.
  const printed = [];
  const realLog = console.log;
  console.log = (...args) => printed.push(args.join(" "));
  let code;
  try {
    code = await run.run(config);
  } finally {
    console.log = realLog;
    fake.restore();
  }

  const output = printed.join("\n");
  assert.equal(fake.calls.deleted.length, 2);
  assert.notEqual(code, 0, "an intentionally incomplete run must not exit 0");
  assert.equal(/ {2}Done\./.test(output), false, "'Done.' after --limit is a lie");
  assert.match(output, /STOPPED EARLY/);
  assert.match(output, /stopped early at --limit 2/);
});

// ---------------------------------------------------------------------------
// A clean sweep still reports clean
// ---------------------------------------------------------------------------

test("sweep: a full pass that finds nothing reports CLEAN and exits 0", async () => {
  const fake = runs.installFakeX({ timeline: () => ok(runs.timelinePage([])) });
  try {
    const { config, ctx, logger } = runs.makeRun({ flags: { yes: true } });
    const code = await sweep.run(config, { ctx });
    assert.equal(code, 0);
    assert.match(logger.text(), /CLEAN/);
    assert.deepEqual(fake.calls.deleted, []);
  } finally {
    fake.restore();
  }
});

test("sweep: a round that found nothing but failed to read anything is never reported CLEAN", async () => {
  const fake = runs.installFakeX({ timeline: () => runs.response(500, "boom") });
  try {
    const { config, ctx, logger } = runs.makeRun({ flags: { yes: true }, maxRounds: 2 });
    const code = await sweep.run(config, { ctx });
    assert.equal(code, 1);
    assert.equal(/CLEAN/.test(logger.text()), false);
    assert.deepEqual(fake.calls.deleted, []);
  } finally {
    fake.restore();
  }
});

// ---------------------------------------------------------------------------
// The page cap is the third way a pass can stop looking without running out of timeline.
// It used to be invisible: not logged, not counted, indistinguishable from reaching the end.
// ---------------------------------------------------------------------------

test("sweep: a round that stopped at the page cap is never reported CLEAN", async () => {
  // Every page is empty of your posts but still offers a fresh cursor, so pagination is cut short
  // by the cap rather than by the end of the timeline. Zero posts found here proves nothing.
  const fake = runs.installFakeX({ timeline: (n) => ok(runs.timelinePage([], "111", "cursor-" + n)) });
  try {
    const { config, ctx, logger } = runs.makeRun({ flags: { yes: true }, maxRounds: 2 });
    config.maxTimelinePages = 2;
    const code = await sweep.run(config, { ctx });

    assert.equal(code, 1, "a pass that stopped looking must not exit 0");
    assert.equal(/CLEAN/.test(logger.text()), false);
    assert.match(logger.text(), /page cap/);
    assert.match(logger.text(), /does not count as clean/);
    assert.deepEqual(fake.calls.deleted, []);
  } finally {
    fake.restore();
  }
});

test("sweep: hitting the page cap is reported to the user, naming the timeline", async () => {
  const fake = runs.installFakeX({ timeline: (n) => ok(runs.timelinePage(["1"], "111", "cursor-" + n)) });
  try {
    const { config, ctx, logger } = runs.makeRun({ flags: { yes: true }, maxRounds: 1 });
    config.maxTimelinePages = 2;
    await sweep.run(config, { ctx });
    assert.match(logger.text(), /Stopped paging UserOriginalsTimeline at the 2-page cap/);
  } finally {
    fake.restore();
  }
});

test("sweep: a timeline that ends normally is not treated as capped", async () => {
  const fake = runs.installFakeX({ timeline: () => ok(runs.timelinePage([])) });
  try {
    const { config, ctx, logger } = runs.makeRun({ flags: { yes: true }, maxRounds: 2 });
    config.maxTimelinePages = 2;
    const code = await sweep.run(config, { ctx });
    assert.equal(code, 0);
    assert.match(logger.text(), /CLEAN/);
    assert.equal(/page cap/.test(logger.text()), false);
  } finally {
    fake.restore();
  }
});

// ---------------------------------------------------------------------------
// Mid-run silence. A job that runs for hours unattended has to keep saying what it is doing.
// ---------------------------------------------------------------------------

test("sweep: the deletion loop reports progress instead of going silent for a whole round", async () => {
  const many = Array.from({ length: 60 }, (_, i) => String(1000 + i));
  const fake = runs.installFakeX({ timeline: (n) => ok(runs.timelinePage(n === 1 ? many : [])) });
  try {
    const { config, ctx, logger } = runs.makeRun({ flags: { yes: true }, maxRounds: 3 });
    await sweep.run(config, { ctx });

    assert.equal(fake.calls.deleted.length, 60);
    assert.match(logger.text(), /Round 1 progress 50\/60/);
    assert.match(logger.text(), /"remaining":10/);
    assert.match(logger.text(), /Round 1 deleted 60/);
  } finally {
    fake.restore();
  }
});

test("nuke: progress lines say how many are left and how fast the recent window went", async () => {
  const many = Array.from({ length: 60 }, (_, i) => String(2000 + i));
  const fake = runs.installFakeX();
  try {
    const { config, ctx, logger } = runs.makeRun({ flags: { yes: true }, archiveIds: many });
    await nuke.run(config, { ctx });

    assert.equal(fake.calls.deleted.length, 60);
    assert.match(logger.text(), /Progress 50\/60/);
    assert.match(logger.text(), /"remaining":10/);
    // A rate is reported (or honestly withheld), and it is never the misleading lifetime average.
    assert.match(logger.text(), /"perMinute":(\d+|null)/);
  } finally {
    fake.restore();
  }
});

// ---------------------------------------------------------------------------
// A failed delete must never be recorded as handled: a handled id is skipped forever.
// ---------------------------------------------------------------------------

test("sweep: an id whose delete failed is still queued for the next run", async () => {
  const fake = runs.installFakeX({
    timeline: (n) => ok(runs.timelinePage(n === 1 ? ["901"] : [])),
    onDelete: () => runs.response(500, "<html>Internal Server Error</html>"),
  });
  try {
    const { config, ctx } = runs.makeRun({ flags: { yes: true }, maxRounds: 2 });
    await sweep.run(config, { ctx });

    const { loadState } = require("../src/state");
    const state = loadState(config.stateFile);
    assert.equal(state.isHandled("901"), false, "a failure must never be recorded as handled");
    assert.equal(state.counts().failed, 1);
  } finally {
    fake.restore();
  }
});

test("nuke: an id whose delete failed is retried by the next run rather than skipped", async () => {
  const fake = runs.installFakeX({
    onDelete: (id) => (id === "2" ? runs.response(500, "boom") : runs.response(200, { data: { delete_tweet: {} } })),
  });
  try {
    const first = runs.makeRun({ flags: { yes: true }, archiveIds: ["1", "2", "3"] });
    await nuke.run(first.config, { ctx: first.ctx });
    assert.deepEqual(fake.calls.deleted, ["1", "2", "3"]);

    // Same data directory, so the second run reads the first run's state file.
    const { createRunContext } = require("../src/context");
    const ctx2 = createRunContext(first.config);
    ctx2.logger = runs.recordingLogger();
    ctx2.client.sleep = async () => {};
    ctx2.gate.arm("realaccount");
    await nuke.run(first.config, { ctx: ctx2 });

    assert.deepEqual(fake.calls.deleted, ["1", "2", "3", "2"], "only the failure is retried");
  } finally {
    fake.restore();
  }
});
