"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { readArchiveIds, resolveArchiveFiles } = require("../src/archive");
const { UserError } = require("../src/errors");
const { makeTmpDirs } = require("./helpers/tmp");

const tmp = makeTmpDirs("xtn-archive-");
function tmpDir() {
  return tmp.create();
}

test.after(() => tmp.cleanup());

function tweet(id, createdAt) {
  return { tweet: { id_str: id, created_at: createdAt } };
}

test("strips the real window.YTD.tweets.part0 = prefix", () => {
  const dir = tmpDir();
  const file = path.join(dir, "tweets.js");
  fs.writeFileSync(
    file,
    "window.YTD.tweets.part0 = " + JSON.stringify([tweet("1", "Mon Jan 01 00:00:00 +0000 2024")])
  );
  const result = readArchiveIds(file);
  assert.deepEqual(result.ids, ["1"]);
});

test("strips a numbered part prefix (part1, part2, ...)", () => {
  const dir = tmpDir();
  const file = path.join(dir, "tweets-part2.js");
  fs.writeFileSync(
    file,
    "window.YTD.tweets.part2 = " + JSON.stringify([tweet("1", "Mon Jan 01 00:00:00 +0000 2024")])
  );
  const result = readArchiveIds(file);
  assert.deepEqual(result.ids, ["1"]);
});

test("a UTF-8 BOM at the start of the file does not break parsing", () => {
  const dir = tmpDir();
  const file = path.join(dir, "tweets.js");
  const body = "window.YTD.tweets.part0 = " + JSON.stringify([tweet("1", "Mon Jan 01 00:00:00 +0000 2024")]);
  fs.writeFileSync(file, "﻿" + body, "utf8");
  const result = readArchiveIds(file);
  assert.deepEqual(result.ids, ["1"]);
});

test("ids come out sorted oldest-first", () => {
  const dir = tmpDir();
  const file = path.join(dir, "tweets.js");
  const data = [
    tweet("3", "Wed Jan 03 00:00:00 +0000 2024"),
    tweet("1", "Mon Jan 01 00:00:00 +0000 2024"),
    tweet("2", "Tue Jan 02 00:00:00 +0000 2024"),
  ];
  fs.writeFileSync(file, "window.YTD.tweets.part0 = " + JSON.stringify(data));
  const result = readArchiveIds(file);
  assert.deepEqual(result.ids, ["1", "2", "3"]);
});

test("duplicate ids are deduped, keeping the first occurrence in sorted order", () => {
  const dir = tmpDir();
  const file = path.join(dir, "tweets.js");
  const data = [
    tweet("1", "Mon Jan 01 00:00:00 +0000 2024"),
    tweet("2", "Tue Jan 02 00:00:00 +0000 2024"),
    tweet("1", "Mon Jan 01 00:00:00 +0000 2024"),
  ];
  fs.writeFileSync(file, "window.YTD.tweets.part0 = " + JSON.stringify(data));
  const result = readArchiveIds(file);
  assert.deepEqual(result.ids, ["1", "2"]);
  assert.equal(result.total, 2);
});

test("a plain array of string ids is also accepted", () => {
  const dir = tmpDir();
  const file = path.join(dir, "tweets.js");
  fs.writeFileSync(file, "window.YTD.tweets.part0 = " + JSON.stringify(["5", "6"]));
  const result = readArchiveIds(file);
  assert.deepEqual(result.ids.sort(), ["5", "6"]);
});

test("a malformed (non-JSON) archive file raises a clear UserError, not a raw stack trace", () => {
  const dir = tmpDir();
  const file = path.join(dir, "tweets.js");
  fs.writeFileSync(file, "window.YTD.tweets.part0 = { this is not valid json ]");
  assert.throws(() => readArchiveIds(file), UserError);
});

test("a well-formed JSON file that is not an array raises a clear UserError", () => {
  const dir = tmpDir();
  const file = path.join(dir, "tweets.js");
  fs.writeFileSync(file, "window.YTD.tweets.part0 = " + JSON.stringify({ not: "an array" }));
  assert.throws(() => readArchiveIds(file), UserError);
});

test("a missing archive path resolves to zero files/ids instead of throwing", () => {
  const dir = tmpDir();
  const result = readArchiveIds(path.join(dir, "does-not-exist.js"));
  assert.deepEqual(result, { ids: [], files: [], total: 0 });
});

test("resolveArchiveFiles accepts a directory and picks up tweets*.js files inside it", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "tweets.js"), "window.YTD.tweets.part0 = []");
  fs.writeFileSync(path.join(dir, "unrelated.txt"), "nope");
  const files = resolveArchiveFiles(dir);
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith("tweets.js"));
});

test("entries missing an id are skipped rather than crashing", () => {
  const dir = tmpDir();
  const file = path.join(dir, "tweets.js");
  const data = [{ tweet: { created_at: "Mon Jan 01 00:00:00 +0000 2024" } }, tweet("1", "Mon Jan 01 00:00:00 +0000 2024")];
  fs.writeFileSync(file, "window.YTD.tweets.part0 = " + JSON.stringify(data));
  const result = readArchiveIds(file);
  assert.deepEqual(result.ids, ["1"]);
});

// The real archive file the owner keeps in the repo root - read-only, used only as a realistic
// large input. Never modified, never deleted. `tweets.js` is gitignored, so this only runs on a
// checkout that happens to have one next to it.
test("parses the real tweets.js archive in the repo root (read-only, realistic-size input)", () => {
  const realFile = path.resolve(__dirname, "..", "tweets.js");
  if (!fs.existsSync(realFile)) {
    return; // Not every checkout carries a personal archive; skip quietly.
  }
  const result = readArchiveIds(realFile);
  assert.ok(result.ids.length > 0);
  assert.equal(result.ids.length, new Set(result.ids).size, "ids must be deduped");
  assert.ok(
    result.ids.every((id) => /^\d+$/.test(id)),
    "every id must be a numeric string"
  );
});
