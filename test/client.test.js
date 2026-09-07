"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createClient, collectOwnTweets, MAX_RATE_LIMIT_ATTEMPTS } = require("../src/client");
const { UserError, SessionExpiredError } = require("../src/errors");
const { jsonResponse, fakeResponse, queuedFetch } = require("./helpers/fake-fetch");

const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
});

function session(overrides = {}) {
  return {
    cookieHeader: "auth_token=abc; ct0=tok",
    ct0: "tok",
    myUserId: "111",
    queryIds: { DeleteTweet: "qid-delete", UnretweetTweet: "qid-unretweet" },
    ...overrides,
  };
}

function silentLogger() {
  const calls = { warn: [], info: [], debug: [] };
  return {
    calls,
    warn: (msg, ctx) => calls.warn.push({ msg, ctx }),
    info: (msg, ctx) => calls.info.push({ msg, ctx }),
    debug: (msg, ctx) => calls.debug.push({ msg, ctx }),
    plain: () => {},
  };
}

function makeClient(config = {}, sessionOverrides = {}) {
  const logger = silentLogger();
  const client = createClient({ session: session(sessionOverrides), logger, config });
  return { client, logger };
}

// ---------------------------------------------------------------------------
// createClient guards
// ---------------------------------------------------------------------------

test("createClient throws UserError when the session has no cookies", () => {
  assert.throws(
    () => createClient({ session: { myUserId: "1" }, logger: silentLogger() }),
    UserError
  );
});

test("createClient throws UserError when the session has no myUserId", () => {
  assert.throws(
    () => createClient({ session: { cookieHeader: "a=b", ct0: "t" }, logger: silentLogger() }),
    UserError
  );
});

// ---------------------------------------------------------------------------
// Delete-response classification - the highest blast-radius surface in the tool.
// ---------------------------------------------------------------------------

test("deleteTweet: HTTP 200 with data.delete_tweet is classified as deleted", async () => {
  global.fetch = queuedFetch([jsonResponse(200, { data: { delete_tweet: { tweet_results: {} } } })]);
  const { client } = makeClient();
  const result = await client.deleteTweet("1");
  assert.deepEqual(result, { status: "deleted" });
});

test("deleteTweet: HTTP 200 with data.tweet_delete (renamed field) is classified as deleted", async () => {
  global.fetch = queuedFetch([jsonResponse(200, { data: { tweet_delete: { tweet_results: {} } } })]);
  const { client } = makeClient();
  const result = await client.deleteTweet("1");
  assert.deepEqual(result, { status: "deleted" });
});

test("deleteTweet: a 404 HTML page whose body merely contains 'not found' is an error, never gone", async () => {
  global.fetch = queuedFetch([
    fakeResponse(404, "<html><body>404 Not Found - this page is not found</body></html>"),
  ]);
  const { client } = makeClient();
  const result = await client.deleteTweet("1");
  assert.equal(result.status, "error");
  assert.notEqual(result.status, "gone");
  assert.equal(result.http, 404);
});

test("deleteTweet: HTTP 500 HTML error page is classified as error", async () => {
  global.fetch = queuedFetch([fakeResponse(500, "<html>Internal Server Error</html>")]);
  const { client } = makeClient();
  const result = await client.deleteTweet("1");
  assert.equal(result.status, "error");
  assert.equal(result.http, 500);
});

test("deleteTweet: structured GraphQL error 'No status found' is classified as gone", async () => {
  global.fetch = queuedFetch([jsonResponse(200, { errors: [{ message: "No status found." }] })]);
  const { client } = makeClient();
  const result = await client.deleteTweet("1");
  assert.equal(result.status, "gone");
});

test("deleteTweet: 'Not authorized.' is an error, not gone (not our tweet to delete)", async () => {
  global.fetch = queuedFetch([jsonResponse(200, { errors: [{ message: "Not authorized." }] })]);
  const { client } = makeClient();
  const result = await client.deleteTweet("1");
  assert.equal(result.status, "error");
});

test("deleteTweet: HTTP 200 with an empty body is an error, not a silent success", async () => {
  global.fetch = queuedFetch([fakeResponse(200, "")]);
  const { client } = makeClient();
  const result = await client.deleteTweet("1");
  assert.equal(result.status, "error");
});

test("deleteTweet: a network failure is reported as error without retrying", async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    throw new Error("getaddrinfo ENOTFOUND x.com");
  };
  const { client } = makeClient();
  const result = await client.deleteTweet("1");
  assert.equal(result.status, "error");
  assert.match(result.message, /network:/);
  assert.equal(calls, 1);
});

