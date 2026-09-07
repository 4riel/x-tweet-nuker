/**
 * `verify` - prove the account is actually empty, through a different surface than the deleter.
 *
 * A deleter counting its own successes is not evidence, so this opens the real profile in a
 * browser and reports what is still rendered. Two things make that harder than it looks:
 *
 *  - X serves a logged-out visitor EMPTY timelines on Posts, Replies and Media. A signed-out
 *    check of an account with thousands of live posts renders nothing at all, which is
 *    indistinguishable from success if all you do is count cards. So this command proves it is
 *    signed in before it believes anything, and refuses outright when it is not.
 *  - "I rendered zero posts" is not the same claim as "X told me this timeline is empty". Only
 *    the second is evidence, so CLEAN requires X's own empty-state message; without it the
 *    answer is "could not confirm", never "clean".
 *
 * Authentication comes from the session file that `nuke` and `sweep` use, injected into a fresh
 * browser context. That is deliberate: the browser profile `login` leaves behind and the saved
 * session were two separate stores of credentials that could disagree, and the one that
 * disagreed silently was the one doing the verifying.
 */
const { createRunContext } = require("../context");
const { UserError, SessionExpiredError } = require("../errors");
const { USER_AGENT } = require("../client");
const { PROFILE_TABS } = require("../session");

/**
 * Every profile tab that can render your own posts - the same list `login` visits to capture the
 * timeline requests `sweep` pages through, deliberately imported rather than repeated. Checking a
 * tab the sweep never captured would report NOT CLEAN forever and send the user to a sweep that
 * cannot clear it; see PROFILE_TABS in src/session.js.
 */
const TABS = PROFILE_TABS;

/**
 * Last-resort wording check, used only when neither structural signal below is present. X
 * rewords these strings and translates them, so a text miss is reported as "could not confirm"
 * rather than quietly resolved into either answer.
 */
const EMPTY_STATE =
  /(hasn.t posted|haven.t posted|hasn.t replied|haven.t replied|hasn.t highlighted|haven.t highlighted|no posts yet|nothing to see here)/i;

/**
 * X's own words for "this profile is not being shown to you": suspended, protected, or no such
 * account. These used to sit in EMPTY_STATE, which made a suspended account - an account that
 * still holds every post it ever made, merely hidden - come back as CLEAN. Hidden is not empty,
 * and none of these is evidence about what the account contains, so they get their own verdict
 * that can never resolve to CLEAN.
 */
const UNAVAILABLE_STATE =
  /(account is suspended|account suspended|these posts are protected|owner limits who can view|doesn.t exist|does not exist)/i;

/** X renders this while a timeline failed to load - which is not the same as it being empty. */
const LOAD_FAILURE = /something went wrong|try again|retry/i;

/** A tweet page that is gone. Same caveat about wording as above. */
const MISSING_POST =
  /doesn.t exist|does not exist|Hmm...this page|not available|Post unavailable|page doesn.t exist/i;

const flags = {
  "--handle <name>": "profile to check (defaults to the signed-in account)",
  "--ids <a,b,c>": "also check that these specific tweet ids are gone",
  "--headless": "run the browser headless (default; use --no-headless to watch)",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Turn the saved cookie header into Playwright cookies, so a fresh browser context is signed in
 * as exactly the account the deleter acts as.
 */
function sessionCookies(session) {
  const cookies = [];
  for (const part of String((session && session.cookieHeader) || "").split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!name) continue;
    for (const domain of [".x.com", ".twitter.com"]) {
      cookies.push({ name, value, domain, path: "/", secure: true });
    }
  }
  return cookies;
}

/**
 * Everything one page can tell us, read in a single pass inside the browser.
 *
 * Runs in the page, so it must stay self-contained - no imports, no closures.
 */
