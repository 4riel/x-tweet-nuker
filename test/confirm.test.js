"use strict";
/**
 * The confirmation gate: the one thing standing between a mistake and an irreversible wipe.
 *
 * It had no tests, which is exactly why a sweep that walked past it shipped. Two things are
 * covered here: the prompt itself (who it names, what it accepts, when it refuses), and the
 * structural guard - a client whose destructive calls simply do not work until the gate has been
 * passed, so "we forgot to ask here" can no longer mean "we deleted the account anyway".
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("stream");
const { confirmDestruction, createDestructionGate, requireGate } = require("../src/confirm");
const { UserError } = require("../src/errors");

function recordingLogger() {
  const lines = [];
  return {
    lines,
    text: () => lines.join("\n"),
    info: (m) => lines.push(m),
    warn: (m) => lines.push(m),
    error: (m) => lines.push(m),
    debug: () => {},
    plain: (m) => lines.push(m),
  };
}

/** A client stand-in that records what it was asked to destroy. */
function fakeClient() {
  const calls = { deleted: [], unretweeted: [], slept: 0, fetched: 0 };
  return {
    calls,
    deleteTweet: async (id) => {
      calls.deleted.push(id);
      return { status: "deleted" };
    },
    unretweet: async (id) => {
      calls.unretweeted.push(id);
      return { status: "unretweeted" };
    },
    fetchTimelinePage: async () => {
      calls.fetched++;
      return { items: new Map(), cursors: [], failed: false };
    },
    fetchOwnHandle: async () => ({ ok: true, handle: "realaccount" }),
    sleep: async () => {
      calls.slept++;
    },
  };
}

/** A terminal that answers with `answer`. */
function fakeTerminal(answer) {
  const input = new PassThrough();
  input.isTTY = true;
  input.write(answer + "\n");
  return { input, output: new PassThrough() };
}

// ---------------------------------------------------------------------------
// The structural guard - deletion is impossible until the gate is armed
// ---------------------------------------------------------------------------

test("a protected client refuses deleteTweet before the gate is armed, and does not call through", async () => {
  const gate = createDestructionGate();
  const client = fakeClient();
  const guarded = gate.protect(client);

  await assert.rejects(() => guarded.deleteTweet("1"), UserError);
  assert.deepEqual(client.calls.deleted, []);
});

test("a protected client refuses unretweet before the gate is armed", async () => {
  const gate = createDestructionGate();
  const client = fakeClient();
  const guarded = gate.protect(client);

  await assert.rejects(() => guarded.unretweet("1"), UserError);
  assert.deepEqual(client.calls.unretweeted, []);
});

test("the refusal names the run as unconfirmed and points at the bug tracker, not at the user", async () => {
  const gate = createDestructionGate();
  const guarded = gate.protect(fakeClient());
  const error = await guarded.deleteTweet("1").catch((e) => e);

  assert.ok(error instanceof UserError);
  assert.match(error.message, /never passed the confirmation gate/);
  assert.match(error.message, /Nothing was deleted/);
  assert.match(error.hint, /bug in x-tweet-nuker/);
});

test("reading a timeline, probing the account and sleeping all still work while disarmed", async () => {
  const gate = createDestructionGate();
  const client = fakeClient();
  const guarded = gate.protect(client);

  await guarded.fetchTimelinePage("url", null);
  await guarded.fetchOwnHandle();
  await guarded.sleep(0);

  assert.equal(client.calls.fetched, 1);
  assert.equal(client.calls.slept, 1);
  assert.equal(gate.armed, false);
});

test("once confirmDestruction has run, the same client deletes normally", async () => {
  const gate = createDestructionGate();
  const client = fakeClient();
  const guarded = gate.protect(client);

  await confirmDestruction({
    handle: "realaccount",
    action: "delete everything",
    assumeYes: true,
    verified: true,
    logger: recordingLogger(),
    gate,
  });

  assert.equal(gate.armed, true);
  assert.deepEqual(await guarded.deleteTweet("1"), { status: "deleted" });
  assert.deepEqual(client.calls.deleted, ["1"]);
});

test("arming one gate does not arm another - the state is per run, not global", async () => {
  const armed = createDestructionGate();
  armed.arm("realaccount");
  const other = createDestructionGate();
  await assert.rejects(() => other.protect(fakeClient()).deleteTweet("1"), UserError);
});

// ---------------------------------------------------------------------------
// requireGate - a destructive command will not start on an unfenced client
// ---------------------------------------------------------------------------

test("requireGate accepts a context whose client was fenced by that context's own gate", () => {
  const gate = createDestructionGate();
  const ctx = { gate, client: gate.protect(fakeClient()) };
  assert.equal(requireGate(ctx), gate);
});

test("requireGate refuses a context with no gate at all", () => {
  assert.throws(() => requireGate({ client: fakeClient() }), UserError);
  assert.throws(() => requireGate({}), UserError);
  assert.throws(() => requireGate(null), UserError);
});