test("deleteTweet: HTTP 401 throws SessionExpiredError", async () => {
  global.fetch = queuedFetch([fakeResponse(401, "")]);
  const { client } = makeClient();
  await assert.rejects(() => client.deleteTweet("1"), SessionExpiredError);
});

test("deleteTweet: HTTP 403 throws SessionExpiredError", async () => {
  global.fetch = queuedFetch([fakeResponse(403, "")]);
  const { client } = makeClient();
  await assert.rejects(() => client.deleteTweet("1"), SessionExpiredError);
});

test("deleteTweet: an ambiguous GraphQL error not matching ALREADY_GONE is an error, never gone", async () => {
  global.fetch = queuedFetch([jsonResponse(200, { errors: [{ message: "Something went wrong." }] })]);
  const { client } = makeClient();
  const result = await client.deleteTweet("1");
  assert.equal(result.status, "error");
});

test("unretweet: HTTP 200 with data.unretweet is classified as unretweeted", async () => {
  global.fetch = queuedFetch([jsonResponse(200, { data: { unretweet: { source_tweet_results: {} } } })]);
  const { client } = makeClient();
  const result = await client.unretweet("1");
  assert.deepEqual(result, { status: "unretweeted" });
});

// ---------------------------------------------------------------------------
// Rate-limit wait maths - seconds vs milliseconds is the classic failure here.
// ---------------------------------------------------------------------------

async function tickThrough(t, times, ms) {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(ms);
  }
  await new Promise((resolve) => setImmediate(resolve));
}

test("waitForRateLimit: a future x-rate-limit-reset is honoured", async (t) => {
  const NOW = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const futureResetSeconds = Math.floor(NOW / 1000) + 50; // 50s in the future
  global.fetch = queuedFetch([
    jsonResponse(429, { errors: [] }, { "x-rate-limit-reset": String(futureResetSeconds) }),
    jsonResponse(200, { data: { delete_tweet: {} } }),
  ]);
  const { client, logger } = makeClient();

  const resultPromise = client.deleteTweet("1");
  await tickThrough(t, 1, 60 * 1000);
  const result = await resultPromise;

  assert.deepEqual(result, { status: "deleted" });
  assert.equal(logger.calls.warn.length, 1);
  // headerMs = 50s*1000 + 5000 buffer = 55000ms -> "waiting 55s"
  assert.match(logger.calls.warn[0].msg, /waiting 55s/);
  assert.match(logger.calls.warn[0].msg, /waiting for the rate-limit window/);
});

test("waitForRateLimit: a reset timestamp in the past does not produce a near-instant retry", async (t) => {
  const NOW = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const pastResetSeconds = Math.floor(NOW / 1000) - 1000; // long past
  global.fetch = queuedFetch([
    jsonResponse(429, { errors: [] }, { "x-rate-limit-reset": String(pastResetSeconds) }),
    jsonResponse(200, { data: { delete_tweet: {} } }),
  ]);
  const { client, logger } = makeClient();

  const resultPromise = client.deleteTweet("1");
  await tickThrough(t, 1, 5 * 60 * 1000);
  const result = await resultPromise;

  assert.deepEqual(result, { status: "deleted" });
  assert.equal(logger.calls.warn.length, 1);
  // Must fall back to the 60s floor of the backoff schedule, not a tight ~15s retry.
  assert.match(logger.calls.warn[0].msg, /waiting 60s/);
  assert.match(logger.calls.warn[0].msg, /reset time already passed/);
});

test("waitForRateLimit: consecutive 429s escalate 60s/120s/240s/480s and cap at 15 minutes", async (t) => {
  const NOW = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  let call = 0;
  global.fetch = async () => {
    call++;
    // No reset header at all on the first 5 calls, then succeed.
    if (call <= 5) return jsonResponse(429, { errors: [] });
    return jsonResponse(200, { data: { delete_tweet: {} } });
  };
  const { client, logger } = makeClient();

  const resultPromise = client.deleteTweet("1");
  await tickThrough(t, 5, 15 * 60 * 1000);
  const result = await resultPromise;

  assert.deepEqual(result, { status: "deleted" });
  const waits = logger.calls.warn.map((c) => c.msg.match(/waiting (\d+)s/)[1]).map(Number);
  assert.deepEqual(waits, [60, 120, 240, 480, 900]); // 900s = 15 minutes, the cap
});

