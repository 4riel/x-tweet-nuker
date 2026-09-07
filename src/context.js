/**
 * Shared setup for the commands that talk to X: logger, saved session, API client, and the
 * handle the run is targeting.
 */
const { createLogger } = require("./logger");
const { createClient } = require("./client");
const { loadSession, sessionAgeHours } = require("./session");
const { UserError, SessionExpiredError } = require("./errors");

/** Sessions older than this usually still work, but it is worth warning about. */
const STALE_SESSION_HOURS = 24;

function createRunContext(config, { requireSession = true } = {}) {
  const logger = createLogger({ logFile: config.logFile, verbose: config.verbose });
  if (!requireSession) return { logger, config };

  const session = loadSession(config.sessionFile);
  const client = createClient({ session, logger, config });
  const handle = config.handle || session.handle || null;

  const ageHours = sessionAgeHours(session);
  if (ageHours !== null && ageHours > STALE_SESSION_HOURS) {
    logger.warn(
      "Saved session is " + Math.round(ageHours) + "h old; run `x-tweet-nuker login` if it fails with 401/403."
    );
  }

  return { logger, config, session, client, handle, sessionAgeHours: ageHours };
}

/**
 * The confirmation gate makes the operator type the target handle back, so a destructive run has
 * to know whose account it is about to empty. Sessions captured by older versions do not record
 * the handle, so ask X directly before giving up - and give up rather than prompting for some
 * unquotable placeholder like "this account".
 *
 * @param {object} ctx run context from createRunContext
 * @returns {Promise<string>} the handle, without the @
 */
async function requireHandle(ctx) {
  if (ctx.handle) return ctx.handle;

  const probe = await ctx.client.fetchOwnHandle();
  if (probe.ok && probe.handle) {
    ctx.handle = probe.handle;
    ctx.logger.info("Resolved the signed-in handle from X", { handle: probe.handle });
    return probe.handle;
  }
  if (probe.expired) throw new SessionExpiredError();

  throw new UserError(
    "Cannot tell which account this session belongs to, and will not delete tweets from an account it cannot name.",
    "Re-run with --handle <your-handle> (no @), or run `x-tweet-nuker login` to capture a session that records it."
  );
}

module.exports = { createRunContext, requireHandle, STALE_SESSION_HOURS };
