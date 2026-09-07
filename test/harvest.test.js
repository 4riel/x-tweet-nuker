"use strict";
/**
 * `sweep`'s harvest step, offline.
 *
 * This is the second-most-dangerous decision in the tool. Everything it returns feeds one
 * question - is this account empty, or did the sweep merely stop looking? - and the difference
 * between those two answers is the difference between a true CLEAN and telling somebody their
 * timeline is clear while every post is still on it.
 *
 * It had no tests at all. It takes its client, config and logger as parameters, so it needs no
 * network and no session: a stub client is enough, and nothing here can issue a real request.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { harvest, EMPTY_PAGES_BEFORE_DONE } = require("../src/commands/sweep");

function recordingLogger() {
  const lines = [];
  const record = (level) => (message, data) =>
    lines.push(level + " " + message + (data === undefined ? "" : " " + JSON.stringify(data)));
  return {
    lines,
    text: () => lines.join("\n"),
    info: record("INFO"),
    warn: record("WARN"),
    error: record("ERROR"),
    debug: record("DEBUG"),
    plain: record("PLAIN"),
  };
}

/** One timeline page as fetchTimelinePage returns it. */
function page(ids, cursor) {
  return {
    items: new Map(ids.map((id) => [String(id), { id: String(id), retweetOf: null }])),
    cursors: cursor ? [cursor] : [],
    failed: false,
  };
}

const failedPage = () => ({ items: new Map(), cursors: [], failed: true });

/**
 * A client whose fetchTimelinePage is driven by a script.
 * @param {(url: string, cursor: string|null, n: number) => object|null} script
 */
function stubClient(script) {
  const calls = [];
  return {
    calls,
    sleep: async () => {},
    fetchTimelinePage: async (url, cursor) => {
      calls.push({ url, cursor });
      return script(url, cursor, calls.length);
    },
  };
}

const config = (overrides = {}) => ({
  maxTimelinePages: 200,
  timelinePageDelayMs: 0,
  ...overrides,
});

const ids = (result) => result.items.map((item) => item.id).sort();

// ---------------------------------------------------------------------------
// What it collects
// ---------------------------------------------------------------------------

test("harvest returns the account's own posts from a single timeline", async () => {
  const client = stubClient(() => page(["1", "2"]));
  const result = await harvest({
    client,
    config: config(),
    logger: recordingLogger(),
    timelines: [["UserOriginalsTimeline", "https://x.com/tl"]],
  });
  assert.deepEqual(ids(result), ["1", "2"]);
  assert.equal(result.failedPages, 0);
  assert.deepEqual(result.cappedTimelines, []);
});

test("harvest de-duplicates a post that appears on two timelines", async () => {
  const client = stubClient((url) => (url.includes("a") ? page(["1", "2"]) : page(["2", "3"])));
  const result = await harvest({
    client,
    config: config(),
    logger: recordingLogger(),
    timelines: [
      ["A", "https://x.com/a"],
      ["B", "https://x.com/b"],
    ],
  });
  assert.deepEqual(ids(result), ["1", "2", "3"]);
});

test("harvest follows the cursor from one page to the next, and stops when none is offered", async () => {
  const client = stubClient((url, cursor) => {
    if (cursor === null) return page(["1"], "c1");
    if (cursor === "c1") return page(["2"], "c2");
    return page(["3"]);
  });
  const result = await harvest({
    client,
    config: config(),
    logger: recordingLogger(),
    timelines: [["A", "https://x.com/a"]],
  });
  assert.deepEqual(ids(result), ["1", "2", "3"]);
  assert.deepEqual(
    client.calls.map((call) => call.cursor),
    [null, "c1", "c2"]
  );
});

test("harvest stops paging a timeline that keeps repeating the same cursor", async () => {
  const client = stubClient(() => page(["1"], "same-cursor"));
  const result = await harvest({
    client,
    config: config(),
    logger: recordingLogger(),
    timelines: [["A", "https://x.com/a"]],
  });
  // The second page would be handed the cursor it was already on, so pagination ends instead.
  assert.equal(client.calls.length, 2);
  assert.deepEqual(ids(result), ["1"]);
});

test("harvest walks past pages that hold nothing of yours, and gives up after a few in a row", async () => {
  const client = stubClient((url, cursor, n) => (n === 1 ? page(["1"], "c" + n) : page([], "c" + n)));
  const result = await harvest({
    client,
    config: config(),
    logger: recordingLogger(),
    timelines: [["A", "https://x.com/a"]],
  });
  assert.deepEqual(ids(result), ["1"]);
  assert.equal(client.calls.length, 1 + EMPTY_PAGES_BEFORE_DONE);
});

