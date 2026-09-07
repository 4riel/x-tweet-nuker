/**
 * Browser-free client for x.com's own internal GraphQL API.
 *
 * The public X API cannot do this job: a free-tier developer app that is not attached to a
 * Project is refused with "client-not-enrolled" on v2, v1.1 statuses/destroy returns 404, and
 * even the paid v2 tier allows only 17 deletions per 24 hours. So the tool replays the exact
 * requests the x.com web client makes, authenticated with the cookies captured by `login`.
 */
const { SessionExpiredError, UserError } = require("./errors");

/** Public constant the x.com web client itself ships in its JS bundle. Not a secret. */
const WEB_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/**
 * X reports an already-deleted tweet as a structured GraphQL error, not as a success. These
 * messages mean "gone" - but they are only ever matched against res.json.errors, never against a
 * raw response body, because an HTML error page containing the words "404 Not Found" would
 * otherwise be read as a success and a run that deleted nothing would report a clean sweep.
 * "not authorized" is deliberately not here: it also means "this tweet is not yours to delete".
 */
const ALREADY_GONE = /not found|no status found|does not exist/i;

/**
 * Consecutive 429s on one request before the run gives up. Eight attempts is roughly an hour of
 * escalating waits - long enough to ride out a real rate-limit window, short enough that a
 * session X has decided to refuse does not spin silently overnight.
 */
const MAX_RATE_LIMIT_ATTEMPTS = 8;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {object} options.session parsed session file
 * @param {object} options.logger
 * @param {object} [options.config]
 */
