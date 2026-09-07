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
- [Confirmation and identity verification](#confirmation-and-identity-verification)
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

## Confirmation and identity verification

`nuke`, `sweep` and `run` all refuse to delete anything until the operator types the target handle
back at a prompt (or `--yes` is passed deliberately). This is enforced on the destructive client
calls themselves — `deleteTweet` and `unretweet` throw until the confirmation has actually run —
not just at the top of a command, so there is no path through the code (a retry, an early
`continue`, a future refactor) that reaches a deletion without asking first.

The handle shown on that confirmation banner is checked against what X itself says the signed-in
session belongs to:

- If `--handle` (or `X_HANDLE`) names an account, and X can be reached, and X says the session
  signs in as someone else — the run is refused outright, naming both accounts. The alternative
  (trusting `--handle` and quietly emptying whichever account the session actually belongs to)
  is exactly the kind of mislabelling a confirmation prompt exists to prevent.
- If nothing was reachable to check against (X's identity endpoint is down, moved, or the network
  is unreachable), the run is **not** blocked — but the banner prints `!! UNVERIFIED` next to the
  handle, along with the numeric user id the deletion actually targets, so it's visible that the
  name on screen is unconfirmed rather than silently trusted.
- If no handle is known at all and X can't be reached to supply one, the run refuses — it will not
  delete from an account it cannot name even provisionally.

`--handle` given to `login` behaves differently: it is only a fallback used when the browser's own
signed-in handle can't be detected, and it can never override a successfully detected handle. See
[`login`](#login).

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
Replies, Posts, Media, Highlights and Reposts tabs (in that order) to capture the timeline GraphQL
requests the sweep later replays, and scrapes the current `DeleteTweet` / `UnretweetTweet`
`queryId` values out of X's own JS bundles. Every one of those tabs has to be visited: several of
them (Highlights, Reposts) fire their timeline request only while you are standing on them, and a
timeline `login` never captured is a timeline `sweep` can never clear.

The handle is read from the signed-in page itself (the profile link in the app's own nav bar), not
from `--handle` or `X_HANDLE`. Those are only a **fallback** used when that detection genuinely
fails — and if you give one that disagrees with the handle actually detected, `login` refuses
outright rather than saving a session mislabelled with an account it cannot delete from. If
detection fails and nothing was given to fall back on, `login` errors and asks for `--handle`.

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

One confirmation covers both passes — `run` asks once, and neither the archive pass nor the sweep
asks again. `--limit` applies separately to each pass; if either pass stops early because of it,
`run` prints `NOT finished` instead of `Done.` and exits non-zero. `run` never claims "Done." on a
`--limit`-ed pass, on a sweep that didn't reach a clean round, or on an archive pass with unresolved
failures — see [Exit codes](#exit-codes).

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
accepted too, so you can feed in your own id list — including a subset of ids, if what you want is
to delete some specific tweets rather than everything (there's no built-in filtering by date,
content or engagement; a hand-picked id list is the only way to be selective).

Progress is logged every 50 deletions as `Progress <done>/<total> {"deleted":…,"gone":…,
"failed":…,"remaining":…,"perMinute":…}` — `remaining` is what's left in this pass, `perMinute` is
the delete rate over roughly the last five minutes, not a lifetime average. There's no ETA; see
[the note in `sweep`](#sweep) below for why.

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
nothing. The same applies if a timeline hit the 200-page pagination cap while still handing out
cursors (`Stopped paging <timeline> at the 200-page cap…`) — that pass didn't reach the end of the
timeline, so it can't count as clean either, and a round can exit non-zero having found zero posts
for this reason alone.

Within a round, progress is logged every 50 deletions as `Round N progress <done>/<total>
{"deleted":…,"gone":…,"failed":…,"unretweeted":…,"remaining":…,"perMinute":…}`, and the round ends
with `Round N deleted <count> {...}`. `remaining` is what's left in *this round* (a later round can
still find more), and `perMinute` is measured over roughly the last five minutes, not a lifetime
average. There's deliberately **no ETA** anywhere in this tool's output: X's rate limiting is
bimodal — full speed, then a wall of up to 20 minutes — so any time-remaining figure would be
wrong by an order of magnitude exactly when someone stops to read it.

`--limit` makes a sweep stop after N deletions in the current round even though posts are still on
the timeline. That's reported as `STOPPED EARLY` and the run exits `1` — the account is
deliberately *not* claimed to be empty, unlike a normal clean sweep, which exits `0`.

A `--dry-run` here reports one pass only, so the final total of a real sweep is usually higher
than what the dry run shows.

## `verify`

Opens a real browser and checks every profile tab that can render your posts — Replies, Posts,
Media, Highlights and Reposts, in that order (the same tabs, and the same order, that `login`
visits to capture them; see [`PROFILE_TABS`](HOW-IT-WORKS.md#1-session-capture-login-srcsessionjs))
— and, optionally, specific tweet ids. This is a check independent of the deleter's own
bookkeeping. It counts not just your own post cards but reposts too (a repost renders under the
*original* author's link, so it needs its own check), plus any rendered post card that doesn't
match a recognized "nothing here" empty state. Deletes nothing.

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
again") is explicitly never accepted as proof either way.

A profile X refuses to show at all — suspended, protected (and you don't follow it), or
non-existent — is its own, fourth verdict: `COULD NOT CHECK`, exit `1`, never `CLEAN`. X's
"account is suspended" and "these posts are protected" wording used to fall into the same bucket
as a genuinely empty timeline, which meant a suspended account (every post still there, just
hidden from view) could be reported CLEAN. Hidden is not the same claim as empty, so that verdict
can never resolve to CLEAN — see [Exit codes](#exit-codes) for all four.

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
| `X_HANDLE` | your X handle, without `@`. For `nuke`/`sweep`/`run`/`verify`, only meaningful when the session's own handle is unknown, and only as an **unverified** label — a mismatch with what X reports is refused, not overridden (see [Confirmation and identity verification](#confirmation-and-identity-verification)). For `login`, only a **fallback** used when detecting the signed-in handle fails; it cannot override a successfully detected handle | detected automatically |
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
| `1` | Not clean, or a user error, or unconfirmed: some deletions failed, a sweep ran out of rounds (including a round that hit the 200-page pagination cap and so found zero posts without proving the timeline empty), a run stopped early on purpose because of `--limit` (`STOPPED EARLY`, with posts/ids still outstanding), `verify` found something still visible (`NOT CLEAN`), `verify` could not reach a profile at all (`COULD NOT CHECK` — suspended, protected, or nonexistent), `verify` could not get positive proof a tab is empty (`COULD NOT CONFIRM`), or an invalid flag/missing archive/lock conflict was rejected before anything ran |
| `2` | Session expired (HTTP 401/403) — run `login` again; progress is saved, so a retry resumes where it stopped |

`--limit <n>` set larger than what's actually left is not "early" — the pass genuinely finishes
everything there was to do, and that still exits `0`. `STOPPED EARLY` (exit `1`) only happens when
`--limit` was reached with work still outstanding.

> [!NOTE]
> `verify`'s `COULD NOT CONFIRM` and `COULD NOT CHECK` verdicts (both exit `1`) mean exactly what
> they say: neither is "not clean" in the `NOT CLEAN` sense, but neither is a green light either —
> the tool would not stake a `CLEAN` verdict on what it saw (`COULD NOT CONFIRM`), or couldn't see
> the profile at all (`COULD NOT CHECK`). Treat both the same as "not clean" for scripting
> purposes — don't proceed as if the account were confirmed empty.

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

### What Ctrl-C actually guarantees

`nuke` and `sweep` install real handlers for `SIGINT` (Ctrl-C), `SIGTERM`, `SIGHUP` (the console
window closing), and `SIGBREAK` (Ctrl-Break on Windows). On any of those, the run flushes every
tweet id it has already resolved to `.nuke-state.json` and releases the lock file before exiting —
so re-running the same command afterwards resumes with essentially nothing lost. Precisely: at most
the single deletion that was in flight at the moment of the signal goes unrecorded, and even that
is harmless, because X reports an already-deleted tweet as "not found" the next time it's tried,
and that's read as `gone`, not as an error. Only a kill the process cannot intercept at all —
`SIGKILL`, an out-of-memory kill, a power loss — falls back to the last throttled save, which is at
most 5 seconds of deletions behind.

### The lock file

`nuke` and `sweep` (and therefore `run`) hold an advisory lock file, `<state file>.lock`, for as
long as they are writing to that state file, so two runs can't share one data directory and
silently overwrite each other's progress. The lock is released automatically on a normal exit and
on the interrupt handling described above. If a run was killed hard enough to leave the lock
behind, the next run detects that on its own:

- **On the same machine**, a lock whose process id is no longer running is stale immediately —
  taken over with a logged warning, no manual cleanup needed.
- **On any machine, same host or not**, a lock that has gone quiet — no save touching it — for more
  than 90 minutes is *also* treated as stale, even if its process id happens to belong to some
  other, unrelated live process. Process ids get reused by the OS, so a live pid alone is evidence,
  not proof; 90 minutes is chosen to comfortably outlast the longest legitimate silence a real run
  can have (a request stuck through the full escalating rate-limit backoff, worst case a bit over an
  hour).

You only need to intervene by hand if you're certain no other run is using that data directory and
the lock is still refused inside that 90-minute window: delete `<state file>.lock` yourself, or
point at a separate `--data-dir` for a genuinely parallel run.

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
minutes. Any wait longer than about a minute also prints
`Still waiting out the rate limit - about N minute(s) left before the next attempt` roughly once a
minute, specifically so a 20-minute wait doesn't look identical to a hang. If the same request gets
rate limited 8 times in a row, the tool gives up on it with an explicit error instead of waiting
indefinitely — re-run the same command later (progress is saved), or raise `--delay` if it's
happening immediately on every request.
</details>

<details>
<summary><strong>"Another x-tweet-nuker run is already using ... (pid ..., started ...)"</strong></summary>

`nuke`/`sweep`/`run` refuse to share one data directory with another run, to stop them from
overwriting each other's progress. If that's genuinely a stale lock — the machine that created it
crashed or was force-killed, or it just hasn't been touched in over 90 minutes — delete the
`.lock` file named in the error and try again, or use a different `--data-dir` for a deliberately
parallel run. See [The lock file](#the-lock-file) above for exactly when a lock is considered
stale.
</details>

<details>
<summary><strong>The run exited with a non-zero code even though it looked like it worked</strong></summary>

Check the last few lines of output before assuming something's wrong — `nuke`, `sweep`, `run` and
`verify` all use their exit code to mean "the account is provably in the state you asked for",
which is stricter than "no error was thrown". The most common non-error reason: `--limit` was
reached with tweets still outstanding, so the run reports `STOPPED EARLY` on purpose and exits `1`
— that's not a failure, it's the tool refusing to say "done" about a job it deliberately stopped
partway through. See [Exit codes](#exit-codes) for the full list of what each code means for each
command.
</details>

<details>
<summary><strong>A bad <code>--data-dir</code> (unwritable, doesn't exist, full disk) fails with a raw stack trace</strong></summary>

It shouldn't — the logger is the first thing every command sets up, so a directory it can't create
for the log file surfaces as a plain, actionable error naming the path and suggesting a writable
`--data-dir` or `--log`. If you see a raw Node stack trace instead, that's itself worth reporting;
see [the bug report template](https://github.com/4riel/x-tweet-nuker/blob/main/.github/ISSUE_TEMPLATE/bug_report.yml).
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
<summary><strong><code>verify</code> prints <code>COULD NOT CHECK</code></strong></summary>

X isn't showing the profile at all — it reported the account as suspended, protected (and this
session doesn't follow it), or non-existent. This is deliberately never reported as `CLEAN`: a
hidden profile most likely still holds every post it ever had, it just isn't being served to this
viewer, and treating "nothing rendered because I'm not allowed to look" the same as "nothing
rendered because there's nothing there" is exactly the bug this verdict exists to prevent. If
you're checking your own account and it's showing as suspended, that's an X account-standing issue
outside this tool's scope; if you're checking someone else's protected account with `--handle`,
you'd need to be following it (signed in as the account you followed it with) to see anything.
</details>

<details>
<summary><strong>The run state file got corrupted</strong></summary>

An unparseable `.nuke-state.json` is renamed to `.nuke-state.json.corrupt-<timestamp>` and the run
starts from an empty state rather than refusing to start — but it says so loudly rather than
silently: a warning names the exact backup file and states plainly that this run starts from ZERO
recorded progress, specifically so that isn't discovered only by noticing an all-night run redoing
work it already did. The corrupted file isn't deleted, only set aside, so nothing already on disk
is lost. The worst practical consequence is re-issuing deletes for ids that are already gone, which
X reports harmlessly as "not found" and the tool records as `gone`.
</details>