// ---------------------------------------------------------------------------
// failedPages - the guard that stops a failed read being reported as an empty account
// ---------------------------------------------------------------------------

test("a page that could not be read is counted, so an empty result is not mistaken for an empty account", async () => {
  const client = stubClient(() => failedPage());
  const result = await harvest({
    client,
    config: config(),
    logger: recordingLogger(),
    timelines: [["A", "https://x.com/a"]],
  });
  assert.deepEqual(result.items, []);
  assert.equal(result.failedPages, 1);
});

test("failedPages accumulates across timelines and does not reset per timeline", async () => {
  const client = stubClient(() => failedPage());
  const result = await harvest({
    client,
    config: config(),
    logger: recordingLogger(),
    timelines: [
      ["A", "https://x.com/a"],
      ["B", "https://x.com/b"],
    ],
  });
  assert.equal(result.failedPages, 2);
});

test("posts that DID load still come back from a pass that also had a failed page", async () => {
  const client = stubClient((url, cursor, n) => (n === 1 ? page(["7"], "c1") : failedPage()));
  const result = await harvest({
    client,
    config: config(),
    logger: recordingLogger(),
    timelines: [["A", "https://x.com/a"]],
  });
  assert.deepEqual(ids(result), ["7"]);
  assert.equal(result.failedPages, 1);
});

// ---------------------------------------------------------------------------
// The rate-limit sentinel must not burn the page budget
// ---------------------------------------------------------------------------

test("a rate-limited page (null) retries the same cursor", async () => {
  const client = stubClient((url, cursor, n) => (n === 1 ? null : page(["1"])));
  await harvest({
    client,
    config: config(),
    logger: recordingLogger(),
    timelines: [["A", "https://x.com/a"]],
  });
  assert.deepEqual(
    client.calls.map((call) => call.cursor),
    [null, null],
    "the retry must ask for the same cursor, not skip ahead"
  );
});

test("a rate-limited page does not consume one of the timeline's pages", async () => {
  // Two pages of budget, and a 429 in the middle. The 429 read nothing, so charging it a page
  // would end this timeline one page short - posts left behind, and nothing said about it.
  const client = stubClient((url, cursor, n) => {
    if (n === 1) return page(["1"], "c1");
    if (n === 2) return null;
    return page(["2"]);
  });
  const result = await harvest({
    client,
    config: config({ maxTimelinePages: 2 }),
    logger: recordingLogger(),
    timelines: [["A", "https://x.com/a"]],
  });
  assert.deepEqual(ids(result), ["1", "2"]);
  assert.deepEqual(result.cappedTimelines, []);
});

// ---------------------------------------------------------------------------
// The page cap - "stopped looking" must never look like "nothing left"
// ---------------------------------------------------------------------------

test("a timeline still handing out cursors at the page cap is reported as capped", async () => {
  const client = stubClient((url, cursor, n) => page([String(n)], "c" + n));
  const logger = recordingLogger();
  const result = await harvest({
    client,
    config: config({ maxTimelinePages: 3 }),
    logger,
    timelines: [["A", "https://x.com/a"]],
  });
  assert.equal(client.calls.length, 3, "the cap is still a cap");
  assert.deepEqual(result.cappedTimelines, ["A"]);
  assert.deepEqual(ids(result), ["1", "2", "3"]);
});

test("hitting the page cap is logged, naming the timeline and the cap", async () => {
  const client = stubClient((url, cursor, n) => page([String(n)], "c" + n));
  const logger = recordingLogger();
  await harvest({
    client,
    config: config({ maxTimelinePages: 2 }),
    logger,
    timelines: [["UserRepliesTimeline", "https://x.com/a"]],
  });
  assert.match(logger.text(), /WARN Stopped paging UserRepliesTimeline at the 2-page cap/);
  assert.match(logger.text(), /cannot count as a clean one/);
});

test("a timeline that simply ends is NOT reported as capped", async () => {
  const client = stubClient((url, cursor, n) => (n === 1 ? page(["1"], "c1") : page(["2"])));
  const result = await harvest({
    client,
    config: config({ maxTimelinePages: 2 }),
    logger: recordingLogger(),
    timelines: [["A", "https://x.com/a"]],
  });
  assert.deepEqual(result.cappedTimelines, []);
});

test("each capped timeline is named separately", async () => {
  const client = stubClient((url, cursor, n) => page([String(n)], "c" + n));
  const result = await harvest({
    client,
    config: config({ maxTimelinePages: 1 }),
    logger: recordingLogger(),
    timelines: [
      ["A", "https://x.com/a"],
      ["B", "https://x.com/b"],
    ],
  });
  assert.deepEqual(result.cappedTimelines, ["A", "B"]);
});
