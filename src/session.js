/**
 * Captures a logged-in x.com session to disk so every other command can run without a browser.
 *
 * What gets captured, and why each piece is needed:
 *  - the cookie header and ct0 CSRF token: the only credentials the internal API accepts
 *  - the numeric user id, read from the twid cookie: timelines are queried by id, not handle
 *  - live GraphQL queryIds scraped from X's own JS bundles: X rotates these, so hardcoded
 *    values are only a last-resort fallback
 *  - real timeline request URLs observed in flight: replaying a captured URL keeps all of X's
 *    required feature flags intact instead of trying to reconstruct them
 */
const fs = require("fs");
const path = require("path");
const { UserError } = require("./errors");

/** Last-resort values, correct at the time of writing. The scraper is the real source. */
const FALLBACK_QUERY_IDS = {
  DeleteTweet: "VaenaVgh5q5ih7kvyVjgtg",
  UnretweetTweet: "iQtK4dl5hBmXewYZuEOKVw",
};

/**
 * Timeline operations X has actually used. X renamed these once already: UserTweets,
 * UserTweetsAndReplies and UserMedia stopped firing and became UserOriginalsTimeline,
 * UserRepliesTimeline and UserVideoTimeline. Both generations are listed, and the permissive
 * matcher below catches a third generation we have not seen yet.
 */
const KNOWN_TIMELINE_OPS = [
  "UserOriginalsTimeline",
  "UserRepliesTimeline",
  "UserVideoTimeline",
  "UserMediaTimeline",
  "UserHighlightsTimeline",
  "UserRepostsTimeline",
  "UserTweets",
  "UserTweetsAndReplies",
  "UserMedia",
];

/** Lookups, not timelines - capturing these would waste sweep passes on empty payloads. */
const NOT_A_TIMELINE = /^User(ByScreenName|ByRestId|sByRestIds|Business|Premium)/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isTimelineOperation(name) {
  if (KNOWN_TIMELINE_OPS.includes(name)) return true;
  if (NOT_A_TIMELINE.test(name)) return false;
  return /^User[A-Za-z]*(Timeline|Tweets|Media|Replies|Posts)$/.test(name);
}

function loadSession(sessionFile) {
  if (!fs.existsSync(sessionFile)) {
    throw new UserError(
      "No saved X session found at " + sessionFile + ".",
      "Run `x-tweet-nuker login` first - it opens a browser so you can sign in to X."
    );
  }
  try {
    return JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  } catch (e) {
    throw new UserError(
      "The session file at " + sessionFile + " is not readable JSON.",
      "Delete it and run `x-tweet-nuker login` again."
    );
  }
}

function saveSession(sessionFile, data) {
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify(data, null, 2));
  // The file holds live login cookies. Restrict it where the platform honours file modes.
  try {
    fs.chmodSync(sessionFile, 0o600);
  } catch (e) {
    // Windows ignores POSIX modes; the gitignore entry is the real protection there.
  }
}

function requirePlaywright() {
  try {
    return require("playwright");
  } catch (e) {
    throw new UserError(
      "Playwright is not installed, and the browser is required to sign in.",
      "Run `npm install` in this directory, then `npx playwright install chromium`."
    );
  }
}

/**
 * Open a browser, wait for a logged-in x.com session, and write the session file.
 *
 * @param {object} options
 * @param {object} options.config
 * @param {object} options.logger
 * @param {number} [options.loginTimeoutMs] how long to wait for the user to sign in
 * @returns {Promise<object>} the saved session payload
 */
