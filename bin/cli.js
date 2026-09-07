#!/usr/bin/env node
/**
 * x-tweet-nuker - command line entry point.
 *
 * Parses arguments, resolves configuration, dispatches to a command in src/commands, and turns
 * thrown UserErrors into something the person at the keyboard can act on.
 */
const path = require("path");
const { buildConfig } = require("../src/config");
const { UserError } = require("../src/errors");

const pkg = require("../package.json");

const COMMANDS = {
  login: require("../src/commands/login"),
  run: require("../src/commands/run"),
  nuke: require("../src/commands/nuke"),
  sweep: require("../src/commands/sweep"),
  verify: require("../src/commands/verify"),
  status: require("../src/commands/status"),
};

/** Flags that consume the next argument as their value. */
const VALUE_FLAGS = new Set([
  "data-dir",
  "session",
  "state",
  "log",
  "archive",
  "handle",
  "chrome-executable",
  "delay",
  "limit",
  "max-rounds",
  "ids",
]);

const BOOLEAN_FLAGS = new Set([
  "dry-run",
  "yes",
  "y",
  "verbose",
  "headless",
  "check",
  "help",
  "h",
  "version",
]);

const GLOBAL_FLAGS = {
  "--data-dir <path>": "directory for session, state, logs and browser profile (default: cwd)",
  "--handle <name>": "override the detected X handle (no @)",
  "--archive <path>": "path to your archive's tweets.js",
  "--session <path>": "path to the session file",
  "--state <path>": "path to the resumable state file",
  "--log <path>": "path to the log file",
  "--chrome-executable <path>": "Chrome/Chromium binary to use instead of Playwright's bundled one",
  "--verbose": "log extra detail",
  "--help, -h": "show help for a command",
  "--version": "print the version",
};

/** Width the flag column is padded to in help output; the longest flag string sets it. */
const FLAG_COLUMN = 28;

function parseArgs(argv) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }

    let name = arg.replace(/^--?/, "");
    let value;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }

    if (name.startsWith("no-")) {
      const negated = name.slice(3);
      // Only real boolean flags can be negated. Without this check `--no-anything` is accepted
      // and silently ignored, and `--no-limit` turns into a baffling "invalid value" error.
      if (!BOOLEAN_FLAGS.has(negated)) {
        throw new UserError(
          "Unknown flag: " + arg,
          "Run `x-tweet-nuker --help` to see the available commands and flags."
        );
      }
      flags[negated] = false;
      continue;
    }

    if (VALUE_FLAGS.has(name)) {
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) throw new UserError("Flag --" + name + " needs a value.");
      }
      flags[name] = value;
      continue;
    }

    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = value === undefined ? true : !/^(0|false|no|off)$/i.test(value);
      continue;
    }

    throw new UserError(
      "Unknown flag: " + arg,
      "Run `x-tweet-nuker --help` to see the available commands and flags."
    );
  }

  return { flags, positional };
}

function helpText(commandName) {
  const lines = [];
  const pad = (text) => text.padEnd(FLAG_COLUMN);

  if (commandName && COMMANDS[commandName]) {
    const command = COMMANDS[commandName];
    const own = Object.keys(command.flags || {}).map((flag) => flag.split(/[ ,]/)[0]);
    lines.push("");
    lines.push("  x-tweet-nuker " + commandName + " - " + command.description);
    lines.push("");
    lines.push("  Flags");
    for (const [flag, help] of Object.entries(command.flags || {})) {
      lines.push("    " + pad(flag) + help);
    }
    lines.push("");
    lines.push("  Global flags");
    for (const [flag, help] of Object.entries(GLOBAL_FLAGS)) {
      // A flag the command already documents above is not repeated here.
      if (own.includes(flag.split(/[ ,]/)[0])) continue;
      lines.push("    " + pad(flag) + help);
    }
    lines.push("");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("  x-tweet-nuker v" + pkg.version);
  lines.push("  Delete every tweet from your X account, using your own logged-in session.");
  lines.push("");
  lines.push("  THIS IS IRREVERSIBLE. Deleted posts cannot be restored by this tool, by X, or");
  lines.push("  from your archive download. Every destructive command asks you to type your");
  lines.push("  handle first, and supports --dry-run.");
  lines.push("");
  lines.push("  Usage");
  lines.push("    node bin/cli.js <command> [flags]   from a clone of this repo");
  lines.push("    x-tweet-nuker <command> [flags]     after `npm link` in that clone");
  lines.push("");
  lines.push("  This package is not published on npm, so `npx x-tweet-nuker` does not work.");
  lines.push("  This tool's own messages name commands as `x-tweet-nuker <command>`; from a clone");
  lines.push("  that is always `node bin/cli.js <command>`.");
  lines.push("");
  lines.push("  Commands");
  for (const [name, command] of Object.entries(COMMANDS)) {
    lines.push("    " + name.padEnd(10) + command.description);
  }
  lines.push("");
  lines.push("  Global flags");
  for (const [flag, help] of Object.entries(GLOBAL_FLAGS)) {
    lines.push("    " + pad(flag) + help);
  }
  lines.push("");
  lines.push("  Typical first run, from a clone");
  lines.push("    1. npm install && npx playwright install chromium");
  lines.push("    2. node bin/cli.js login          sign in once, session is saved locally");
  lines.push("    3. node bin/cli.js run --dry-run  see exactly what would be deleted");
  lines.push("    4. node bin/cli.js run            delete everything");
  lines.push("    5. node bin/cli.js verify         confirm the profile is empty");
  lines.push("");
  lines.push("  Run `node bin/cli.js <command> --help` for command-specific flags.");
  lines.push("");
  return lines.join("\n");
}

async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  const commandName = positional[0];

  if (flags.version) {
    console.log(pkg.version);
    return 0;
  }
  if (!commandName || flags.help || flags.h) {
    console.log(helpText(commandName));
    return commandName || flags.help || flags.h ? 0 : 1;
  }

  const command = COMMANDS[commandName];
  if (!command) {
    throw new UserError(
      "Unknown command: " + commandName,
      "Available commands: " + Object.keys(COMMANDS).join(", ") + ". Run `x-tweet-nuker --help`."
    );
  }

  const config = buildConfig(flags);
  return (await command.run(config)) || 0;
}

function cli(argv) {
  return main(argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      if (error instanceof UserError) {
        console.error("");
        console.error("  " + error.message);
        if (error.hint) console.error("  " + error.hint);
        console.error("");
        process.exitCode = error.exitCode || 1;
        return;
      }
      console.error("");
      console.error("  Unexpected failure in " + path.basename(process.argv[1] || "x-tweet-nuker") + ":");
      console.error(error && error.stack ? error.stack : error);
      console.error("");
      process.exitCode = 1;
    });
}

// Only run when invoked as a program. Requiring this file (the tests do, to check that the flags
// the parser accepts and the flags help advertises are the same set) must not execute a command.
if (require.main === module) cli(process.argv.slice(2));

module.exports = { cli, parseArgs, helpText, COMMANDS, GLOBAL_FLAGS, VALUE_FLAGS, BOOLEAN_FLAGS };
