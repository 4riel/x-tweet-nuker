"use strict";
/**
 * A whole run, without a network, a browser, or a real account.
 *
 * The commands (`nuke`, `sweep`, `run`) had no tests at all, which is how a sweep that deletes
 * without ever asking got shipped. They are exercised here end to end: a temp data directory with
 * a session file in it, `globalThis.fetch` replaced by a scripted stand-in for x.com, and every
 * mutation that goes out recorded so a test can assert that none did.
 */
const fs = require("fs");
const path = require("path");
const { buildConfig } = require("../../src/config");
const { createRunContext } = require("../../src/context");
const { makeTmpDirs } = require("./tmp");

const tmp = makeTmpDirs("xtn-run-");

/** A session file exactly as `login` writes one: @realaccount, numeric id 111. */
const BASE_SESSION = {
  handle: "realaccount",
  myUserId: "111",
  cookieHeader: "auth_token=abc; ct0=tok",
  ct0: "tok",
  queryIds: { DeleteTweet: "qid-del", UnretweetTweet: "qid-unret" },
  timelineUrls: {
    UserOriginalsTimeline:
      "https://x.com/i/api/graphql/qid-tl/UserOriginalsTimeline?variables=%7B%22userId%22%3A%22111%22%7D",
  },
  savedAt: new Date().toISOString(),
};

function cleanup() {
  tmp.cleanup();
}

/** Everything the logger was asked to print, so a test can assert on what the operator saw. */
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

function response(status, body, headers = {}) {
  const lower = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
  return {
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: (name) => (name.toLowerCase() in lower ? lower[name.toLowerCase()] : null) },
  };
}

/**
 * A timeline page holding `ids` as posts by `userId`.
 * @param {string|null} [cursor] a bottom cursor, so a test can make the sweep keep paginating
 */
function timelinePage(ids, userId = "111", cursor = null) {
  const entries = ids.map((id) => ({
    content: {
      itemContent: {
        tweet_results: {
          result: { legacy: { id_str: String(id), user_id_str: String(userId) } },
        },
      },
    },
  }));
  if (cursor) entries.push({ entryId: "cursor-bottom-" + cursor, content: { value: cursor } });
  return { data: { user: { result: { timeline: { instructions: [{ entries }] } } } } };
}

/**
 * Stand in for x.com.
 *
 * @param {object} [options]
 * @param {(n: number) => object} [options.timeline] response for the nth timeline page fetch
 * @param {(n: number) => object} [options.probe] response for the nth identity probe
 * @param {(id: string, n: number) => object} [options.onDelete] response for the nth DeleteTweet
 * @param {string|null} [options.ownHandle] handle the identity probe reports for user id 111
 */
function installFakeX(options = {}) {
  const previous = globalThis.fetch;
  const calls = { timeline: 0, probe: 0, deleted: [], unretweeted: [], urls: [] };

  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.urls.push(target);

    if (target.includes("/account/multi/list.json")) {
      calls.probe++;
      if (options.probe) return options.probe(calls.probe);
      const handle = options.ownHandle === undefined ? "realaccount" : options.ownHandle;
      return response(200, handle ? [{ user_id: "111", screen_name: handle }] : []);
    }

    if (/\/graphql\/[^/]+\/DeleteTweet/.test(target)) {
      const id = JSON.parse(init.body).variables.tweet_id;
      calls.deleted.push(id);
      if (options.onDelete) return options.onDelete(id, calls.deleted.length);
      return response(200, { data: { delete_tweet: { tweet_results: {} } } });
    }

    if (/\/graphql\/[^/]+\/UnretweetTweet/.test(target)) {
      calls.unretweeted.push(JSON.parse(init.body).variables.source_tweet_id);
      return response(200, { data: { unretweet: { source_tweet_results: {} } } });
    }

    calls.timeline++;
    if (options.timeline) return options.timeline(calls.timeline);
    return response(200, timelinePage([]));
  };

  return { calls, restore: () => { globalThis.fetch = previous; } };
}

/**
 * A temp data directory, a config built from it, and a ready run context.
 *
 * Delays are zeroed and `client.sleep` is stubbed: a test must never spend real seconds waiting
 * out a pacing delay that exists for X's benefit.
 */
function makeRun({ flags = {}, session = {}, archiveIds = null, maxRounds = 3 } = {}) {
  const dir = tmp.create();
  const sessionData = { ...BASE_SESSION, ...session };
  fs.writeFileSync(path.join(dir, ".x-session-data.json"), JSON.stringify(sessionData, null, 2));
  if (archiveIds) {
    fs.writeFileSync(path.join(dir, "tweets.js"), JSON.stringify(archiveIds.map(String)));
  }

  // An explicit empty environment: the real one may hold X_HANDLE or LIMIT, and a safety test
  // that quietly reads the developer's own .env is not a test.
  const config = buildConfig({ "data-dir": dir, ...flags }, {});
  config.timelinePageDelayMs = 0;
  config.delayMs = 0;
  config.maxRounds = maxRounds;

  const logger = recordingLogger();
  const ctx = createRunContext(config);
  ctx.logger = logger;
  ctx.client.sleep = async () => {};

  return { dir, config, ctx, logger, session: sessionData };
}

module.exports = {
  BASE_SESSION,
  cleanup,
  installFakeX,
  makeRun,
  recordingLogger,
  response,
  timelinePage,
};