function createClient({ session, logger, config = {} }) {
  if (!session || !session.cookieHeader || !session.ct0) {
    throw new UserError(
      "The saved session file is missing its cookies.",
      "Run `x-tweet-nuker login` to capture a fresh session."
    );
  }
  // Without the account's own numeric id the ownership filter would compare against undefined:
  // every timeline post would be treated as someone else's and the sweep would report "clean".
  if (!session.myUserId) {
    throw new UserError(
      "The saved session file does not record which account it belongs to (no user id).",
      "Run `x-tweet-nuker login` again to capture a complete session."
    );
  }

  const maxWaitMs = config.maxRateLimitWaitMs || 20 * 60 * 1000;
  // Timeline 429s are counted here because each page fetch is a separate call; the mutations
  // count their own attempts locally, so one successful delete always resets the escalation.
  let timelineRateLimitAttempts = 0;

  function headers() {
    return {
      authorization: "Bearer " + WEB_BEARER,
      "content-type": "application/json",
      cookie: session.cookieHeader,
      "x-csrf-token": session.ct0,
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes",
      "x-twitter-client-language": "en",
      origin: "https://x.com",
      referer: "https://x.com/home",
      "user-agent": USER_AGENT,
    };
  }

  function queryIdFor(operation) {
    const id = session.queryIds && session.queryIds[operation];
    if (!id) {
      throw new UserError(
        "No GraphQL queryId captured for " + operation + ".",
        "X rotates these ids. Run `x-tweet-nuker login` again to scrape the current ones."
      );
    }
    return id;
  }

  /**
   * Wait out a 429.
   *
   * The server's own reset time is the best signal, but only while it points at a future moment:
   * a stale or already-past reset header would otherwise turn into a 15-second retry loop that
   * never ends and looks, from a silent terminal, exactly like normal rate limiting. So a past
   * header is treated as no header, every repeat attempt escalates past whatever the header says,
   * and a request that has been refused MAX_RATE_LIMIT_ATTEMPTS times in a row gives up with an
   * explanation instead of hammering X forever.
   *
   * @param {number} resetSeconds unix seconds from x-rate-limit-reset, 0 when absent
   * @param {number} attempt 1 for the first consecutive 429 on this request
   */
  async function waitForRateLimit(resetSeconds, attempt, context) {
    if (attempt > MAX_RATE_LIMIT_ATTEMPTS) {
      throw new UserError(
        "X rate limited the same request " +
          MAX_RATE_LIMIT_ATTEMPTS +
          " times in a row and never let it through.",
        "Stop for now and run the same command again later - your progress is saved, so it resumes " +
          "where it stopped. X throttles hard after a few thousand deletions in a day. If it starts " +
          "429ing immediately, run `x-tweet-nuker login` to refresh the session, or raise --delay."
      );
    }

    const headerMs = resetSeconds ? resetSeconds * 1000 - Date.now() + 5000 : 0;
    const usableHeader = headerMs > 0;
    // 60s, 120s, 240s ... capped at 15 minutes.
    const backoffMs = Math.min(60000 * Math.pow(2, attempt - 1), 15 * 60 * 1000);

    let waitMs;
    let reason;
    if (usableHeader && attempt === 1) {
      waitMs = Math.max(15000, headerMs);
      reason = "waiting for the rate-limit window X reported";
    } else if (usableHeader) {
      // Waiting exactly as long as X asked did not help, so wait longer than it asked.
      waitMs = Math.max(headerMs, backoffMs);
      reason = "X still refusing after its own reset time, backing off (attempt " + attempt + ")";
    } else {
      waitMs = backoffMs;
      reason = resetSeconds
        ? "reset time already passed, backing off (attempt " + attempt + ")"
        : "no reset time given, backing off (attempt " + attempt + ")";
    }

    const capped = Math.min(waitMs, maxWaitMs);
    logger.warn(
      "Rate limited by X - waiting " + Math.round(capped / 1000) + "s: " + reason,
      context
    );
    await sleep(capped);
  }

  async function request(url, init) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      return { networkError: e && e.message ? e.message : String(e) };
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      // Non-JSON bodies happen on HTML error pages; the raw text is still reported.
    }
    return {
      http: res.status,
      json,
      text,
      rateLimitReset: Number(res.headers.get("x-rate-limit-reset") || 0),
    };
  }

  async function graphqlMutation(operation, variables) {
    const queryId = queryIdFor(operation);
    return request("https://x.com/i/api/graphql/" + queryId + "/" + operation, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ variables, queryId }),
    });
  }

  /**
   * Delete one tweet, retrying through rate limits until it resolves one way or the other.
   * @returns {Promise<{status: string, message?: string, http?: number}>} deleted | gone | error
   */
  async function deleteTweet(id) {
    let rateLimitAttempts = 0;
    for (;;) {
      const res = await graphqlMutation("DeleteTweet", { tweet_id: id, dark_request: false });

      if (res.networkError) return { status: "error", message: "network: " + res.networkError };
      if (res.http === 429) {
        rateLimitAttempts++;
        await waitForRateLimit(res.rateLimitReset, rateLimitAttempts, { tweetId: id });
        continue;
      }
      if (res.http === 401 || res.http === 403) throw new SessionExpiredError();

      // A delete only counts when HTTP 200 carries the mutation payload. The success field is
      // delete_tweet; tweet_delete is accepted only as a safety net in case X renames it back.
      const data = res.http === 200 && res.json ? res.json.data : null;
      if (data && (data.delete_tweet || data.tweet_delete)) return { status: "deleted" };

      const message = errorMessage(res);
      // Believe "already gone" only when X said so in a structured GraphQL error list.
      const graphqlErrors = res.json && Array.isArray(res.json.errors) ? res.json.errors : null;
      if (graphqlErrors && ALREADY_GONE.test(graphqlErrors.map((e) => e.message || "").join(" | "))) {
        return { status: "gone", message };
      }
      return { status: "error", message, http: res.http };
    }
  }

  /** A retweet must be un-retweeted through its source tweet before its own id disappears. */
  async function unretweet(sourceTweetId) {
    let rateLimitAttempts = 0;
    for (;;) {
      const res = await graphqlMutation("UnretweetTweet", {
        source_tweet_id: sourceTweetId,
        dark_request: false,
      });
      if (res.networkError) return { status: "error", message: "network: " + res.networkError };
      if (res.http === 429) {
        rateLimitAttempts++;
        await waitForRateLimit(res.rateLimitReset, rateLimitAttempts, { sourceTweetId });
        continue;
      }
      if (res.http === 401 || res.http === 403) throw new SessionExpiredError();
      const data = res.http === 200 && res.json ? res.json.data : null;
      if (data && data.unretweet) return { status: "unretweeted" };
      return { status: "error", message: errorMessage(res), http: res.http };
    }
  }

  /**
   * Rebuild a captured timeline request with our own user id and an optional cursor.
   * The URL template comes from a real request the browser made during login, which keeps all
   * of X's other required feature flags intact without having to model them.
   */
  function timelineRequestUrl(templateUrl, cursor) {
    const url = new URL(templateUrl);
    const variables = JSON.parse(url.searchParams.get("variables") || "{}");
    variables.userId = session.myUserId;
    variables.count = config.timelinePageSize || 100;
    if (cursor) variables.cursor = cursor;
    else delete variables.cursor;
    url.searchParams.set("variables", JSON.stringify(variables));
    return url.toString();
  }

  /**
   * Fetch one timeline page.
   * Returns null to mean "rate limited, already waited, retry the same cursor".
   * `failed: true` means the page could not be read - an empty result from it proves nothing.
   */
  async function fetchTimelinePage(templateUrl, cursor) {
    const res = await request(timelineRequestUrl(templateUrl, cursor), { headers: headers() });

    if (res.networkError) {
      logger.warn("Timeline fetch failed", { error: res.networkError });
      return { items: new Map(), cursors: [], failed: true };
    }
    if (res.http === 429) {
      timelineRateLimitAttempts++;
      await waitForRateLimit(res.rateLimitReset, timelineRateLimitAttempts, { scope: "timeline" });
      return null;
    }
    timelineRateLimitAttempts = 0;
    if (res.http === 401 || res.http === 403) throw new SessionExpiredError();
    if (res.http >= 400 || !res.json) {
      logger.warn("Timeline fetch failed", {
        http: res.http,
        body: (res.text || "").slice(0, 200),
      });
      return { items: new Map(), cursors: [], failed: true };
    }

    const items = new Map();
    const cursors = [];
    collectOwnTweets(res.json, session.myUserId, items, cursors);
    return { items, cursors, failed: false };
  }

  /**
   * Resolve the logged-in handle without a browser, and double as a session health probe.
   *
   * Not account/settings.json: X has retired the v1.1 REST endpoints for the web client, and
   * every one of them now answers 404 "Sorry, that page does not exist" even with a session that
   * works perfectly. This is the account list the web app itself still calls, and the entry is
   * matched on the session's own user id - a browser can be signed in to several accounts at
   * once, and naming the wrong one on the confirmation gate would be worse than naming none.
   */
  async function fetchOwnHandle() {
    const res = await request("https://x.com/i/api/1.1/account/multi/list.json", {
      headers: headers(),
    });
    if (res.networkError) return { ok: false, error: res.networkError };
    if (res.http === 401 || res.http === 403) return { ok: false, expired: true, http: res.http };
    if (res.http >= 400 || !res.json) return { ok: false, http: res.http };

    const users = Array.isArray(res.json) ? res.json : Array.isArray(res.json.users) ? res.json.users : [];
    const mine = users.find((user) => user && String(user.user_id) === String(session.myUserId));
    // A live session that cannot name itself is still a live session; the caller decides whether
    // it needs the handle badly enough to stop.
    return { ok: true, handle: (mine && mine.screen_name) || null };
  }

  return {
    deleteTweet,
    unretweet,
    fetchTimelinePage,
    fetchOwnHandle,
    timelineRequestUrl,
    headers,
    sleep,
  };
}

