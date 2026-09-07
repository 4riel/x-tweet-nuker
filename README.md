<div align="center">

# x-tweet-nuker

**Delete every tweet you ever posted. One command, your own login, nobody else's servers.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen.svg)](https://nodejs.org)

</div>

X gives you no way to bulk-delete your posts, and its API will not do it either. `x-tweet-nuker`
is a small Node CLI that clears an entire account by replaying the exact requests the x.com web
app makes, signed in as you, from your machine. It cleared a 4,473-tweet account in about five
hours with zero failed deletions.

> [!WARNING]
> **This is irreversible. There is no undo — not in this tool, not on X, not in a fresh archive.**
> A tweet deleted here is gone for good. An archive downloaded afterwards only exports what still
> exists at the time you download it.
>
> **Download your X data archive before you run anything here.** Settings → Your account →
> Download an archive of your data. Wait for the email, download the ZIP, keep it somewhere safe.
> It is the only record you will ever have of what you posted.

## What a real run looks like

```console
$ node bin/cli.js run

  ####################################################################
  #  THIS PERMANENTLY DELETES TWEETS. IT CANNOT BE UNDONE.           #
  #  Deleted posts are not recoverable - not by this tool, not by X, #
  #  and not from your archive download.                             #
  ####################################################################

  Account : @yourhandle
  Action  : delete your entire archive (4473 tweets), then sweep your timelines until empty

  Type the handle (@yourhandle) to continue, or anything else to abort: yourhandle

[2026-09-06T18:09:19.586Z] === Pass 1 of 2: archive ===
[2026-09-06T18:09:19.698Z] Archive loaded {"files":1,"tweets":4473,"alreadyHandled":0,"queued":4473}
[2026-09-06T18:09:41.204Z] Progress 50/4473 {"deleted":50,"gone":0,"failed":0,"remaining":4423,"perMinute":140}
[2026-09-06T18:10:49.305Z] Progress 200/4473 {"deleted":200,"gone":0,"failed":0,"remaining":4273,"perMinute":134}
[2026-09-06T18:10:50.415Z] WARN Rate limited by X - waiting 694s: waiting for the rate-limit window X reported {"tweetId":"1326498712"}
[2026-09-06T18:19:12.033Z] Still waiting out the rate limit - about 8 minute(s) left before the next attempt
[2026-09-06T18:27:13.575Z] Progress 250/4473 {"deleted":250,"gone":0,"failed":0,"remaining":4223,"perMinute":14}
...
[2026-09-06T23:42:41.277Z] Archive pass complete {"deleted":4473,"gone":0,"failed":0}
[2026-09-06T23:42:41.281Z] === Pass 2 of 2: timeline sweep ===
[2026-09-06T23:42:41.402Z] Sweeping timelines {"operations":["UserRepliesTimeline","UserOriginalsTimeline","UserVideoTimeline"]}
[2026-09-06T23:43:29.853Z] Round 1: found 116 post(s) still on your timelines
[2026-09-06T23:52:04.911Z] Round 1 progress 50/116 {"deleted":50,"gone":0,"failed":0,"unretweeted":0,"remaining":66,"perMinute":37}
[2026-09-06T23:56:36.558Z] Round 1 deleted 116 {"deleted":116,"gone":0,"failed":0,"unretweeted":0}
[2026-09-06T23:56:52.346Z] Round 2: found 0 post(s) still on your timelines

  CLEAN - a full pass over every timeline found nothing left.

[2026-09-06T23:56:52.347Z] Sweep complete {"rounds":2,"deleted":116,"gone":0,"failed":0,"unretweeted":0}

  Done. Confirm it independently with `x-tweet-nuker verify` - X's own post
  counter on your profile is cached and lags days behind a bulk deletion.
```

Two passes, because neither one is enough alone. The archive pass takes the id list you already
downloaded and deletes it in a straight line. The sweep then pages your own timelines and removes
whatever the archive never knew about — retweets, and anything you posted after the export —
repeating until a complete pass finds nothing.

## Why not something simpler

| The obvious option | What actually happens |
|---|---|
| The official X API | A free-tier app that isn't attached to a Project gets `403 client-not-enrolled` on every v2 endpoint, and v1.1 `statuses/destroy` answers `404`. Even the **paid** v2 delete endpoint allows **17 deletes per 24 hours** — 264 days for 4,473 tweets. |
| A paid "tweet eraser" service | You hand a stranger an OAuth token or your password so they can do exactly what this does. Your posts are their product. |
| Deleting the account | You lose the handle, the DMs, the follows and every future use of the account — a heavy price for getting rid of old posts. |