async function captureSession({ config, logger, loginTimeoutMs = 5 * 60 * 1000 }) {
  const { chromium } = requirePlaywright();
  const headless = config.headless === undefined ? false : config.headless;

  const launchOptions = {
    headless,
    viewport: { width: 1280, height: 900 },
    // X serves a degraded experience to obviously automated browsers.
    args: ["--disable-blink-features=AutomationControlled"],
  };
  if (config.chromeExecutable) launchOptions.executablePath = config.chromeExecutable;

  fs.mkdirSync(config.browserProfileDir, { recursive: true });

  let context;
  try {
    context = await chromium.launchPersistentContext(config.browserProfileDir, launchOptions);
  } catch (e) {
    throw new UserError(
      "Could not start the browser: " + e.message,
      "If a previous run is still open, close it and delete " +
        path.join(config.browserProfileDir, "SingletonLock") +
        ". If Chromium is missing, run `npx playwright install chromium`."
    );
  }

  try {
    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(60000);

    // Record every GraphQL operation the page fires. The timeline names are the fragile part
    // of this tool, so the full observed list is kept for diagnostics.
    const timelineUrls = {};
    const seenOperations = new Set();
    page.on("request", (req) => {
      const match = req.url().match(/\/graphql\/[\w-]+\/([A-Za-z0-9_]+)/);
      if (!match) return;
      const operation = match[1];
      seenOperations.add(operation);
      if (isTimelineOperation(operation) && !timelineUrls[operation]) {
        timelineUrls[operation] = req.url();
      }
    });

    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" }).catch(() => {});

    const cookies = await waitForLogin({ context, page, logger, timeoutMs: loginTimeoutMs, headless });
    const byName = Object.fromEntries(cookies.map((c) => [c.name, c.value]));
    const cookieHeader = cookies.map((c) => c.name + "=" + c.value).join("; ");
    const myUserId = decodeURIComponent(byName.twid || "").replace(/^u=/, "");
    if (!myUserId) {
      throw new UserError(
        "Signed in, but X did not set the twid cookie that identifies your account.",
        "Reload x.com in the opened browser, make sure your profile loads, then run `login` again."
      );
    }

    const handle = config.handle || (await detectHandle(page));
    if (!handle) {
      throw new UserError(
        "Could not work out which handle is signed in.",
        "Re-run with --handle <your-handle> (no @)."
      );
    }
    logger.info("Signed in", { handle, userId: myUserId });

    const queryIds = await scrapeQueryIds({ context, page, logger });

    // Visiting the profile tabs is what makes the timeline requests fire so they can be captured.
    logger.info("Capturing timeline requests from your profile tabs");
    // Every tab that can render your own posts, so each one's timeline request gets captured. A
    // timeline the sweep never captured is a timeline the sweep can never clear, so a tab that
    // only fires its operation when you are standing on it has to be visited:
    //  - Highlights fires UserHighlightsTimeline only there.
    //  - Reposts (a separate profile tab now, at /<handle>/reposts) fires UserRepostsTimeline
    //    only there - the Posts tab fires UserOriginalsTimeline, which is originals.
    for (const suffix of ["/with_replies", "", "/media", "/highlights", "/reposts"]) {
      await page
        .goto("https://x.com/" + handle + suffix, { waitUntil: "domcontentloaded" })
        .catch(() => {});
      await sleep(7000);
    }

    const capturedOps = Object.keys(timelineUrls);
    if (capturedOps.length === 0) {
      logger.warn("No timeline requests were captured", {
        graphqlOperationsSeen: Array.from(seenOperations).sort(),
      });
      logger.warn(
        "X has probably renamed its timeline operations again. Add the new name to KNOWN_TIMELINE_OPS in src/session.js - the list above is what your browser actually requested."
      );
    } else {
      logger.info("Captured timeline operations", { operations: capturedOps });
    }

    const data = {
      handle,
      myUserId,
      cookieHeader,
      ct0: byName.ct0,
      queryIds,
      timelineUrls,
      graphqlOperationsSeen: Array.from(seenOperations).sort(),
      savedAt: new Date().toISOString(),
    };
    saveSession(config.sessionFile, data);
    logger.info("Session saved", { file: config.sessionFile });
    logger.warn("That file contains live login cookies. Treat it like a password.");
    return data;
  } finally {
    await context.close().catch(() => {});
  }
}