function errorMessage(res) {
  if (res.json && Array.isArray(res.json.errors)) {
    return res.json.errors.map((e) => e.message || "").join(" | ");
  }
  return (res.text || "").slice(0, 200);
}

/**
 * Walk a timeline payload and pull out the account's own tweets plus the next cursor.
 *
 * X nests timeline entries differently per operation and reshapes them periodically, so a
 * recursive scan for legacy tweet objects is far more durable than following a fixed path.
 */
function collectOwnTweets(node, myUserId, items, cursors) {
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const child of node) collectOwnTweets(child, myUserId, items, cursors);
    return;
  }

  if (node.cursorType === "Bottom" && node.value) cursors.push(node.value);
  if (node.entryId && /^cursor-bottom/.test(node.entryId) && node.content && node.content.value) {
    cursors.push(node.content.value);
  }

  const legacy = node.legacy;
  if (legacy && legacy.id_str && legacy.user_id_str === myUserId) {
    const retweet = legacy.retweeted_status_result;
    const sourceId =
      retweet &&
      retweet.result &&
      (retweet.result.rest_id || (retweet.result.legacy && retweet.result.legacy.id_str));
    items.set(legacy.id_str, { id: legacy.id_str, retweetOf: sourceId || null });
  }

  for (const key of Object.keys(node)) collectOwnTweets(node[key], myUserId, items, cursors);
}

module.exports = {
  createClient,
  collectOwnTweets,
  WEB_BEARER,
  USER_AGENT,
  ALREADY_GONE,
  MAX_RATE_LIMIT_ATTEMPTS,
  sleep,
};
