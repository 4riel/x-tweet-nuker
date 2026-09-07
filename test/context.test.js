"use strict";
/**
 * Which account a run is about to empty, and whether the name it shows can be trusted.
 *
 * The handle is only a label: deletion targets the numeric user id in the session file. So a
 * handle that came from --handle, from X_HANDLE in a .env, or from an old session file can name
 * one account while another is emptied - the single worst failure a confirmation gate has. These
 * tests pin the rule: a claimed handle is checked against the account X says the session signs in
 * as, a mismatch is refused, and a handle that cannot be checked is carried through as explicitly
 * unverified rather than presented as fact.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRunContext, resolveTargetHandle } = require("../src/context");
const { UserError, SessionExpiredError } = require("../src/errors");
const runs = require("./helpers/run-context");

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});
test.after(() => runs.cleanup());

/** A context whose identity probe answers however the test wants. */
function ctxWithProbe(probeResult, ctxOverrides = {}) {
  const { ctx } = runs.makeRun();
  ctx.client.fetchOwnHandle = async () => probeResult;
  Object.assign(ctx, ctxOverrides);
  return ctx;
}

// ---------------------------------------------------------------------------
// The mismatch that must never be allowed to reach a delete
// ---------------------------------------------------------------------------

test("a claimed handle that is not the session's account is refused, naming both accounts", async () => {
  const ctx = ctxWithProbe({ ok: true, handle: "realaccount" }, { handle: "totally-different" });
  const error = await resolveTargetHandle(ctx).catch((e) => e);

  assert.ok(error instanceof UserError);
  assert.match(error.message, /@totally-different/);
  assert.match(error.message, /@realaccount/);
  assert.match(error.message, /Refusing to delete/);
  // The hint has to tell the user how to get out of it, including the .env route that causes
  // this without any flag being typed.
  assert.match(error.hint, /X_HANDLE/);
});

test("a matching handle is verified, whatever case it was written in", async () => {
  const ctx = ctxWithProbe({ ok: true, handle: "RealAccount" }, { handle: "realaccount" });
  const target = await resolveTargetHandle(ctx);
  assert.equal(target.verified, true);
  // X's own spelling wins, so the banner shows the account as X knows it.
  assert.equal(target.handle, "RealAccount");
});

test("a handle with a leading @ is compared on the name, not on the punctuation", async () => {
  const ctx = ctxWithProbe({ ok: true, handle: "realaccount" }, { handle: "@realaccount" });
  const target = await resolveTargetHandle(ctx);
  assert.equal(target.verified, true);
  assert.equal(target.handle, "realaccount");
});

test("with no handle known at all, the one X reports is adopted and marked verified", async () => {
  const ctx = ctxWithProbe({ ok: true, handle: "realaccount" }, { handle: null });
  const target = await resolveTargetHandle(ctx);
  assert.deepEqual(target, { handle: "realaccount", verified: true, reason: null });
  assert.equal(ctx.handle, "realaccount");
});

// ---------------------------------------------------------------------------
// Offline / unreachable X
// ---------------------------------------------------------------------------

test("an unreachable X does not block a run that knows its handle - it marks it UNVERIFIED", async () => {
  const ctx = ctxWithProbe({ ok: false, error: "getaddrinfo ENOTFOUND x.com" }, { handle: "realaccount" });
  const target = await resolveTargetHandle(ctx);

  assert.equal(target.handle, "realaccount");
  assert.equal(target.verified, false);
  assert.match(target.reason, /ENOTFOUND/);
  // And it says so out loud, rather than letting the banner imply the name was checked.
  assert.match(ctx.logger.text(), /UNVERIFIED/);
  assert.match(ctx.logger.text(), /user id 111/);
});

test("an endpoint X has moved (HTTP 404) is treated the same way: unverified, not fatal", async () => {
  const ctx = ctxWithProbe({ ok: false, http: 404 }, { handle: "realaccount" });
  const target = await resolveTargetHandle(ctx);
  assert.equal(target.verified, false);
  assert.match(target.reason, /HTTP 404/);
});

test("a probe that works but cannot name this session's account leaves the handle unverified", async () => {
  const ctx = ctxWithProbe({ ok: true, handle: null }, { handle: "realaccount" });
  const target = await resolveTargetHandle(ctx);
  assert.equal(target.verified, false);
  assert.match(target.reason, /did not name/);
});

test("an unreachable X with no handle at all is fatal - nothing gets deleted from an unnamed account", async () => {
  const ctx = ctxWithProbe({ ok: false, error: "offline" }, { handle: null });
  await assert.rejects(() => resolveTargetHandle(ctx), /Cannot tell which account/);
});

test("an expired session is reported as expired, not as an unverified handle", async () => {
  const ctx = ctxWithProbe({ ok: false, expired: true, http: 401 }, { handle: "realaccount" });
  await assert.rejects(() => resolveTargetHandle(ctx), SessionExpiredError);
});

// ---------------------------------------------------------------------------
// Caching, and the wiring that makes the guard reach every command
// ---------------------------------------------------------------------------

test("the account is resolved once per run, not once per call", async () => {
  let probes = 0;
  const ctx = ctxWithProbe(null, { handle: "realaccount" });
  ctx.client.fetchOwnHandle = async () => {
    probes++;
    return { ok: true, handle: "realaccount" };
  };

  await resolveTargetHandle(ctx);
  await resolveTargetHandle(ctx);
  assert.equal(probes, 1);
});

test("createRunContext hands out a client whose destructive calls are already fenced", async () => {
  const fake = runs.installFakeX();
  try {
    const { ctx } = runs.makeRun();
    assert.equal(ctx.gate.armed, false);
    await assert.rejects(() => ctx.client.deleteTweet("1"), UserError);
    await assert.rejects(() => ctx.client.unretweet("1"), UserError);
    assert.deepEqual(fake.calls.deleted, []);
    // The reads it needs to do its job are untouched.
    const probe = await ctx.client.fetchOwnHandle();
    assert.equal(probe.handle, "realaccount");
  } finally {
    fake.restore();
  }
});

test("the session's own recorded handle is verified too - an old session file is not trusted blindly", async () => {
  const fake = runs.installFakeX({ ownHandle: "someone-else" });
  try {
    // The session file says @realaccount; X says the id belongs to @someone-else.
    const { ctx } = runs.makeRun();
    await assert.rejects(() => resolveTargetHandle(ctx), /Refusing to delete/);
  } finally {
    fake.restore();
  }
});