function readPage(name) {
  const signedIn = Boolean(
    document.querySelector(
      '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Profile_Link"], [data-testid="SideNav_NewTweet_Button"], [data-testid="DashButton_ProfileIcon_Link"]'
    )
  );
  const loginWall = Boolean(
    document.querySelector(
      '[data-testid="loginButton"], [data-testid="signupButton"], [data-testid="login"], a[href="/i/flow/login"], a[href="/login"]'
    )
  );

  const prefix = "/" + String(name).toLowerCase() + "/status/";
  const own = new Set();
  const reposted = new Set();

  // Only links inside a rendered post are counted; the rest of the page (nav, "who to follow",
  // trends) also carries /status/ links that say nothing about this profile.
  for (const article of document.querySelectorAll("article")) {
    for (const link of article.querySelectorAll('a[href*="/status/"]')) {
      const href = (link.getAttribute("href") || "").toLowerCase();
      const match = href.match(/^\/([^/]+)\/status\/(\d+)/);
      if (!match) continue;
      if (href.startsWith(prefix)) own.add(match[2]);
      else reposted.add(match[2]);
    }
  }

  const column = document.querySelector('[data-testid="primaryColumn"]');

  // X's own explicit "there is nothing in this timeline" element. It carries a test id, so it
  // survives rewording and translation in a way the message text does not. It is what the
  // Replies, Media and Highlights tabs render when they hold nothing.
  const emptyStateMarker = Boolean(
    column &&
      column.querySelector('[data-testid="empty_state_header_text"], [data-testid="emptyState"]')
  );

  // The Posts tab renders no empty-state message at all for the account's own owner: X just
  // renders the timeline region with nothing in it. The region carries aria-label "Timeline:
  // <name>'s posts", and it must be looked for INSIDE the primary column - the sidebar has its
  // own "Timeline: Trending now" region that would otherwise be mistaken for the profile's.
  const timeline = column ? column.querySelector('[aria-label^="Timeline"]') : null;

  // The empty-state message sits in the timeline column, well past the 200 characters of nav
  // chrome a body-text sample used to return - which is why that signal never once fired. Read
  // the column itself, and read enough of it.
  const readable = column || document.body;
  return {
    signedIn,
    loginWall,
    articles: document.querySelectorAll("article").length,
    ownStatusLinks: own.size,
    repostedStatusLinks: reposted.size,
    emptyStateMarker,
    timelineRendered: Boolean(timeline),
    timelineArticles: timeline ? timeline.querySelectorAll("article").length : -1,
    text: ((readable && readable.innerText) || "").replace(/\s+/g, " ").slice(0, 2000),
  };
}

/**
 * The single safety-critical judgement in this tool: what one profile tab proves.
 *
 * Kept as a pure function of `readPage`'s output so it can be tested without a browser - the
 * verdict that decides whether a user is told their account is empty is the last thing that
 * should only ever be exercised by hand against a live profile.
 *
 * Three independent ways for X to say "this timeline holds nothing", strongest first. Any one of
 * them is proof; none of them is "could not confirm", never "clean". A timeline that failed to
 * load is explicitly not proof of anything - but content that DID render still counts against
 * you even on a page that partly failed, so `stillThere` is decided first.
 *
 * @param {ReturnType<typeof readPage>} info what the page reported
 * @param {{loadFailed?: boolean}} [options] pass `loadFailed` to override the text-based check
 * @returns {"stillThere"|"unavailable"|"confirmedEmpty"|"unconfirmed"}
 */
function classifyTab(info, options = {}) {
  const text = String((info && info.text) || "");
  const loadFailed = options.loadFailed === undefined ? LOAD_FAILURE.test(text) : Boolean(options.loadFailed);

  // Anything still rendered counts against you: your own posts link to /<handle>/status/...,
  // a repost links to the ORIGINAL author's status, and a card with neither is still a card.
  if (
    info.ownStatusLinks > 0 ||
    info.repostedStatusLinks > 0 ||
    info.articles > 0 ||
    info.timelineArticles > 0
  ) {
    return "stillThere";
  }

  // A profile X is refusing to show renders nothing, exactly like an empty one. The difference is
  // that everything is probably still there, so this can never become CLEAN.
  if (UNAVAILABLE_STATE.test(text)) return "unavailable";

  const provenEmpty =
    !loadFailed &&
    (info.emptyStateMarker ||
      (info.timelineRendered && info.timelineArticles === 0) ||
      EMPTY_STATE.test(text));

  return provenEmpty ? "confirmedEmpty" : "unconfirmed";
}