So this tool skips the public API entirely. It replays the same internal GraphQL mutations the
x.com web client issues — `DeleteTweet`, `UnretweetTweet`, and the profile timeline queries —
authenticated with cookies captured from a real logged-in browser session on your own machine.
Nothing leaves your machine except the requests to X itself. The exact request and response shapes
are documented in [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

## Quickstart

You need **Node.js 20 or newer** (Playwright requires it) on Windows, macOS or Linux. Roughly ten
minutes of your attention, then a few hours of unattended running.

**1. Download your X archive first, and wait for it.**

Settings → Your account → Download an archive of your data. X takes anywhere from an hour to a
day to email you the link. Do this before anything else, for two reasons: it is the only copy of
your posts you will ever have again, and it hands the tool a complete id list up front so the
bulk of the deleting is one straight pass instead of a slow crawl through shrinking timelines.

**2. Install.**

```bash
git clone https://github.com/4riel/x-tweet-nuker.git
cd x-tweet-nuker
npm install
npx playwright install chromium   # separate download from npm install
```

This is not published on npm, so `npx x-tweet-nuker` will not work — run it from the clone as
`node bin/cli.js <command>`, exactly as every command below does. If you would rather type
`x-tweet-nuker <command>`, run `npm link` in the clone once; the two are then interchangeable, and
that shorter name is what the tool's own messages use.

**3. Put the archive where the tool can find it.**

Unzip the archive and copy `data/tweets.js` into this directory (or point at it later with
`--archive <path>`).

**4. Sign in once.** Opens a real browser window; log in to X in it as you normally would. Takes
under a minute, deletes nothing.

```bash
node bin/cli.js login
```

The session — cookies, your numeric user id, and the internal API details the tool needs — is
saved locally to `.x-session-data.json`. Check it landed with `node bin/cli.js status`.

**5. Dry run. Always dry run first.** Nothing is deleted, no confirmation is asked, and you see
exactly what the real run would touch.

```bash
node bin/cli.js run --dry-run
```

```console
  DRY RUN - nothing will be deleted.
  Would delete 4473 tweet(s) from the archive.
  First ids: 1326457821, 1326479204, 1327018553, ...
  ... and 4463 more.
...
  Dry run finished - nothing was deleted. Re-run without --dry-run to delete.
```

**6. Delete everything.** You will be asked to type your handle back before anything happens.

```bash
node bin/cli.js run
```

Expect hours, not minutes (see [How long it takes](#how-long-it-takes)). The run is resumable: if
it dies, is rate-limited into silence, or you Ctrl-C it, run the same command again and it picks
up where it stopped. Add `--yes` to skip the typed confirmation when re-running unattended.

**7. Prove it worked.** `verify` opens a fresh browser, signs in as you, and reports what is still
rendered on your profile — a check independent of the deleter's own bookkeeping.

```bash
node bin/cli.js verify
```

## Commands

| Command | What it does |
|---|---|
| `login` | Sign in to X and capture the session — start here |
| `run` | Archive pass, then sweep until clean (the usual choice) |
| `nuke` | Delete every tweet listed in your archive's `tweets.js` |
| `sweep` | Page your timelines and delete whatever is left, until a pass finds nothing |
| `verify` | Open your profile in a browser and prove it is empty |
| `status` | Show session health, archive size and deletion progress |

Every destructive command makes you type your handle back before it does anything — this is
enforced at the deletion calls themselves, not just at the top of a command, so there is no code
path that deletes a tweet without it — and every destructive command supports `--dry-run`. A
`--limit`-ed run is deliberately incomplete: it prints `STOPPED EARLY` and exits non-zero rather
than claiming to be done.

**→ [Full CLI reference](docs/CLI.md)** — every flag, environment variable, exit code, and the
troubleshooting list.

## How long it takes

X's own rate limit — not something this tool imposes — allows roughly **200 deletions per
15-minute window**. Budget about an hour per 800 tweets. The 4,473-tweet account in the demo above
took about five hours end to end, with zero failed deletions.

The tool waits out rate limits on its own, honouring X's `x-rate-limit-reset` header when it
points at a real future time and backing off exponentially when it doesn't. A wait longer than a
minute prints roughly once a minute so it's never indistinguishable from a hang. Long runs are
meant to be left alone — see [running unattended](docs/CLI.md#resuming-and-running-unattended).

Progress lines report deletions left and a recent-window rate (`perMinute`, over the last five
minutes) — deliberately **no ETA**. X's throttling is bimodal (full speed, then a wall of up to 20
minutes), so any time-remaining estimate would be wrong by an order of magnitude exactly when
someone stops to read it.

If you're interrupted — Ctrl-C, closing the terminal, `kill`, a reboot — every tweet id already
resolved is on disk before the process exits; re-running the same command picks up where it
stopped. At most the single deletion that was in flight is unrecorded, and even that is harmless:
X reports an already-deleted tweet as "not found" on retry. Only an unstoppable kill (`SIGKILL`, an
OOM kill, power loss) can lose more, and even then it's at most the last few seconds.

> [!TIP]
> The post counter in your profile header is cached and can stay wrong for days. Judge progress by
> `x-tweet-nuker status`, by the profile tabs themselves, or by
> `x.com/search?q=from%3A<handle>&f=live` — never by that number.

## Your session file is a credential

`login` writes `.x-session-data.json`, containing your full X cookie header, CSRF token, numeric
user id, and the GraphQL request details the tool needs.

> [!IMPORTANT]
> **That file is equivalent to your live login.** Anyone who obtains it can act as you on X
> without your password, exactly like a stolen session cookie.

- It is written only to your local disk, in the directory you choose, and never sent anywhere but
  x.com.
- It, `.env`, the run-state file and the browser profile directory (`.chrome-user-data/`) are all
  in [`.gitignore`](.gitignore). Don't remove them, and check twice before committing if you fork.
- When you are done, revoke it from X's side: **Settings → Security and account access →
  Sessions**, and log out anything you don't want left alive.

Full threat model, what's protected today, what to do if the file leaks, and how to report a real
vulnerability privately: **[SECURITY.md](SECURITY.md)**.

## Frequently asked

**I have ~200,000 tweets. Will this even run?** Yes. The archive parser streams `tweets.js` a
record at a time instead of loading it into memory, so archive size isn't a limit — see
[How it works](docs/HOW-IT-WORKS.md#archive-parsing-srcarchivejs).

**Can I delete only some tweets, not everything?** Not by content, date, or engagement — this tool
has no filtering. What you *can* do: point `--archive` at your own JSON file containing just the
id strings you want gone (`nuke` accepts a plain array of ids, not only a real archive export), or
use `--limit` to stop a pass after N deletions and pick up manually later. There's no "keep the
top N" or "delete tweets older than" mode.

**What about likes, DMs, bookmarks, or pinned tweets?** Not supported. This tool only ever calls
`DeleteTweet` and `UnretweetTweet` against your own posts and reposts, discovered from your archive
and from your own profile timelines (Posts, Replies, Media, Highlights, Reposts). It never touches
likes, direct messages, or bookmarks, and a pinned tweet is deleted like any other post — nothing
un-pins it first, X just does that automatically when the tweet is gone.

**Does this work on a protected (locked) account?** For emptying your own account, yes — you're
authenticated as yourself, so your own protection setting doesn't hide your own timeline from you.
It only matters for `verify --handle <someone-else>` against a protected account you don't follow:
X won't show you that profile, and `verify` reports `COULD NOT CHECK` rather than guessing.

## Legal

This project is not affiliated with, endorsed by, or connected to X Corp. It drives x.com's
internal, undocumented web API rather than a supported public interface, which is very likely a
violation of X's Terms of Service. Use it at your own risk, on your own account. The authors take
no responsibility for suspended accounts, rate limiting, or anything else X decides to do in
response.

## Docs

- [CLI reference](docs/CLI.md) — flags, environment variables, exit codes, troubleshooting
- [How it works](docs/HOW-IT-WORKS.md) — session capture, GraphQL shapes, sweep loop, rate limits,
  the archive parser, and the confirmation gate
- [Contributing](CONTRIBUTING.md) — where things live, how to run the tests (`npm test`, offline
  and fast), CI, and the one fix this project will always need when X renames its internal
  operations again
- [Security policy](SECURITY.md) — the session-file threat model and how to report a real
  vulnerability privately

CI ([`.github/workflows/test.yml`](.github/workflows/test.yml)) runs the offline test suite on
Node 20, 22 and latest across Ubuntu, macOS and Windows on every push and pull request. The tool
itself has only actually been run against a real X account on Windows; macOS and Linux get the
same test suite in CI but not yet a real-account run, so treat those two as "should work,
untested against X" rather than verified.

## License

MIT — see [LICENSE](LICENSE).