test("waitForRateLimit: honours config.maxRateLimitWaitMs as an overall cap", async (t) => {
  const NOW = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  global.fetch = queuedFetch([
    jsonResponse(429, { errors: [] }),
    jsonResponse(200, { data: { delete_tweet: {} } }),
  ]);
  const { client, logger } = makeClient({ maxRateLimitWaitMs: 10_000 });

  const resultPromise = client.deleteTweet("1");
  await tickThrough(t, 1, 10_000);
  const result = await resultPromise;

  assert.deepEqual(result, { status: "deleted" });
  // Backoff schedule would ask for 60s, but the configured cap must win.
  assert.match(logger.calls.warn[0].msg, /waiting 10s/);
});

test("waitForRateLimit: repeated 429s eventually abort instead of looping forever", async (t) => {
  const NOW = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return jsonResponse(429, { errors: [] });
  };
  const { client, logger } = makeClient();

  const resultPromise = client.deleteTweet("1");
  let caught = null;
  resultPromise.catch((e) => {
    caught = e;
  });

  await tickThrough(t, MAX_RATE_LIMIT_ATTEMPTS + 1, 15 * 60 * 1000);

  assert.ok(caught instanceof UserError, "should abort with a UserError, not hang");
  assert.match(caught.message, /rate limited the same request/);
  // One fetch per attempt, plus the final attempt that trips the abort without waiting again.
  assert.equal(calls, MAX_RATE_LIMIT_ATTEMPTS + 1);
  assert.equal(logger.calls.warn.length, MAX_RATE_LIMIT_ATTEMPTS);
});

// ---------------------------------------------------------------------------
// Timeline ownership filter (collectOwnTweets) - what stops the tool deleting someone
// else's content during `sweep`.
// ---------------------------------------------------------------------------

function ownTweetEntry(id, userId, extra = {}) {
  return { content: { itemContent: { tweet_results: { result: { legacy: { id_str: id, user_id_str: userId, ...extra } } } } } };
}

test("collectOwnTweets: collects a tweet authored by the session's own user id", () => {
  const items = new Map();
  const cursors = [];
  collectOwnTweets(ownTweetEntry("100", "111"), "111", items, cursors);
  assert.deepEqual(Array.from(items.keys()), ["100"]);
  assert.deepEqual(items.get("100"), { id: "100", retweetOf: null });
});

test("collectOwnTweets: ignores another user's tweet in the same payload", () => {
  const items = new Map();
  const cursors = [];
  const payload = {
    instructions: [
      { entries: [ownTweetEntry("100", "111"), ownTweetEntry("200", "999")] },
    ],
  };
  collectOwnTweets(payload, "111", items, cursors);
  assert.deepEqual(Array.from(items.keys()), ["100"]);
});

test("collectOwnTweets: a retweet yields the source tweet id for the unretweet step", () => {
  const items = new Map();
  const cursors = [];
  const retweet = ownTweetEntry("300", "111", {
    retweeted_status_result: { result: { rest_id: "300-source" } },
  });
  collectOwnTweets(retweet, "111", items, cursors);
  assert.deepEqual(items.get("300"), { id: "300", retweetOf: "300-source" });
});

test("collectOwnTweets: falls back to legacy.id_str when the retweet source has no rest_id", () => {
  const items = new Map();
  const cursors = [];
  const retweet = ownTweetEntry("301", "111", {
    retweeted_status_result: { result: { legacy: { id_str: "301-source" } } },
  });
  collectOwnTweets(retweet, "111", items, cursors);
  assert.deepEqual(items.get("301"), { id: "301", retweetOf: "301-source" });
});

test("collectOwnTweets: finds the bottom cursor via cursorType", () => {
  const items = new Map();
  const cursors = [];
  const payload = { entries: [{ cursorType: "Bottom", value: "cursor-abc" }] };
  collectOwnTweets(payload, "111", items, cursors);
  assert.deepEqual(cursors, ["cursor-abc"]);
});

test("collectOwnTweets: finds the bottom cursor via a cursor-bottom entryId", () => {
  const items = new Map();
  const cursors = [];
  const payload = { entries: [{ entryId: "cursor-bottom-123", content: { value: "cursor-xyz" } }] };
  collectOwnTweets(payload, "111", items, cursors);
  assert.deepEqual(cursors, ["cursor-xyz"]);
});

test("collectOwnTweets: does not blow up on null/primitive nodes", () => {
  const items = new Map();
  const cursors = [];
  assert.doesNotThrow(() => collectOwnTweets(null, "111", items, cursors));
  assert.doesNotThrow(() => collectOwnTweets("a string", "111", items, cursors));
  assert.doesNotThrow(() => collectOwnTweets(42, "111", items, cursors));
});