async function run(config) {
  // The session file is the single source of truth for who this run is: it is what the deleter
  // authenticates with, so it is what the independent check has to authenticate with too.
  const ctx = createRunContext(config);
  const { logger, session, client } = ctx;

  // Cheap, browser-free proof that the cookies still work, and a last resort for the handle.
  const probe = await client.fetchOwnHandle();
  if (probe.expired) throw new SessionExpiredError();
  if (!probe.ok) {
    logger.warn("Could not reach X to check the session before opening the browser", {
      error: probe.error || "HTTP " + probe.http,
    });
  }

  const handle = config.handle || session.handle || (probe.ok ? probe.handle : null);
  // Checking someone else's profile is a legitimate use of --handle, so this is a warning rather
  // than a refusal - but a CLEAN verdict about a profile that is not the one being emptied is
  // worthless as reassurance, and it must not be presented as if it were.
  const sameAccount = Boolean(probe.ok && probe.handle && handle && handle.toLowerCase() === probe.handle.toLowerCase());
  if (probe.ok && probe.handle && handle && !sameAccount) {
    logger.warn(
      "Checking @" +
        handle +
        ", which is NOT the account this session signs in as (@" +
        probe.handle +
        "). Whatever this reports says nothing about @" +
        probe.handle +
        "."
    );
  }
  if (!handle) {
    throw new UserError(
      "Do not know which profile to check.",
      "Pass --handle <your-handle>, or run `x-tweet-nuker login` so the handle is recorded."
    );
  }

  const { chromium } = requirePlaywright();
  const launchOptions = {
    headless: config.headless === undefined ? true : config.headless,
    args: ["--disable-blink-features=AutomationControlled"],
  };
  if (config.chromeExecutable) launchOptions.executablePath = config.chromeExecutable;

  let browser;
  try {
    browser = await chromium.launch(launchOptions);
  } catch (e) {
    throw new UserError(
      "Could not start the browser: " + e.message,
      "Run `npx playwright install chromium`, or point --chrome-executable at a Chrome you already have."
    );
  }

  const ids = String(config.ids || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  let stillThere = 0;
  const unconfirmed = [];
  const unavailable = [];
  const confirmedEmpty = [];

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
      userAgent: USER_AGENT,
    });
    await context.addCookies(sessionCookies(session));
    const page = await context.newPage();
    page.setDefaultTimeout(45000);

    await requireSignedIn(page, logger);

    for (const id of ids) {
      const gone = await checkTweetGone(page, id);
      logger.info("Tweet " + id + ": " + (gone ? "gone" : "STILL VISIBLE"));
      if (!gone) stillThere++;
    }

    for (const tab of TABS) {
      const label = tab || "/posts";
      const info = await inspectTab(page, handle, tab);

      // A login wall on any tab makes everything measured from it worthless.
      if (!info.signedIn) {
        throw notSignedIn("X stopped serving a signed-in page while checking " + label + ".");
      }

      const loadFailed = LOAD_FAILURE.test(info.text);
      const verdict = classifyTab(info, { loadFailed });

      logger.info("Tab " + label, {
        articles: info.articles,
        ownStatusLinks: info.ownStatusLinks,
        repostedStatusLinks: info.repostedStatusLinks,
        emptyStateMarker: info.emptyStateMarker,
        timelineRendered: info.timelineRendered,
        timelineArticles: info.timelineArticles,
        loadFailed,
        verdict,
      });

      if (verdict === "stillThere") stillThere++;
      else if (verdict === "unavailable") unavailable.push(label);
      else if (verdict === "confirmedEmpty") confirmedEmpty.push(label);
      else unconfirmed.push(label);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  logger.plain("");
  if (stillThere > 0) {
    logger.plain("  NOT CLEAN - posts or reposts are still visible on @" + handle + ".");
    logger.plain("  Run `x-tweet-nuker sweep` again; deletion is eventually consistent, so give it");
    logger.plain("  a few minutes first. The per-tab lines above show what was counted.");
    logger.plain("");
    return 1;
  }
  if (unavailable.length > 0) {
    logger.plain("  COULD NOT CHECK - X is not showing this profile on " + unavailable.join(", ") + ".");
    logger.plain("  It reported the account as suspended, protected, or non-existent. A profile that");
    logger.plain("  is hidden is not a profile that is empty: the posts are most likely all still");
    logger.plain("  there, just not being served. This is never reported as CLEAN. Check");
    logger.plain("  https://x.com/" + handle + " while signed in as that account.");
    logger.plain("");
    return 1;
  }
  if (unconfirmed.length > 0) {
    logger.plain("  COULD NOT CONFIRM - nothing was rendered on " + unconfirmed.join(", ") + ", but X");
    logger.plain("  never confirmed those timelines are empty, and zero cards on a page is not the");
    logger.plain("  same claim. Open https://x.com/" + handle + " yourself, or re-run with --no-headless");
    logger.plain("  to watch. (If X has restructured its profile page, the empty-state markers in");
    logger.plain("  src/commands/verify.js need updating - the per-tab lines above show what was");
    logger.plain("  and was not found.)");
    logger.plain("");
    return 1;
  }
  logger.plain("  CLEAN - every profile tab of @" + handle + " reported itself empty, checked while");
  logger.plain(
    sameAccount
      ? "  signed in as the same account the deleter uses."
      : "  signed in - but as a DIFFERENT account, so this says nothing about the one the deleter empties."
  );
  logger.plain("  Tabs confirmed empty: " + confirmedEmpty.join(", ") + ".");
  logger.plain("  The post counter in the profile header is cached and can stay wrong for days;");
  logger.plain("  check x.com/search?q=from%3A" + handle + "&f=live if you want a third opinion.");
  logger.plain("");
  return 0;
}

