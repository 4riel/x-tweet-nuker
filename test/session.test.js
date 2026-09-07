"use strict";
/**
 * The profile-tab list, and why it is worth a test file of its own.
 *
 * Two commands depend on the same five profile tabs. `login` visits each one so the timeline
 * request it fires gets captured into the session file - and `sweep` can only page timelines the
 * session captured. `verify` then checks each tab before it will call an account empty.
 *
 * They used to be two hardcoded lists, in two files, with nothing tying them together. Let them
 * drift and the failure is unfalsifiable: `verify` checks a tab `login` never captured, reports
 * NOT CLEAN, and tells the user to run `sweep` - which cannot possibly clear a timeline it does
 * not have a request template for. The user is then told to run, forever, the one command that
 * cannot fix what they are being told to fix.
 *
 * So there is one list, exported from src/session.js, and these tests fail if a second one ever
 * appears.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const session = require("../src/session");
const verify = require("../src/commands/verify");

const SRC = path.resolve(__dirname, "..", "src");
const read = (file) => fs.readFileSync(path.join(SRC, file), "utf8");

test("PROFILE_TABS covers every profile tab that can hold your own posts", () => {
  assert.deepEqual(
    [...session.PROFILE_TABS].sort(),
    ["", "/highlights", "/media", "/reposts", "/with_replies"].sort()
  );
});

test("the tabs login visits and the tabs verify checks are the same list, not two copies", () => {
  // Same object, so they cannot drift: re-hardcoding one of them is what this catches.
  assert.strictEqual(verify.TABS, session.PROFILE_TABS);
});

test("verify does not carry a profile-tab list of its own", () => {
  const source = read(path.join("commands", "verify.js"));
  // A second list would have to name the tabs. The import is by name, so no tab path appears.
  for (const tab of ["/with_replies", "/media", "/highlights", "/reposts"]) {
    assert.equal(
      source.includes('"' + tab + '"'),
      false,
      "src/commands/verify.js hardcodes " + tab + " again - use PROFILE_TABS from src/session.js"
    );
  }
});

test("login pages the tabs from PROFILE_TABS rather than a literal list", () => {
  const source = read("session.js");
  assert.match(source, /for \(const suffix of PROFILE_TABS\)/);
  // Exactly one occurrence of each tab path in the file: the PROFILE_TABS definition itself.
  for (const tab of ["/with_replies", "/media", "/highlights", "/reposts"]) {
    const occurrences = source.split('"' + tab + '"').length - 1;
    assert.equal(occurrences, 1, "src/session.js names " + tab + " " + occurrences + " times");
  }
});

test("the tabs that only fire their timeline operation when visited are in the list", () => {
  // Highlights and Reposts fire UserHighlightsTimeline / UserRepostsTimeline only while you are
  // standing on them. Dropping either from the list silently stops the sweep ever seeing them.
  assert.ok(session.PROFILE_TABS.includes("/highlights"));
  assert.ok(session.PROFILE_TABS.includes("/reposts"));
  assert.ok(session.KNOWN_TIMELINE_OPS.includes("UserHighlightsTimeline"));
  assert.ok(session.KNOWN_TIMELINE_OPS.includes("UserRepostsTimeline"));
});