/** Poll for the auth cookies, prompting the user to sign in if they are not there yet. */
async function waitForLogin({ context, page, logger, timeoutMs, headless }) {
  const deadline = Date.now() + timeoutMs;
  let prompted = false;

  for (;;) {
    const cookies = await context.cookies(["https://x.com"]);
    const byName = Object.fromEntries(cookies.map((c) => [c.name, c.value]));
    if (byName.auth_token && byName.ct0) return cookies;

    if (Date.now() > deadline) {
      throw new UserError(
        "Timed out waiting for an X login.",
        headless
          ? "Run `x-tweet-nuker login` without --headless so you can see and complete the login form."
          : "Sign in to x.com in the browser window that opens, then leave it open until this command finishes."
      );
    }

    if (!prompted) {
      prompted = true;
      if (headless) {
        throw new UserError(
          "No saved X login in this browser profile, and the browser is headless.",
          "Run `x-tweet-nuker login` without --headless, sign in once, and the profile is reused after that."
        );
      }
      logger.plain("");
      logger.plain("  Sign in to X in the browser window that just opened.");
      logger.plain("  This command will continue by itself once you are logged in.");
      logger.plain("");
      await page.goto("https://x.com/login", { waitUntil: "domcontentloaded" }).catch(() => {});
    }

    await sleep(3000);
  }
}

/** The signed-in handle is on the profile link in the app's own nav bar. */
async function detectHandle(page) {
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" }).catch(() => {});
  for (let attempt = 0; attempt < 10; attempt++) {
    const href = await page
      .evaluate(() => {
        const link =
          document.querySelector('a[data-testid="AppTabBar_Profile_Link"]') ||
          document.querySelector('nav a[href^="/"][role="link"][aria-label*="Profile" i]');
        return link ? link.getAttribute("href") : null;
      })
      .catch(() => null);
    const handle = (href || "").replace(/^\//, "").split("/")[0];
    if (handle) return handle;
    await sleep(2000);
  }
  return null;
}

/**
 * Scrape the current queryIds out of X's loaded JS bundles.
 *
 * Both key orderings are tried because the bundler emits either one depending on the build.
 */
async function scrapeQueryIds({ context, page, logger }) {
  const queryIds = { ...FALLBACK_QUERY_IDS };
  const operations = Object.keys(FALLBACK_QUERY_IDS);

  const scripts = await page
    .evaluate(() => {
      const fromTags = Array.from(document.querySelectorAll("script[src]")).map((s) => s.src);
      // Chunks loaded after first paint never appear as script tags, only as resource timings.
      const fromTimings = performance.getEntriesByType("resource").map((entry) => entry.name);
      return fromTags.concat(fromTimings);
    })
    .catch(() => []);

  const bundles = [...new Set(scripts)].filter(
    (url) => url.includes("abs.twimg.com") && url.endsWith(".js")
  );

  const found = new Set();
  for (const url of bundles) {
    if (found.size === operations.length) break;
    let body;
    try {
      const res = await context.request.get(url, { timeout: 20000 });
      if (!res.ok()) continue;
      body = await res.text();
    } catch (e) {
      continue;
    }
    for (const operation of operations) {
      const a = body.match(new RegExp('queryId:"([\\w-]+)",operationName:"' + operation + '"'));
      const b = body.match(new RegExp('operationName:"' + operation + '",queryId:"([\\w-]+)"'));
      const id = (a && a[1]) || (b && b[1]);
      if (id) {
        queryIds[operation] = id;
        found.add(operation);
      }
    }
  }

  const missing = operations.filter((op) => !found.has(op));
  if (missing.length > 0) {
    logger.warn("Could not scrape live queryIds, using built-in fallbacks", {
      operations: missing,
      bundlesScanned: bundles.length,
    });
  } else {
    logger.info("Scraped live GraphQL queryIds", { operations: Array.from(found) });
  }
  return queryIds;
}

/** Human-readable age of a saved session, used by `status` and by the pre-run warnings. */
function sessionAgeHours(session) {
  if (!session || !session.savedAt) return null;
  const saved = Date.parse(session.savedAt);
  if (!Number.isFinite(saved)) return null;
  // Clamp: a clock skew between the capture machine and this one must not read as negative.
  return Math.max(0, (Date.now() - saved) / 3600000);
}

module.exports = {
  captureSession,
  loadSession,
  saveSession,
  sessionAgeHours,
  isTimelineOperation,
  KNOWN_TIMELINE_OPS,
  FALLBACK_QUERY_IDS,
};