function notSignedIn(what) {
  return new UserError(
    what +
      " A signed-out browser is served EMPTY timelines for every account, so this check cannot tell an empty profile from a full one.",
    "Run `x-tweet-nuker login` to refresh the saved session, then run `x-tweet-nuker verify` again."
  );
}

/** Prove the injected cookies actually signed the browser in before measuring anything. */
async function requireSignedIn(page, logger) {
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" }).catch(() => {});
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(2500);
    const info = await page.evaluate(readPage, "").catch(() => null);
    if (info && info.signedIn) {
      logger.info("Browser is signed in with the saved session");
      return;
    }
    if (info && info.loginWall) break;
  }
  throw notSignedIn("The browser was not signed in to X with the saved session.");
}

async function inspectTab(page, handle, tab) {
  await page.goto("https://x.com/" + handle + tab, { waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(9000);
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3)).catch(() => {});
    await sleep(2000);
  }
  return page.evaluate(readPage, handle);
}

async function checkTweetGone(page, id) {
  await page.goto("https://x.com/i/status/" + id, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page
    .waitForFunction(
      (pattern) =>
        document.querySelector("article") ||
        new RegExp(pattern, "i").test((document.body && document.body.innerText) || ""),
      MISSING_POST.source,
      { timeout: 30000 }
    )
    .catch(() => {});
  await sleep(2000);
  const info = await page.evaluate(() => ({
    text: ((document.body && document.body.innerText) || "").replace(/\s+/g, " "),
    articles: document.querySelectorAll("article").length,
  }));
  return info.articles === 0 || MISSING_POST.test(info.text);
}

function requirePlaywright() {
  try {
    return require("playwright");
  } catch (e) {
    throw new UserError(
      "Playwright is not installed, and verification needs a real browser.",
      "Run `npm install`, then `npx playwright install chromium`."
    );
  }
}

module.exports = {
  run,
  flags,
  description: "Open your profile in a browser and prove it is empty",
  readPage,
  classifyTab,
  TABS,
  sessionCookies,
  requireSignedIn,
  EMPTY_STATE,
  UNAVAILABLE_STATE,
  MISSING_POST,
  LOAD_FAILURE,
};
