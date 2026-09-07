"use strict";
/**
 * Everything src/commands/verify.js decides, tested without a browser.
 *
 * `classifyTab` is the per-tab verdict that CLEAN / NOT CLEAN / COULD NOT CONFIRM is built from,
 * and it is a pure function of what the page reported, so it is tested directly. Feeding it is
 * `readPage`, the structural DOM reader - written to run inside a browser page
 * (`page.evaluate(readPage, handle)`), so it is exercised here against a tiny scripted DOM
 * stand-in (test/helpers/fake-dom.js) instead of a real one. The three wording regexes and the
 * cookie-header parser are tested here too.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  readPage,
  classifyTab,
  sessionCookies,
  EMPTY_STATE,
  MISSING_POST,
  LOAD_FAILURE,
} = require("../src/commands/verify");
const { makeDocument, el } = require("./helpers/fake-dom");

const originalDocument = global.document;
test.afterEach(() => {
  global.document = originalDocument;
});

// ---------------------------------------------------------------------------
// sessionCookies
// ---------------------------------------------------------------------------

test("sessionCookies turns a cookie header into cookies for both x.com and twitter.com domains", () => {
  const cookies = sessionCookies({ cookieHeader: "auth_token=abc; ct0=xyz" });
  assert.equal(cookies.length, 4);
  const authCookies = cookies.filter((c) => c.name === "auth_token");
  assert.equal(authCookies.length, 2);
  assert.deepEqual(
    authCookies.map((c) => c.domain).sort(),
    [".twitter.com", ".x.com"]
  );
  for (const c of cookies) {
    assert.equal(c.path, "/");
    assert.equal(c.secure, true);
  }
});

test("sessionCookies returns an empty array for a missing/empty cookie header", () => {
  assert.deepEqual(sessionCookies({}), []);
  assert.deepEqual(sessionCookies({ cookieHeader: "" }), []);
});

test("sessionCookies skips malformed segments without an '='", () => {
  const cookies = sessionCookies({ cookieHeader: "auth_token=abc; garbage; ct0=xyz" });
  assert.equal(cookies.length, 4); // 2 real cookies x 2 domains, "garbage" skipped
});

// ---------------------------------------------------------------------------
// Wording regexes
// ---------------------------------------------------------------------------

test("EMPTY_STATE matches X's real empty-timeline phrasing", () => {
  for (const text of [
    "@someone hasn't posted",
    "@someone hasn't highlighted",
    "@someone hasn't replied",
    "No posts yet",
    "These posts are protected",
    "@someone's account doesn't exist",
  ]) {
    assert.ok(EMPTY_STATE.test(text), `expected match: ${text}`);
  }
});

test("EMPTY_STATE does not match ordinary rendered-content text", () => {
  assert.equal(EMPTY_STATE.test("Home / Explore / Notifications / Messages"), false);
});

test("LOAD_FAILURE matches X's error-page phrasing", () => {
  assert.ok(LOAD_FAILURE.test("Something went wrong. Try reloading."));
  assert.ok(LOAD_FAILURE.test("Try again"));
});

test("MISSING_POST matches a gone tweet's page text", () => {
  assert.ok(MISSING_POST.test("Hmm...this page doesn't exist"));
  assert.ok(MISSING_POST.test("Post unavailable"));
});

test("MISSING_POST does not match a normally rendered tweet page", () => {
  assert.equal(MISSING_POST.test("Just setting up my twttr"), false);
});

// ---------------------------------------------------------------------------
// readPage - the structural signal reader (run against a fake DOM, not a real browser)
// ---------------------------------------------------------------------------

function article(children) {
  return el("article", {}, children);
}
function statusLink(href) {
  return el("a", { href }, []);
}

test("readPage detects signed-in via the nav markers", () => {
  global.document = makeDocument([el("div", { "data-testid": "SideNav_AccountSwitcher_Button" }, [])]);
  assert.equal(readPage("me").signedIn, true);
});

test("readPage reports not signed-in and a login wall when only login controls are present", () => {
  global.document = makeDocument([el("a", { href: "/login" }, [])]);
  const info = readPage("me");
  assert.equal(info.signedIn, false);
  assert.equal(info.loginWall, true);
});

test("readPage classifies a status link inside an article as own vs reposted by handle prefix", () => {
  global.document = makeDocument([
    article([statusLink("/myhandle/status/111")]),
    article([statusLink("/someoneelse/status/222")]),
  ]);
  const info = readPage("myhandle");
  assert.equal(info.ownStatusLinks, 1);
  assert.equal(info.repostedStatusLinks, 1);
  assert.equal(info.articles, 2);
});

test("readPage's own/reposted classification is case-insensitive on the handle", () => {
  global.document = makeDocument([article([statusLink("/MyHandle/status/111")])]);
  const info = readPage("myhandle");
  assert.equal(info.ownStatusLinks, 1);
  assert.equal(info.repostedStatusLinks, 0);
});

test("readPage ignores /status/ links that are not inside an <article> (nav chrome, trends)", () => {
  global.document = makeDocument([el("a", { href: "/myhandle/status/999" }, [])]); // not in an article
  const info = readPage("myhandle");
  assert.equal(info.ownStatusLinks, 0);
  assert.equal(info.repostedStatusLinks, 0);
});

test("readPage: zero articles and no positive empty-state signal - the exact case that must never read as CLEAN", () => {
  global.document = makeDocument([el("div", { "data-testid": "primaryColumn" }, [])], "Home Explore Notifications");
  const info = readPage("myhandle");
  assert.equal(info.articles, 0);
  assert.equal(info.ownStatusLinks, 0);
  assert.equal(info.repostedStatusLinks, 0);
  assert.equal(info.emptyStateMarker, false);
  assert.equal(info.timelineRendered, false);
  assert.equal(EMPTY_STATE.test(info.text), false);
  // None of the three positive empty-state signals fired: a caller must treat this as
  // "could not confirm", never as proof the timeline is empty.
});

test("readPage: emptyStateMarker is only true when the marker is inside the primary column", () => {
  const column = el("div", { "data-testid": "primaryColumn" }, []);
  global.document = makeDocument([
    column,
    el("div", { "data-testid": "empty_state_header_text" }, []), // sibling, OUTSIDE the column
  ]);
  assert.equal(readPage("me").emptyStateMarker, false);

  const columnWithMarker = el("div", { "data-testid": "primaryColumn" }, [
    el("span", { "data-testid": "empty_state_header_text" }, [], "Nothing to see here"),
  ]);
  global.document = makeDocument([columnWithMarker]);
  assert.equal(readPage("me").emptyStateMarker, true);
});

test("readPage: timelineRendered/timelineArticles reflect the aria-label Timeline region inside the column", () => {
  const timeline = el("div", { "aria-label": "Timeline: myhandle's posts" }, [article([]), article([])]);
  const column = el("div", { "data-testid": "primaryColumn" }, [timeline]);
  global.document = makeDocument([column]);
  const info = readPage("myhandle");
  assert.equal(info.timelineRendered, true);
  assert.equal(info.timelineArticles, 2);
});

test("readPage: an empty (zero-article) rendered timeline region is timelineArticles === 0, not -1", () => {
  const timeline = el("div", { "aria-label": "Timeline: myhandle's posts" }, []);
  const column = el("div", { "data-testid": "primaryColumn" }, [timeline]);
  global.document = makeDocument([column]);
  assert.equal(readPage("myhandle").timelineArticles, 0);
});

test("readPage: timelineArticles is -1 (not 0) when no timeline region rendered at all - not the same as empty", () => {
  const column = el("div", { "data-testid": "primaryColumn" }, []);
  global.document = makeDocument([column]);
  const info = readPage("myhandle");
  assert.equal(info.timelineRendered, false);
  assert.equal(info.timelineArticles, -1);
});

test("readPage: a rendered repost still counts as content (repostedStatusLinks > 0)", () => {
  global.document = makeDocument([article([statusLink("/originalauthor/status/555")])]);
  const info = readPage("myhandle");
  assert.equal(info.articles, 1);
  assert.equal(info.repostedStatusLinks, 1);
  assert.equal(info.ownStatusLinks, 0);
  // Per verify.js's own aggregation, repostedStatusLinks > 0 alone is enough to count as
  // "still there" - a repost is not proof of an empty profile.
});

test("readPage: the sidebar's own Timeline region (e.g. Trending) is not mistaken for the column's", () => {
  const sidebarTimeline = el("div", { "aria-label": "Timeline: Trending now" }, [article([])]);
  const column = el("div", { "data-testid": "primaryColumn" }, []); // column itself has no timeline
  global.document = makeDocument([column, sidebarTimeline]); // sidebar is a sibling of the column
  const info = readPage("myhandle");
  assert.equal(info.timelineRendered, false);
  assert.equal(info.timelineArticles, -1);
});

test("readPage: text is whitespace-collapsed and capped at 2000 characters", () => {
  const longText = "word ".repeat(1000); // 5000 chars of "word "
  global.document = makeDocument([el("div", { "data-testid": "primaryColumn" }, [], longText)]);
  const info = readPage("myhandle");
  assert.ok(info.text.length <= 2000);
  assert.equal(/\s{2,}/.test(info.text), false);
});

// ---------------------------------------------------------------------------
// classifyTab - the per-tab verdict CLEAN / NOT CLEAN / COULD NOT CONFIRM is built from.
// This is the single most safety-critical judgement in the tool: getting it wrong in the
// permissive direction tells someone their account is empty when it is not.
// ---------------------------------------------------------------------------

/** A readPage-shaped result: signed in, nothing rendered, nothing proven. */
function tab(overrides = {}) {
  return {
    signedIn: true,
    loginWall: false,
    articles: 0,
    ownStatusLinks: 0,
    repostedStatusLinks: 0,
    emptyStateMarker: false,
    timelineRendered: false,
    timelineArticles: -1,
    text: "Home Explore Notifications Messages",
    ...overrides,
  };
}

