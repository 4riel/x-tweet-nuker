/**
 * Shared setup for the commands that talk to X: logger, saved session, API client, the
 * confirmation gate that fences the client's destructive calls, and the handle the run targets.
 */
const { createLogger } = require("./logger");
const { createClient } = require("./client");
const { createDestructionGate } = require("./confirm");
const { loadSession, sessionAgeHours } = require("./session");
const { UserError, SessionExpiredError } = require("./errors");

/** Sessions older than this usually still work, but it is worth warning about. */
const STALE_SESSION_HOURS = 24;

function createRunContext(config) {
  const logger = createLogger({ logFile: config.logFile, verbose: config.verbose });
  const session = loadSession(config.sessionFile);
  // The gate is created before the client and wraps it, so no command can hold an unguarded
  // reference to deleteTweet/unretweet. See src/confirm.js.
  const gate = createDestructionGate();
  const client = gate.protect(createClient({ session, logger, config }));
  const handle = config.handle || session.handle || null;

  const ageHours = sessionAgeHours(session);
  if (ageHours !== null && ageHours > STALE_SESSION_HOURS) {
    logger.warn(
      "Saved session is " + Math.round(ageHours) + "h old; run `x-tweet-nuker login` if it fails with 401/403."
    );
  }

  return { logger, config, session, client, gate, handle, sessionAgeHours: ageHours };
}

/**
 * Work out - and, wherever X can be reached, prove - which account is about to be emptied.
 *
 * The handle is only ever a label. Deletion targets the numeric user id in the session file, so a
 * handle from --handle, from X_HANDLE in a .env, or from a session file written by an older
 * version can name one account while another is being emptied. Showing the wrong name on the
 * confirmation gate is the worst thing a confirmation gate can do, so the claimed handle is
 * checked against the account X says this session signs in as, and a mismatch is refused outright
 * rather than silently preferred.
 *
 * When X cannot be reached (or has moved the endpoint that answers this), the run is NOT blocked:
 * the identity probe is a separate surface from the deletion itself, and a tool that stops working
 * the day X renames an endpoint is a tool people work around. The handle is instead carried
 * through as unverified and the banner says so in as many words - which is honest, because an
 * unverifiable handle can only mislabel the run, never redirect it.
 *
 * @param {object} ctx run context from createRunContext
 * @returns {Promise<{handle: string, verified: boolean, reason: string|null}>}
 */
async function resolveTargetHandle(ctx) {
  if (ctx.target) return ctx.target;

  const claimed = ctx.handle ? String(ctx.handle).trim().replace(/^@/, "") : null;
  const probe = await ctx.client.fetchOwnHandle();
  if (probe.expired) throw new SessionExpiredError();

  if (probe.ok && probe.handle) {
    const actual = probe.handle;
    if (claimed && claimed.toLowerCase() !== actual.toLowerCase()) {
      throw new UserError(
        "Refusing to delete: this run was told to target @" +
          claimed +
          ", but the saved session signs in as @" +
          actual +
          " (user id " +
          ctx.session.myUserId +
          ").",
        "The confirmation would have named @" +
          claimed +
          " while emptying @" +
          actual +
          ". Drop --handle (and any X_HANDLE line in your .env) to target @" +
          actual +
          ", or run `x-tweet-nuker login` to capture a session for @" +
          claimed +
          "."
      );
    }
    ctx.handle = actual;
    if (!claimed) ctx.logger.info("Resolved the signed-in handle from X", { handle: actual });
    ctx.target = { handle: actual, verified: true, reason: null };
    return ctx.target;
  }

  const reason = probe.error
    ? probe.error
    : probe.http
      ? "HTTP " + probe.http
      : "X did not name the account this session belongs to";

  if (!claimed) {
    throw new UserError(
      "Cannot tell which account this session belongs to, and will not delete tweets from an account it cannot name.",
      "Re-run with --handle <your-handle> (no @), or run `x-tweet-nuker login` to capture a session that records it."
    );
  }

  ctx.logger.warn(
    "Could not confirm with X that this session belongs to @" +
      claimed +
      " - treating that name as UNVERIFIED. Deletion targets user id " +
      ctx.session.myUserId +
      " from the session file regardless of what it is called.",
    { reason }
  );
  ctx.target = { handle: claimed, verified: false, reason };
  return ctx.target;
}

module.exports = { createRunContext, resolveTargetHandle, STALE_SESSION_HOURS };