test("requireGate refuses a raw, unfenced client even when a gate is present", () => {
  const gate = createDestructionGate();
  const error = (() => {
    try {
      requireGate({ gate, client: fakeClient() });
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.ok(error instanceof UserError);
  assert.match(error.message, /not fenced by its confirmation gate/);
});

test("requireGate refuses a client fenced by somebody else's gate", () => {
  const mine = createDestructionGate();
  const other = createDestructionGate();
  assert.throws(() => requireGate({ gate: mine, client: other.protect(fakeClient()) }), UserError);
});

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

test("a run with no handle is refused outright, and the gate stays disarmed", async () => {
  const gate = createDestructionGate();
  await assert.rejects(
    () =>
      confirmDestruction({
        handle: null,
        action: "delete everything",
        assumeYes: true,
        logger: recordingLogger(),
        gate,
      }),
    /cannot name/
  );
  assert.equal(gate.armed, false);
});

test("without a terminal and without --yes, the gate refuses and stays disarmed", async () => {
  const gate = createDestructionGate();
  const notATerminal = new PassThrough(); // isTTY undefined, like a piped stdin
  await assert.rejects(
    () =>
      confirmDestruction({
        handle: "realaccount",
        action: "delete everything",
        assumeYes: false,
        logger: recordingLogger(),
        gate,
        io: { input: notATerminal, output: new PassThrough() },
      }),
    /no terminal to ask on/
  );
  assert.equal(gate.armed, false);
});

test("typing the handle back arms the gate", async () => {
  const gate = createDestructionGate();
  await confirmDestruction({
    handle: "realaccount",
    action: "delete everything",
    assumeYes: false,
    verified: true,
    logger: recordingLogger(),
    gate,
    io: fakeTerminal("realaccount"),
  });
  assert.equal(gate.armed, true);
  assert.equal(gate.armedFor, "realaccount");
});

test("the typed handle is accepted with an @ and in any case", async () => {
  for (const answer of ["@realaccount", "RealAccount", "  realaccount  "]) {
    const gate = createDestructionGate();
    await confirmDestruction({
      handle: "realaccount",
      action: "delete everything",
      assumeYes: false,
      logger: recordingLogger(),
      gate,
      io: fakeTerminal(answer),
    });
    assert.equal(gate.armed, true, "should accept " + JSON.stringify(answer));
  }
});

test("typing something else aborts and leaves the gate disarmed", async () => {
  const gate = createDestructionGate();
  await assert.rejects(
    () =>
      confirmDestruction({
        handle: "realaccount",
        action: "delete everything",
        assumeYes: false,
        logger: recordingLogger(),
        gate,
        io: fakeTerminal("yes"),
      }),
    /Aborted/
  );
  assert.equal(gate.armed, false);
});

test("an empty answer aborts", async () => {
  const gate = createDestructionGate();
  await assert.rejects(
    () =>
      confirmDestruction({
        handle: "realaccount",
        action: "delete everything",
        assumeYes: false,
        logger: recordingLogger(),
        gate,
        io: fakeTerminal(""),
      }),
    /Aborted/
  );
  assert.equal(gate.armed, false);
});

// ---------------------------------------------------------------------------
// What the banner claims about the account
// ---------------------------------------------------------------------------

test("a verified handle is shown as confirmed by X", async () => {
  const logger = recordingLogger();
  await confirmDestruction({
    handle: "realaccount",
    action: "delete everything",
    verified: true,
    userId: "111",
    assumeYes: true,
    logger,
    gate: createDestructionGate(),
  });
  assert.match(logger.text(), /Account : @realaccount {2}\(confirmed by X/);
  assert.equal(/UNVERIFIED/.test(logger.text()), false);
});

test("an unverified handle is labelled UNVERIFIED and the real target id is shown", async () => {
  const logger = recordingLogger();
  await confirmDestruction({
    handle: "maybe-me",
    action: "delete everything",
    verified: false,
    userId: "111",
    assumeYes: true,
    logger,
    gate: createDestructionGate(),
  });
  assert.match(logger.text(), /UNVERIFIED/);
  assert.match(logger.text(), /User id : 111/);
});

test("a caller that says nothing about verification gets the UNVERIFIED wording, not the reassuring one", async () => {
  const logger = recordingLogger();
  await confirmDestruction({
    handle: "realaccount",
    action: "delete everything",
    userId: "111",
    assumeYes: true,
    logger,
    gate: createDestructionGate(),
  });
  assert.match(logger.text(), /UNVERIFIED/);
});

test("the banner always says the deletion is irreversible and names the action and the count", async () => {
  const logger = recordingLogger();
  await confirmDestruction({
    handle: "realaccount",
    action: "delete every post found on your timelines",
    count: 42,
    verified: true,
    assumeYes: true,
    logger,
    gate: createDestructionGate(),
  });
  const text = logger.text();
  assert.match(text, /CANNOT BE UNDONE/);
  assert.match(text, /delete every post found on your timelines/);
  assert.match(text, /Queued {2}: 42 tweet\(s\)/);
});
