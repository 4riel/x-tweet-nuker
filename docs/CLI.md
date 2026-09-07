# CLI reference

Complete flag, environment, exit-code and troubleshooting reference for `x-tweet-nuker`.
For the short version, see the [README](../README.md). For the request-level details of how the
tool talks to x.com, see [HOW-IT-WORKS.md](HOW-IT-WORKS.md).

Every example below is written as `x-tweet-nuker <command>`, which is the name the tool's own
messages use. **Running from a clone — the normal case — that is `node bin/cli.js <command>`.**
This package is not published on npm, so `npx x-tweet-nuker` does not work; `npm link` inside the
clone is what makes the bare `x-tweet-nuker` name available.

- [Commands](#commands)
- [Global flags](#global-flags)
- [`login`](#login)
- [`run`](#run)
- [`nuke`](#nuke)
- [`sweep`](#sweep)
- [`verify`](#verify)
- [`status`](#status)
- [Environment variables](#environment-variables)
- [Exit codes](#exit-codes)
- [Resuming and running unattended](#resuming-and-running-unattended)
- [Troubleshooting](#troubleshooting)

## Commands

| Command | Description |
|---|---|
| `login` | Sign in to X and capture the session (start here) |
| `run` | Archive pass, then sweep until clean (the usual choice) |
| `nuke` | Delete every tweet listed in your archive's `tweets.js` |
| `sweep` | Page your timelines and delete whatever is left, until a pass finds nothing |
| `verify` | Open your profile in a browser and prove it is empty |
| `status` | Show session health, archive size and deletion progress |

`x-tweet-nuker <command> --help` prints the same reference from the CLI itself.

## Global flags

These are accepted by every command.

| Flag | Description |
|---|---|
| `--data-dir <path>` | directory for session, state, logs and browser profile (default: current directory) |
| `--handle <name>` | override the detected X handle (no `@`) |
| `--archive <path>` | path to your archive's `tweets.js` |
| `--session <path>` | path to the session file |
| `--state <path>` | path to the resumable state file |
| `--log <path>` | path to the log file |
| `--chrome-executable <path>` | Chrome/Chromium binary to use instead of Playwright's bundled one |
| `--verbose` | log extra detail |
| `--help`, `-h` | show help for a command |
| `--version` | print the version |

Any boolean flag can be turned off explicitly with `--no-<flag>` (e.g. `--no-headless`). A `--no-`
prefix on anything that is not a boolean flag is rejected rather than silently ignored. `--yes`
also accepts `-y`.

## `login`

Opens a browser, waits for you to sign in, and saves the session. Never deletes anything, and is
the fix for any `401`/`403` the other commands hit later. It waits up to five minutes for the
login to complete.

| Flag | Description |
|---|---|
| `--headless` | run the browser headless (only works if this profile is already signed in) |
| `--handle <name>` | skip handle detection and use this handle |
| `--data-dir <path>` | where to keep the session, state, logs and browser profile |

Sign-in happens in a persistent browser profile under `.chrome-user-data/`, so a later `login`
usually does not ask for credentials again. While the browser is open, the tool visits your
Replies, Posts, Media, Highlights and Reposts tabs to capture the timeline GraphQL requests the
sweep later replays, and scrapes the current `DeleteTweet` / `UnretweetTweet` `queryId` values out
of X's own JS bundles. Every one of those tabs has to be visited: several of them (Highlights,
Reposts) fire their timeline request only while you are standing on them, and a timeline `login`
never captured is a timeline `sweep` can never clear.

## `run`

The usual entry point: an archive pass (if a `tweets.js` is found), then a sweep until clean. With
no archive it warns and goes straight to the sweep.

| Flag | Description |
|---|---|
| `--archive <path>` | `tweets.js` from your archive, or a folder containing it |
| `--dry-run` | report what both passes would do, delete nothing |
| `--limit <n>` | stop each pass after N deletions |
| `--max-rounds <n>` | give up sweeping after N rounds (default 30, minimum 1) |
| `--delay <ms>` | pause between deletions (default 400) |
| `--yes`, `-y` | skip the typed confirmation (for automation) |

## `nuke`

Deletes every tweet id listed in your archive. Fails with a clear error if no archive is found —
it does not fall back to sweeping (use `sweep` or `run` for that). Ids are processed oldest first,
so an interrupted run leaves the most recent tweets behind, which are the easiest to check by
hand.

| Flag | Description |
|---|---|
| `--archive <path>` | `tweets.js` from your archive, or a folder containing it |
| `--dry-run` | report exactly what would be deleted, delete nothing |
| `--limit <n>` | stop after N deletions |
| `--delay <ms>` | pause between deletions (default 400) |
| `--yes`, `-y` | skip the typed confirmation (for automation) |

`--archive` accepts the `tweets.js` file itself or a directory containing `tweets.js` /
`tweets-part*.js` (an unzipped archive's `data/` folder). A plain JSON array of id strings is
accepted too, so you can feed in your own id list.

## `sweep`

Pages every timeline captured at login and deletes what it finds, repeating rounds until one full
pass turns up nothing. Handles retweets (un-retweets first, then deletes) and anything posted
after your archive was exported.

| Flag | Description |
|---|---|
| `--dry-run` | harvest and report what is still there, delete nothing |
| `--limit <n>` | stop after N deletions |
| `--max-rounds <n>` | give up after N rounds without a clean pass (default 30, minimum 1) |
| `--delay <ms>` | pause between deletions (default 400) |
| `--yes`, `-y` | skip the typed confirmation (for automation) |

Deletion on X is eventually consistent — a tweet can still be served on a timeline for a while
after a successful delete — so one empty-looking pass is not treated as proof. A round that finds
nothing *and* had timeline requests fail does not count as clean either; it waits and retries
instead, because a pass that could not read your timelines found nothing only because it looked at
nothing.

A `--dry-run` here reports one pass only, so the final total of a real sweep is usually higher
than what the dry run shows.

## `verify`

Opens a real browser and checks every profile tab that can render your posts — Posts, Replies,
Media, Highlights and Reposts — and, optionally, specific tweet ids. This is a check independent
of the deleter's own bookkeeping. It counts not just your own post cards but reposts too (a repost
renders under the *original* author's link, so it needs its own check), plus any rendered post
card that doesn't match a recognized "nothing here" empty state. Deletes nothing.

| Flag | Description |
|---|---|
| `--handle <name>` | profile to check (defaults to the signed-in account) |
| `--ids <a,b,c>` | also check that these specific tweet ids are gone |
| `--headless` | run the browser headless (default; use `--no-headless` to watch) |

`verify` always needs a captured session (`.x-session-data.json`), even if you pass `--handle`
yourself, and never reuses the `.chrome-user-data` browser profile that `login` maintains — it
launches a fresh, throwaway browser and signs it in by injecting the saved session's cookies
directly. This matters: **X serves a signed-out visitor completely empty timelines**, on an
account with zero posts and one with thousands alike, so a check that isn't provably signed in as
the right account cannot tell "nothing left" from "nothing shown to me". `verify` proves it is
signed in before it measures anything and refuses outright, pointing at `login`, if it isn't.

For the same reason, a tab with zero rendered post cards is not, by itself, treated as proof of
anything — it only counts as empty when X's own page says so (an explicit empty-state element, the
profile's timeline region rendering with recognizably zero cards inside it, or a recognized
"hasn't posted" wording). A page that looks like it failed to load ("Something went wrong", "Try
again") is explicitly never accepted as proof either way. That gives three possible verdicts, not
two — see [Exit codes](#exit-codes).

## `status`

Read-only, offline by default: shows where the session/state/log/archive files are, session
health, and deletion progress so far.

| Flag | Description |
|---|---|
| `--check` | also make one request to X to confirm the session still works |

## Environment variables

Any of these can go in a `.env` file in your data directory (see
[`.env.example`](../.env.example)). Command-line flags always win over the environment, which
always wins over the defaults below.

| Variable | Description | Default |
|---|---|---|
| `X_HANDLE` | your X handle, without `@` (normally auto-detected) | detected from session |
| `X_NUKER_DATA_DIR` | directory for session, state, logs and browser profile | current directory |
| `ARCHIVE_FILE` | path to `tweets.js` (or a directory containing it) | `<data dir>/tweets.js` |
| `SESSION_FILE` | explicit path to the session file | `<data dir>/.x-session-data.json` |
| `STATE_FILE` | explicit path to the resumable state file | `<data dir>/.nuke-state.json` |
| `LOG_FILE` | explicit path to the log file | `<data dir>/x-tweet-nuker.log` |
| `DELETE_DELAY_MS` | milliseconds to wait between deletions | `400` |
| `LIMIT` | stop after N deletions; `0` or empty means no limit | `0` |
| `MAX_ROUNDS` | maximum sweep rounds before giving up on a clean pass (minimum `1`) | `30` |
| `CHECK_IDS` | comma-separated tweet ids for `verify` to look up individually, in addition to scanning profile tabs (same as `verify --ids <a,b,c>`) | empty |
| `HEADLESS` | force the browser headless (`1`/`true`) or visible (`0`/`false`) | off for `login`, on for `verify` |
| `CHROME_EXECUTABLE` | absolute path to a Chrome/Chromium binary | Playwright's bundled Chromium |

Numeric values (`DELETE_DELAY_MS`, `LIMIT`, `MAX_ROUNDS`, and their `--delay`/`--limit`/`--max-rounds`
flag equivalents) are validated: a value that isn't a whole number at or above that option's
minimum is rejected with an error rather than silently falling back to the default. `--delay 0`
(no pause) and `--limit 0` (no limit) are meaningful and are honoured exactly as given;
`--max-rounds 0` would be a sweep that can never look at anything, so it is rejected rather than
quietly turned into the default of 30.

## Exit codes

`nuke`, `sweep`, `run` and `verify` all use the same convention, so a script can tell what
happened without parsing log output:

| Code | Meaning |
|---|---|
| `0` | Clean: the archive/sweep pass fully succeeded, or every one of `verify`'s tabs (and ids) came back positively proven empty |
| `1` | Not clean, or a user error, or unconfirmed: some deletions failed, a sweep ran out of rounds, `verify` found something still visible, `verify` could not get positive proof a tab is empty (`COULD NOT CONFIRM`), or an invalid flag/missing archive/lock conflict was rejected before anything ran |
| `2` | Session expired (HTTP 401/403) — run `login` again; progress is saved, so a retry resumes where it stopped |

> [!NOTE]
> `verify`'s `COULD NOT CONFIRM` verdict (exit `1`) means exactly what it says: it is not "not
> clean", it is "the tool would not stake a CLEAN verdict on what it saw". Treat it the same as
> "not clean" for scripting purposes — don't proceed as if the account were confirmed empty.

`login` and `status` have no "not clean" verdict of their own — neither deletes anything or
claims an account is empty — so they return `0` whenever they complete. They still use the same
`1` (something you can fix: the browser would not start, the sign-in timed out, the handle could
not be detected) and `2` (session expired) codes when they cannot complete at all.

## Resuming and running unattended

Every deletion is recorded in `.nuke-state.json` as it happens (`done`, `gone`, or `failed`), and
the file is saved throughout the run, not just at the end. The `failed` list is kept current, not
cumulative — an id that fails and later succeeds is removed from it, so it always reflects what is
actually still failing. If a run is interrupted for any reason — a rate limit, a reboot, the OS
killing the process under memory pressure — just run the same command again. Already-deleted and
already-confirmed-gone ids are skipped automatically; nothing extra to pass.

`nuke` and `sweep` (and therefore `run`) hold an advisory lock file, `<state file>.lock`, for as
long as they are writing to that state file, so two runs can't share one data directory and
silently overwrite each other's progress. The lock is released automatically when the process
exits, including on Ctrl-C. If a run was killed hard enough to leave the lock behind, the next run
on the same machine detects that the recorded process id is no longer running and takes the lock
over on its own — no manual cleanup needed. You only need to intervene if you are certain no other
run is using that data directory and the lock is still refused (for example, a lock left by a
different machine sharing a network drive, which is trusted for up to 90 minutes of silence before
it's treated as stale): delete `<state file>.lock` yourself, or point at a separate `--data-dir`
for a genuinely parallel run.

```bash
node bin/cli.js run --yes
```

`--yes` is what makes this safe to re-run non-interactively: without it, the tool refuses to
proceed unless it can prompt you on a real terminal.

To run a long pass in the background:

**Windows (PowerShell):**

```powershell
Start-Process node -ArgumentList "bin/cli.js","run","--yes" -RedirectStandardOutput "run.out.log" -RedirectStandardError "run.err.log" -WindowStyle Hidden
```

**macOS / Linux:**

```bash
nohup node bin/cli.js run --yes > run.out.log 2> run.err.log &
disown
```

Check progress at any time with `x-tweet-nuker status`, or tail the log file.

## Troubleshooting

<details>
<summary><strong>Session expired / commands fail with 401 or 403</strong></summary>

The saved cookies stopped being accepted. Run `login` again; progress is preserved in
`.nuke-state.json`, so re-running `run`/`sweep`/`nuke` afterwards picks up where it stopped.
</details>

<details>
<summary><strong>"No timeline requests were captured" / sweep says there is nothing to page through</strong></summary>

X periodically renames its internal timeline GraphQL operations. As of this writing they are
`UserOriginalsTimeline`, `UserRepliesTimeline` and `UserVideoTimeline` — renamed at some point
from the older `UserTweets`, `UserTweetsAndReplies` and `UserMedia`. `login` records every GraphQL
operation name your browser actually requested (`graphqlOperationsSeen` in the session file, and
in its warning output) even when none of them match a known timeline. Check that list, then add
the new operation name to the `KNOWN_TIMELINE_OPS` array in `src/session.js` and run `login`
again.
</details>

<details>
<summary><strong>Playwright says Chromium is missing</strong></summary>

Run `npx playwright install chromium`. This is a separate download from `npm install`. If you
would rather use a Chrome you already have, point `--chrome-executable` (or `CHROME_EXECUTABLE`)
at its binary.
</details>

<details>
<summary><strong>It looks stuck / hasn't logged anything in minutes</strong></summary>

That is very likely X's rate limit, not a hang. The tool logs
`Rate limited by X - waiting Ns: <reason>` when this happens and resumes on its own; run with
`--verbose` or check the log file to see it. It trusts X's own `x-rate-limit-reset` header only
while that time is still in the future; once it isn't (or there is no header), it backs off on its
own, doubling from 60 seconds up to a 15-minute cap. Either way, a single wait is capped at 20
minutes. If the same request gets rate limited 8 times in a row, the tool gives up on it with an
explicit error instead of waiting indefinitely — re-run the same command later (progress is
saved), or raise `--delay` if it's happening immediately on every request.
</details>

<details>
<summary><strong>"Another x-tweet-nuker run is already using ... (pid ..., started ...)"</strong></summary>

`nuke`/`sweep`/`run` refuse to share one data directory with another run, to stop them from
overwriting each other's progress. If that's genuinely a stale lock — the machine that created it
crashed or was force-killed — delete the `.lock` file named in the error and try again, or use a
different `--data-dir` for a deliberately parallel run.
</details>

<details>
<summary><strong>The post count on my profile hasn't gone down</strong></summary>

That counter is cached and can lag the real state by days. Don't use it to judge progress.
Instead check the profile tabs directly, or `https://x.com/search?q=from%3A<handle>&f=live`. Both
`verify` and the sweep's own "CLEAN" result are more trustworthy than the header counter.
</details>

<details>
<summary><strong><code>login</code> fails to start the browser with a <code>SingletonLock</code> error</strong></summary>

Another `login` (or an old one that was killed uncleanly) is still holding the persistent browser
profile at `.chrome-user-data/`. Close it, or delete `SingletonLock` inside that directory and try
again. This only applies to `login` — `verify` uses a separate, throwaway browser and never
touches `.chrome-user-data/`, so a lock there cannot block it.
</details>

<details>
<summary><strong><code>verify</code> refuses to run, or says it could not sign in</strong></summary>

`verify` needs a captured session (`.x-session-data.json`) — it does not accept a signed-in
`--handle` browser profile as a substitute, because a signed-out check silently produces the same
"nothing rendered" result as a genuinely empty account. Run `login` (or re-run it if the session
has expired) and try again.
</details>

<details>
<summary><strong><code>verify</code> prints <code>COULD NOT CONFIRM</code> instead of <code>CLEAN</code> or <code>NOT CLEAN</code></strong></summary>

This means X rendered a tab with nothing on it, but didn't give any of the positive signals
`verify` requires before it will call that "proven empty" (see [`verify`](#verify) above) — for
example because X changed its page structure again. Open the profile yourself, or re-run with
`--no-headless` to watch it happen; the per-tab log lines show exactly what was and wasn't found,
which is what to compare against the empty-state selectors in `src/commands/verify.js` if X has
changed something.
</details>

<details>
<summary><strong>The run state file got corrupted</strong></summary>

An unparseable `.nuke-state.json` is renamed to `.nuke-state.json.corrupt-<timestamp>` and the run
starts from an empty state rather than refusing to start. The worst case is re-issuing deletes for
ids that are already gone, which X reports harmlessly as "not found".
</details>
