/**
 * The one guard between a stranger and an irreversible account wipe.
 *
 * Deleted tweets cannot be restored - not by this tool, not by X, not from your archive. So a
 * destructive command refuses to start until the operator types the target handle back, and a
 * non-interactive run refuses outright unless --yes was passed deliberately.
 */
const readline = require("readline/promises");
const { UserError } = require("./errors");

/**
 * @param {object} options
 * @param {string} options.handle account whose tweets are about to be destroyed
 * @param {string} options.action short description shown in the banner
 * @param {number|null} [options.count] how many tweets are queued, when known
 * @param {boolean} options.assumeYes skip the prompt (--yes)
 * @param {object} options.logger
 */
async function confirmDestruction({ handle, action, count, assumeYes, logger }) {
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
  logger.plain("  Account : " + target);
  logger.plain("  Action  : " + action);
  if (count !== undefined && count !== null) {
    logger.plain("  Queued  : " + count + " tweet(s) in this pass");
  }
  logger.plain("");

  if (assumeYes) {
    logger.plain("  --yes given: skipping confirmation.");
    logger.plain("");
    return;
  }

  if (!process.stdin.isTTY) {
    throw new UserError(
      "Refusing to delete tweets without confirmation, and there is no terminal to ask on.",
      "Re-run interactively, or pass --yes if you are automating this and accept that it is irreversible."
    );
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("  Type the handle (" + target + ") to continue, or anything else to abort: ");
    const normalized = (answer || "").trim().replace(/^@/, "").toLowerCase();
    if (normalized !== handle.toLowerCase()) {
      throw new UserError("Aborted - the handle you typed did not match " + target + ".");
    }
  } finally {
    rl.close();
  }

  logger.plain("");
}

module.exports = { confirmDestruction };
