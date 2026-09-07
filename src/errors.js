/**
 * Error types the CLI knows how to present.
 *
 * A UserError is something the person running the tool can act on, so the CLI prints its
 * message alone; anything else is a bug and gets a full stack trace.
 */

class UserError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = "UserError";
    this.hint = hint || null;
    this.exitCode = 1;
  }
}

/** The captured cookies stopped being accepted. Nothing works until `login` runs again. */
class SessionExpiredError extends UserError {
  constructor(message) {
    super(
      message || "The saved X session is no longer valid (HTTP 401/403).",
      "Run `x-tweet-nuker login` to sign in again, then re-run this command. Progress is saved, so it will resume where it stopped."
    );
    this.name = "SessionExpiredError";
    this.exitCode = 2;
  }
}

module.exports = { UserError, SessionExpiredError };