test("classifyTab: zero cards with no positive signal is unconfirmed, never confirmedEmpty", () => {
  assert.equal(classifyTab(tab()), "unconfirmed");
});

test("classifyTab: zero cards with X's own empty-state marker is confirmedEmpty", () => {
  assert.equal(classifyTab(tab({ emptyStateMarker: true })), "confirmedEmpty");
});

test("classifyTab: a rendered repost is stillThere", () => {
  assert.equal(classifyTab(tab({ articles: 1, repostedStatusLinks: 1 })), "stillThere");
});

test("classifyTab: a load failure is unconfirmed, not proof either way", () => {
  assert.equal(classifyTab(tab({ text: "Something went wrong. Try reloading." })), "unconfirmed");
  assert.equal(classifyTab(tab(), { loadFailed: true }), "unconfirmed");
});

test("classifyTab: a load failure cannot be overridden by an empty-state signal", () => {
  // X's error page can still carry an emptyState container; a page that failed to load proves
  // nothing about what is on that timeline.
  assert.equal(
    classifyTab(tab({ emptyStateMarker: true }), { loadFailed: true }),
    "unconfirmed"
  );
  assert.equal(
    classifyTab(tab({ timelineRendered: true, timelineArticles: 0 }), { loadFailed: true }),
    "unconfirmed"
  );
});

