/**
 * The one guard between a stranger and an irreversible account wipe.
 *
 * Deleted tweets cannot be restored - not by this tool, not by X, not from your archive. So a
 * destructive command refuses to start until the operator types the target handle back, and a
 * non-interactive run refuses outright unless --yes was passed deliberately.
 *
 * The gate used to be enforced by asking at the right moment in the flow ("on the first round",
 * "before the loop"). That is not enforcement: a `continue` that skipped round 1 walked straight
 * past it and deleted an account's timeline with no banner and no prompt. So the check now lives
 * on the destructive calls themselves. A client handed to a command is wrapped by
 * `gate.protect()`, and its `deleteTweet` / `unretweet` refuse to fire until `confirmDestruction`
 * has armed that gate. Forgetting to ask can no longer delete anything; it raises an error.
 */
const readline = require("readline/promises");
const { UserError } = require("./errors");

/** Every client method that destroys something. Each one is fenced behind the gate. */
const DESTRUCTIVE_METHODS = ["deleteTweet", "unretweet"];

const ACTION_WORDS = {
  deleteTweet: "delete a post",
  unretweet: "undo a repost",
};

function unconfirmedDestruction(method) {
  return new UserError(
    "Refusing to " +
      (ACTION_WORDS[method] || "destroy anything") +
      ": this run never passed the confirmation gate. Nothing was deleted.",
    "This is a bug in x-tweet-nuker - a destructive step was reached without asking first. " +
      "Please report it at https://github.com/4riel/x-tweet-nuker/issues, including the command you ran."
  );
}

/** Marks a client as fenced, and by which gate. Not forgeable by accident. */
const GUARDED_BY = Symbol("x-tweet-nuker.destructionGate");

/**
 * One armed/disarmed state per run, established once and only by a successful confirmation.
 *
 * @returns {{armed: boolean, armedFor: string|null, arm: (handle?: string) => void, protect: (client: object) => object}}
 */
function createDestructionGate() {
  let armed = false;
  let armedFor = null;

  const gate = {
    get armed() {
      return armed;
    },
    /** The handle the operator was shown when they agreed - not necessarily who owns the session. */
    get armedFor() {
      return armedFor;
    },

    /** Called only by confirmDestruction, and only once the operator has actually agreed. */
    arm(handle) {
      armed = true;
      armedFor = handle || null;
    },

    /**
     * Wrap a client so its destructive methods cannot fire before the gate is armed. Everything
     * else on the client (timeline reads, the identity probe, sleep) passes through untouched.
     */
    protect(client) {
      const guarded = { ...client };
      for (const name of DESTRUCTIVE_METHODS) {
        if (typeof client[name] !== "function") continue;
        guarded[name] = async (...args) => {
          if (!armed) throw unconfirmedDestruction(name);
          return client[name](...args);
        };
      }
      guarded[GUARDED_BY] = gate;
      return guarded;
    },
  };

  return gate;
}

/**
 * The first line of every command that can destroy something: prove this run's client really is
 * the one this run's gate fenced. Without it, a context assembled by hand - a future refactor, a
 * test helper that grew into production - could hand a command a raw client and quietly restore
 * the exact hole this design exists to close.
 *
 * @param {object} ctx run context
 * @returns {object} the gate
 */
function requireGate(ctx) {
  const gate = ctx && ctx.gate;
  if (!gate || typeof gate.arm !== "function" || !ctx.client || ctx.client[GUARDED_BY] !== gate) {
    throw new UserError(
      "Refusing to start a destructive command: this run's connection to X is not fenced by its confirmation gate.",
      "This is a bug in x-tweet-nuker - please report it at https://github.com/4riel/x-tweet-nuker/issues."
    );
  }
  return gate;
}

/**
 * @param {object} options
 * @param {string} options.handle account whose tweets are about to be destroyed
 * @param {string} options.action short description shown in the banner
 * @param {number|null} [options.count] how many tweets are queued, when known
 * @param {boolean} [options.verified] whether X confirmed this handle owns the session in use.
 *   Defaults to false: a caller that cannot say must not get the reassuring wording for free.
 * @param {string} [options.userId] the numeric id the deletion actually targets
 * @param {boolean} options.assumeYes skip the prompt (--yes)
 * @param {object} options.logger
 * @param {{arm: Function}} [options.gate] armed once the operator has agreed
 * @param {{input?: object, output?: object}} [options.io] terminal to ask on; defaults to the
 *   process's own stdin/stdout. Exists so the prompt itself can be tested - this is the one
 *   function in the tool that must never be exercised only by hand.
 */
async function confirmDestruction({
  handle,
  action,
  count,
  verified = false,
  userId,
  assumeYes,
  logger,
  gate,
  io,
}) {
  if (!handle || typeof handle !== "string") {
    throw new UserError(
      "Refusing to delete tweets from an account this tool cannot name.",
      "Re-run with --handle <your-handle> (no @), or run `x-tweet-nuker login` again."
    );
  }
  const target = "@" + handle;

  logger.plain("");
  logger.plain("  ####################################################################");
  logger.plain("  #  THIS PERMANENTLY DELETES TWEETS. IT CANNOT BE UNDONE.           #");
  logger.plain("  #  Deleted posts are not recoverable - not by this tool, not by X, #");
  logger.plain("  #  and not from your archive download.                             #");
  logger.plain("  ####################################################################");
  logger.plain("");
  logger.plain(
    "  Account : " + target + (verified ? "  (confirmed by X as the signed-in account)" : "")
  );
  if (!verified) {
    logger.plain("            !! UNVERIFIED - X did not confirm this session belongs to " + target + ".");
    logger.plain("            !! The deletion targets the account id in your session file, whatever");
    logger.plain("            !! it is called. Check `x-tweet-nuker status` if that is a surprise.");
  }
  if (userId) logger.plain("  User id : " + userId + (verified ? "" : "  (this is what gets emptied)"));
  logger.plain("  Action  : " + action);
  if (count !== undefined && count !== null) {
    logger.plain("  Queued  : " + count + " tweet(s) in this pass");
  }
  logger.plain("");

  if (assumeYes) {
    logger.plain("  --yes given: skipping confirmation.");
    logger.plain("");
    if (gate) gate.arm(handle);
    return;
  }

  const input = (io && io.input) || process.stdin;
  const output = (io && io.output) || process.stdout;

  if (!input.isTTY) {
    throw new UserError(
      "Refusing to delete tweets without confirmation, and there is no terminal to ask on.",
      "Re-run interactively, or pass --yes if you are automating this and accept that it is irreversible."
    );
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question("  Type the handle (" + target + ") to continue, or anything else to abort: ");
    const normalized = (answer || "").trim().replace(/^@/, "").toLowerCase();
    if (normalized !== handle.toLowerCase()) {
      throw new UserError("Aborted - the handle you typed did not match " + target + ".");
    }
  } finally {
    rl.close();
  }

  if (gate) gate.arm(handle);
  logger.plain("");
}

module.exports = { confirmDestruction, createDestructionGate, requireGate, DESTRUCTIVE_METHODS };