test("classifyTab: content that rendered wins over a load failure (stillThere, not unconfirmed)", () => {
  assert.equal(classifyTab(tab({ articles: 2 }), { loadFailed: true }), "stillThere");
});

test("classifyTab: a rendered timeline region with zero articles is confirmedEmpty (the Posts tab)", () => {
  assert.equal(classifyTab(tab({ timelineRendered: true, timelineArticles: 0 })), "confirmedEmpty");
});

test("classifyTab: no timeline region at all (timelineArticles -1) proves nothing on its own", () => {
  assert.equal(classifyTab(tab({ timelineRendered: false, timelineArticles: -1 })), "unconfirmed");
});

test("classifyTab: recognized empty-state wording alone is enough", () => {
  assert.equal(classifyTab(tab({ text: "You haven't replied yet" })), "confirmedEmpty");
});

test("classifyTab: own posts, reposts and bare article cards each make a tab stillThere", () => {
  assert.equal(classifyTab(tab({ ownStatusLinks: 1 })), "stillThere");
  assert.equal(classifyTab(tab({ repostedStatusLinks: 1 })), "stillThere");
  assert.equal(classifyTab(tab({ articles: 1 })), "stillThere");
  assert.equal(classifyTab(tab({ timelineRendered: true, timelineArticles: 3 })), "stillThere");
});

test("classifyTab: content inside a timeline region beats that region's own empty-state marker", () => {
  assert.equal(
    classifyTab(tab({ emptyStateMarker: true, timelineRendered: true, timelineArticles: 1 })),
    "stillThere"
  );
});

// ---------------------------------------------------------------------------
// readPage -> classifyTab, against the DOM shapes a real signed-in profile actually serves.
// Recorded from a live non-Premium account: each tab proves itself empty by a different signal,
// which is why all three are kept. See docs/HOW-IT-WORKS.md.
// ---------------------------------------------------------------------------

test("live shape - Posts tab: empty timeline region, no empty-state element -> confirmedEmpty", () => {
  const timeline = el("div", { "aria-label": "Timeline: Someone's posts" }, []);
  const column = el("div", { "data-testid": "primaryColumn" }, [timeline], "Posts Replies Media");
  global.document = makeDocument([column]);
  const info = readPage("someone");
  assert.equal(info.emptyStateMarker, false);
  assert.equal(classifyTab(info), "confirmedEmpty");
});

test("live shape - Highlights tab on a non-Premium account: Premium notice inside X's own emptyState -> confirmedEmpty", () => {
  // No Premium/"subscribe" wording exists in EMPTY_STATE, and none is needed: X wraps the notice
  // in its own empty-state container, which is the strongest signal readPage looks for.
  const column = el(
    "div",
    { "data-testid": "primaryColumn" },
    [
      el("div", { "data-testid": "emptyState" }, [
        el("span", { "data-testid": "empty_state_header_text" }, [], "Highlight on your profile"),
        el(
          "span",
          { "data-testid": "empty_state_button_text" },
          [],
          "You must be subscribed to Premium to highlight posts on your profile. Subscribe to Premium"
        ),
      ]),
    ],
    "Highlight on your profile You must be subscribed to Premium to highlight posts on your profile"
  );
  global.document = makeDocument([column]);
  const info = readPage("someone");
  assert.equal(info.emptyStateMarker, true);
  assert.equal(EMPTY_STATE.test(info.text), false, "no wording match - the marker is what proves it");
  assert.equal(classifyTab(info), "confirmedEmpty");
});
