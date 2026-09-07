# How it works

This is a technical walkthrough of the mechanism, for anyone curious or planning to contribute.
It describes what the code in this repository actually does, file by file, including the exact
request and response shapes involved.

## Overview

```
login   -> browser session -> .x-session-data.json (cookies, queryIds, timeline URLs)
nuke    -> archive tweets.js -> DeleteTweet mutation, one id at a time
sweep   -> timeline GraphQL queries -> UnretweetTweet + DeleteTweet, round after round
run     -> nuke, then sweep
verify  -> one client probe, then a browser reading the rendered profile - independent of the
           deleter's own bookkeeping, but authenticated the same way it is
status  -> reads session + state files, optionally one live probe request
```

`nuke`, `sweep`, `run` and `status --check` talk to x.com only through the plain `fetch()`-based
HTTP client (`src/client.js`), authenticated with cookies a browser captured earlier — no browser
of their own. `login` and `verify` both open a real browser (for different reasons: `login` needs
one so a human can sign in; `verify` needs one because rendered HTML, not a JSON API response, is
the thing being checked). `verify` is not otherwise independent of `src/client.js`, though: it
makes one plain HTTP call through it (`fetchOwnHandle`) before ever opening a page, as a cheap
sanity check and a fallback source for the handle.

Two things sit in front of every deletion, and neither is a JSON shape or an HTTP status: the
confirmation gate (`src/confirm.js`) that makes `deleteTweet`/`unretweet` structurally incapable of
firing before a human (or `--yes`) has agreed, and identity verification (`src/context.js`) that
checks the handle on that confirmation banner against what X itself says the session belongs to.
Both are covered right after session capture, below, because they matter before anything else in
this document does.

## 1. Session capture (`login`, `src/session.js`)

`login` launches a persistent Playwright Chromium context rooted at `.chrome-user-data/` (so a
second `login` reuses the same signed-in profile), then:

1. Navigates to `https://x.com/home` and polls `context.cookies()` every 3 seconds until both
   `auth_token` and `ct0` cookies are present, prompting the user to sign in if they aren't. In
   headless mode with no existing session this fails fast instead of hanging silently.
2. Once signed in, builds the cookie header by joining every cookie as `name=value; ...`, and
   reads the account's numeric id out of the `twid` cookie (`u=<id>`, URL-decoded).
3. **Detects the handle** from the app's own nav bar (`a[data-testid="AppTabBar_Profile_Link"]`'s
   `href`) — always attempted first, regardless of `--handle`/`X_HANDLE`. If detection succeeds and
   a claimed handle was also given, and the two disagree, `login` refuses outright rather than
   saving a session labelled with an account it cannot actually delete from (the failure names both
   handles and the numeric id). `--handle`/`X_HANDLE` only ever supplies the handle when detection
   itself genuinely fails - it can never override a successful detection. This used to work the
   other way around (`config.handle || detectHandle(...)`), which meant a stale `--handle` or an
   old `X_HANDLE` line in `.env` could silently mislabel a session for a different account than the
   browser was actually signed into — including on the confirmation gate later.
4. **Scrapes live GraphQL `queryId`s** (`scrapeQueryIds`): collects every `abs.twimg.com/*.js`
   bundle URL the page has loaded (from `<script src>` tags and from
   `performance.getEntriesByType("resource")`, since code-split chunks loaded after first paint
   never appear as script tags), fetches each one, and regex-matches
   `queryId:"<id>",operationName:"DeleteTweet"` (and the reverse key order, since the bundler
   emits either). If scraping finds nothing, it falls back to `FALLBACK_QUERY_IDS` — values
   correct at the time of writing, kept only as a last resort.
5. **Captures timeline request URLs** by attaching a `page.on("request")` listener that matches
   `/graphql/<queryId>/<OperationName>` and classifies `OperationName` with `isTimelineOperation`:
   an explicit allow-list (`KNOWN_TIMELINE_OPS`), an explicit deny-list for lookup operations
   (`NOT_A_TIMELINE`, e.g. `UserByScreenName`), and finally a permissive pattern —
   `/^User[A-Za-z]*(Timeline|Tweets|Media|Replies|Posts)$/` — meant to catch a future rename this
   list hasn't seen yet. It then visits `/<handle>/with_replies`, `/<handle>`, `/<handle>/media`,
   `/<handle>/highlights` **and `/<handle>/reposts`** in turn (7 seconds each, enough for the
   page's own requests to fire) so the real timeline request for each tab gets captured. The last
   two are included specifically because `UserHighlightsTimeline` and `UserRepostsTimeline` only
   ever fire on their own tab — the Posts tab fires `UserOriginalsTimeline`, which is originals —
   and a timeline `login` never captures is a timeline `sweep` can never clear. The **first** URL seen per
   operation is kept — it already carries every feature-flag query parameter X's web client
   sends, which is far more durable than trying to reconstruct that parameter set by hand.

6. Writes the session file (`saveSession`), and `chmod 600`s it where the platform honours POSIX
   modes (a no-op on Windows; the `.gitignore` entry is the real protection there).

### Session file shape

```json
{
  "handle": "example",
  "myUserId": "1234567890",
  "cookieHeader": "auth_token=...; ct0=...; twid=u%3D1234567890; ...",
  "ct0": "the csrf token",
  "queryIds": { "DeleteTweet": "...", "UnretweetTweet": "..." },
  "timelineUrls": {
    "UserOriginalsTimeline": "https://x.com/i/api/graphql/<id>/UserOriginalsTimeline?variables=...&features=...",
    "UserRepliesTimeline": "https://x.com/i/api/graphql/<id>/UserRepliesTimeline?variables=...&features=...",
    "UserVideoTimeline": "https://x.com/i/api/graphql/<id>/UserVideoTimeline?variables=...&features=..."
  },
  "graphqlOperationsSeen": ["UserByScreenName", "UserOriginalsTimeline", "..."],
  "savedAt": "2026-01-01T00:00:00.000Z"
}
```

`graphqlOperationsSeen` is the full, unfiltered list of every GraphQL operation name the browser
requested during login — kept specifically so a user whose sweep captures nothing has something
to diagnose against (see [Troubleshooting](CLI.md#troubleshooting) in the CLI reference).

## Archive parsing (`src/archive.js`)

`nuke`'s id source, and the fast path `run` prefers over discovering everything by paging
timelines. It reads `tweets.js` (or a directory of `tweets*.js` files) from an unzipped X archive,
and its one real design constraint is size: a heavy account's `tweets.js` is routinely hundreds of
megabytes, and reading that into one JavaScript string before calling `JSON.parse` on it would cost
roughly 3.3x the file size in heap — and fail outright past 512 MB, V8's hard limit on a single
string's length. An account with on the order of 200,000 tweets is exactly the case this exists
for; it is not a limit this tool has.

**`streamArchiveArray`** is a hand-written streaming JSON-array scanner that never holds the whole
file in memory. It reads the file in fixed-size chunks (1 MB, `CHUNK_BYTES`) directly into a
reused byte buffer via `fs.readSync`, and scans *bytes*, not decoded characters: every JSON
structural character (`{`, `}`, `[`, `]`, `"`, `,`) is ASCII, and no byte of a multi-byte UTF-8
sequence is ever below `0x80`, so a byte-level scan can never mistake part of a multi-byte
character for a bracket or a quote. Only the bytes of one complete, already-bounded element are
ever handed to `JSON.parse` and then discarded — so peak memory is roughly one buffer plus one
tweet, not one buffer per file size.

The scan tracks bracket depth and string/escape state to find where each top-level array element
starts and ends (`readValue`), calls `onEntry` with the parsed element, and immediately forgets the
raw bytes behind it — `more()` drops everything before the current element on every refill
(`buf.copyWithin`), only growing the buffer when a single element is bigger than the current chunk
size. An `anchor` pins the first byte of whatever element is currently being captured, so a refill
mid-element can't discard bytes that capture still needs. This also rejects the malformed array
shapes (`[1 2]`, `[,1]`, `[1,]`) that `JSON.parse` would have caught, via an explicit
comma/no-comma state machine around each element, and throws the same kind of `SyntaxError`
`JSON.parse` would for a truncated or malformed file — surfaced as a `UserError` naming the file.

Two wrapper concerns sit around the scanner:

- **The `window.YTD.tweets.part0 = ` assignment prefix.** Some archive exports wrap the array
  literal in a JS assignment rather than shipping bare JSON. The first `HEAD_CHARS` (512) bytes are
  read up front (also enough to skip a UTF-8 BOM), matched against `ASSIGNMENT_PREFIX`, and the
  cursor advanced past whatever prefix matched before the streaming scan looks for the opening
  `[`.
- **Fallback for anything that isn't a JSON array literal at all.** If `streamArchiveArray` returns
  `false` (the byte after skipping whitespace and any prefix isn't `[`), `parseArchiveFile` falls
  back to reading the whole file and calling `JSON.parse` on it directly — safe to do at that point
  precisely because whatever this file is, it isn't a real archive export, so it's very unlikely to
  be hundreds of megabytes. This is also what gives a malformed file the same diagnosis it always
  had, rather than a scanner-specific error message.

**`readArchiveIds`** feeds every parsed entry through `collect`, which accepts either an archive
record (`{ tweet: { id_str, created_at, ... } }`) or a bare id string — so a hand-written JSON array
of id strings is accepted too, which is the supported way to hand `nuke` a curated subset of ids
rather than everything in the archive (this tool has no other selection mechanism — no filtering by
date, content, or engagement). Ids are deduplicated as they stream in, via a `Map` from id to array
position, so a multi-part archive that lists the same tweet twice doesn't cost memory proportional
to the duplicate count; the earliest `created_at` seen for a given id wins. The result is sorted
oldest-first before being returned — deliberately, so that a run interrupted partway through leaves
the *most recent* tweets undeleted, which are the easiest ones to sanity-check by hand.

## The confirmation gate and identity verification (`src/confirm.js`, `src/context.js`)

Deleted tweets cannot be restored, so the confirmation prompt is not treated as UI - it's treated
as an access-control problem, and it's solved the same way: fence the dangerous operations
themselves, not the code paths that are supposed to lead to them.

**The gate (`createDestructionGate`) wraps the client, not the command.** `createRunContext` builds
the gate before the client and immediately wraps the client with `gate.protect()`, so no command
ever holds an unguarded reference to `deleteTweet` or `unretweet` (the two entries in
`DESTRUCTIVE_METHODS`). Every other client method — timeline reads, `fetchOwnHandle`, `sleep` —
passes through untouched. Until `gate.arm(handle)` has actually been called, the wrapped
`deleteTweet`/`unretweet` throw a `UserError` instead of ever reaching the real client method — so
a bug that reaches a delete call without asking first fails loudly as "this is a bug in
x-tweet-nuker", not silently as a real deletion. This replaced an earlier design where the ask
happened at the right *moment* in the flow (e.g. "only on round 1"); that is not the same as
enforcement, because a `continue` that skipped round 1 walked straight past a moment-based check.
`sweep`'s harvest-fails-so-retry path is exactly that shape — a `continue` before the confirmation
would have been reached — which is why the gate had to move onto the calls themselves.

**`requireGate(ctx)`** is the first line of every destructive command: it proves the run's own
client really is the one its own gate fenced (`client[GUARDED_BY] !== gate` fails otherwise, via a
non-forgeable `Symbol`), so a future refactor that assembles a context by hand can't quietly hand a
command a raw, unfenced client.

**Identity verification (`resolveTargetHandle`, `src/context.js`)** answers a different question:
not "did anyone agree", but "is the account named on that agreement actually the one about to be
emptied". The handle shown on the confirmation banner is only ever a label - the numeric user id in
the session file is what deletion actually targets - so a `--handle`/`X_HANDLE` value that
disagrees with what X itself reports is refused outright rather than silently preferred:

- If a claimed handle is given and `fetchOwnHandle()` succeeds and disagrees, the run is refused,
  naming both the claimed and the actual handle plus the numeric user id.
- If a claimed handle is given and the probe succeeds and agrees, it's marked `verified: true`.
- If no handle is claimed at all and the probe succeeds, the reported handle is adopted and marked
  `verified: true`.
- If the probe fails (network error, X moved the endpoint, HTTP error) and a handle *was* claimed,
  the run is **not** blocked - it proceeds with that handle marked `verified: false`, and
  `confirmDestruction`'s banner prints `!! UNVERIFIED` next to it along with the numeric user id
  that will actually be emptied (see the banner's exact wording in `src/confirm.js`). Blocking here
  would mean the tool permanently stops working the day X renames or moves this identity endpoint -
  worse than proceeding, honestly labelled as unverified.
- If the probe fails and there is no claimed handle either, the run refuses: it will not delete
  from an account it cannot name even provisionally.

The result is cached on the context (`ctx.target`) so it's resolved once per run, not once per call
- `nuke`, `sweep` and `run` (which drives both) all call it, and `run` confirming once has to cover
both passes without re-probing.

## 2. The GraphQL request shape (`src/client.js`)

Every authenticated request (mutation or timeline read) uses the same headers:

```
authorization: Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA
content-type: application/json
cookie: <captured cookieHeader>
x-csrf-token: <ct0>
x-twitter-auth-type: OAuth2Session
x-twitter-active-user: yes
x-twitter-client-language: en
origin: https://x.com
referer: https://x.com/home
user-agent: <a recent desktop Chrome UA string>
```

The bearer token is not a secret — it is the public constant x.com's own web client ships in its
JS bundle, shared by every browser session. What actually authenticates the request is the
cookie header plus the CSRF token, both scoped to the signed-in account.

### Mutations

Mutations POST to `https://x.com/i/api/graphql/<queryId>/<OperationName>` with body
`{ "variables": {...}, "queryId": "<queryId>" }` — no `features` object, unlike some of X's other
GraphQL calls; `DeleteTweet` and `UnretweetTweet` don't require one.

**`DeleteTweet`**

```json
{ "variables": { "tweet_id": "<id>", "dark_request": false }, "queryId": "<queryId>" }
```

Success requires **both** HTTP 200 **and** a truthy `data.delete_tweet` in the parsed JSON body
(`data.tweet_delete` is also accepted, as a hedge against a future rename back) — a non-200 status
is never read as success even if the body happens to contain that field. A 429 triggers the
rate-limit wait and retries the same id, up to `MAX_RATE_LIMIT_ATTEMPTS` (8) consecutive attempts
before giving up with an explicit `UserError`; a 401/403 throws `SessionExpiredError` immediately
(there is no point retrying — every subsequent call will fail the same way until `login` runs
again).

Anything else is checked against `ALREADY_GONE` — `/not found|no status found|does not exist/i` —
but **only** against the `message` fields of a structured `res.json.errors` array, never against
the raw response text. That distinction is deliberate and fixes a real bug: matching against raw
text meant an HTML error page (a Cloudflare block page, a maintenance page, anything containing
the literal words "404 Not Found") would be misread as "this tweet is already deleted" and the id
would be written to `state.gone` — permanently skipped by every future run, with the tool
reporting success on an account it never actually touched. Requiring a real GraphQL error array
closes that hole. `not authorized` was also removed from the pattern on purpose: it means "this
tweet is not yours to delete", which is a real error, not evidence the tweet is gone. Anything that
doesn't match `ALREADY_GONE` under a structured error is `status: "error"` and gets recorded in
`state.failed`, not silently treated as done.

**`UnretweetTweet`**

```json
{ "variables": { "source_tweet_id": "<id of the original tweet>", "dark_request": false }, "queryId": "<queryId>" }
```

Success: HTTP 200 with a truthy `data.unretweet`, the same strict pairing as `DeleteTweet`. A
retweet's own id only stops resolving once the retweet relationship is undone via its *source*
tweet's id — `sweep` calls this before calling `DeleteTweet` on the retweet's own id.

### Session health probe

`fetchOwnHandle` is not a GraphQL mutation — it's a plain GET against a v1.1 REST endpoint,
`https://x.com/i/api/1.1/account/multi/list.json`, with the same headers as everything else. It
serves two purposes: `status --check` uses it to tell an expired session from a working one, and
`verify` uses it as a cheap pre-flight check plus a fallback source for the handle when neither
`--handle` nor the session file has one. It used to call `account/settings.json` instead; X has
since retired that endpoint (and the rest of that generation of v1.1 REST calls) for the web
client, so it answered 404 for every session regardless of whether the session actually worked —
which meant `status --check` was permanently reporting failure. `account/multi/list.json` is
still live because it backs a feature the web client still uses (switching between multiple
logged-in accounts): the response is a list of every account signed in to that browser session,
and `fetchOwnHandle` picks out the one whose `user_id` matches the session's own `myUserId` rather
than assuming there's only one, since a real browser profile can be signed into several accounts
at once.

### Timeline reads

`timelineRequestUrl` rebuilds one of the URLs captured at login: it parses the `variables` query
parameter as JSON, overwrites `userId` with the current account's id and `count` with
`config.timelinePageSize` (100, not user-configurable), sets or deletes `cursor`, and
re-serializes. Every other query parameter from the captured URL — most importantly `features`,
X's ever-growing feature-flag bag — passes through untouched. This is a GET request with the same
headers as above.

## 3. Reading a timeline response (`collectOwnTweets`)

X's timeline JSON nests entries differently per operation and reshapes the structure periodically,
so rather than following a fixed path, `collectOwnTweets` recursively walks the entire parsed
JSON tree looking for two shapes:

- **A tweet object**: any node with a `legacy` object carrying `id_str` and `user_id_str`. If
  `user_id_str` matches the signed-in account's id (**the ownership filter** — this is what keeps
  the tool from ever touching someone else's tweet even if one showed up in a reply-timeline
  payload), it's recorded as `{ id, retweetOf }`, where `retweetOf` is read from
  `legacy.retweeted_status_result.result.rest_id` (or its nested `legacy.id_str`) when the tweet
  is a retweet, else `null`.
- **A pagination cursor**: either a node with `cursorType === "Bottom"` and a `value`, or an
  `entryId` matching `/^cursor-bottom/` whose `content.value` holds the cursor. Both shapes are
  collected because different timeline operations emit different ones.

`fetchTimelinePage` returns `{ items: Map<id, {id, retweetOf}>, cursors: string[], failed: bool }`
for one page, or `null` specifically to mean "this call hit a 429, already waited, caller should
retry the same cursor." `failed: true` marks a page that could not be read at all (a network
error, or an HTTP error / non-JSON body) — an empty result from a failed page proves nothing about
whether that part of the timeline is actually empty, which matters below.

## 4. The sweep loop (`src/commands/sweep.js`)

**Harvesting one round** (`harvest`) pages every timeline URL captured at login in turn: for each,
it keeps requesting the next cursor (from `fetchTimelinePage`'s `cursors`, filtered to one that
differs from the current cursor) until either the next cursor is unavailable, or 3 consecutive
*pages* return zero new items each (`emptyPages`, judged per page's own result, not against the
running total — a page whose items were all already seen on an earlier timeline still resets the
counter, so a shared timeline's later pages aren't cut short), or `maxTimelinePages` (200) is hit —
whichever comes first. Results across all timelines are merged into one deduplicated map by tweet
id, and the count of pages that came back `failed` is tracked alongside it, alongside a list of
which timeline(s) hit the page cap (`cappedTimelines`) — logged as `Stopped paging <timeline> at
the 200-page cap while it was still handing out cursors`, since a genuinely huge, still-live
timeline and one that simply hit an arbitrary cap look identical from the caller's side unless this
is tracked explicitly.

**Why rounds, not one pass**: deletion on X is eventually consistent — a tweet can still be served
by a timeline for a while after a successful delete. A single empty-looking harvest proves
nothing about the tens of tweets that were server-side "deleted" moments earlier but haven't
dropped out of the timeline cache yet. So `sweep` repeats the harvest-and-delete cycle, up to
`maxRounds` (default 30, minimum 1, `--max-rounds`) times, and only declares success when one full round's
harvest returns zero items **and zero failed pages and zero capped timelines** across every
timeline. A round that found nothing only because requests were failing, *or* because a timeline
stopped paginating at the cap while it still had cursors left to hand out, is explicitly *not*
treated as clean — both are logged as inconclusive and retried after a short pause, since a tool
that can silently report "CLEAN" after merely failing to look all the way to the end is worse than
one that keeps trying. This is also the one way `sweep` can exit non-zero having found zero posts
in a round: hitting the page cap with nothing on the timeline yet, while the timeline is still
paginating, is not the same claim as the timeline actually being empty. If it runs out of rounds
without a genuinely clean pass, it says so and suggests running `sweep` again after a short wait,
since the state it needs (`.nuke-state.json`) already reflects everything actually deleted.

Within a round, each item that has a `retweetOf` gets `unretweet(retweetOf)` before
`deleteTweet(item.id)`; both count independently in the round's summary. Progress within a round is
logged every `PROGRESS_EVERY` (50) deletions as `Round N progress <done>/<total> {...,
"remaining":…, "perMinute":…}`, and the round itself ends with `Round N deleted <count> {...}`
(this line used to read "removed"; it's "deleted" now, to match the vocabulary `state.js` uses
everywhere else). `nuke`'s own progress lines use the identical `{remaining, perMinute}` pair via
the same `createRateWindow()` helper (`src/logger.js`) — `remaining` is what's left in the current
pass or round, and `perMinute` is a **recent-window** rate (the last ~5 minutes of recorded
deletions), not a lifetime average. That choice is deliberate: a lifetime average is worst exactly
when someone is watching it, because one long rate-limit stall drags it down permanently and it
never recovers even once the run is back to full speed. There is deliberately **no ETA** derived
from either figure anywhere in this tool's output — X's throttling is bimodal (full speed, then a
wall of up to 20 minutes), so any time-remaining estimate would be wrong by an order of magnitude
in one direction or the other, and it would be most wrong at the exact moment someone stops to read
it.

## 5. Rate-limit handling (`waitForRateLimit`)

On an HTTP 429, the client reads the `x-rate-limit-reset` response header (a Unix timestamp in
seconds — X's own stated reset time) and picks one of three strategies, each logged so the reason
is visible (`--verbose` or the log file shows `Rate limited by X - waiting Ns: <reason>`):

1. **First 429 on this request, with a reset time still in the future** — wait until that time
   plus a 5-second margin (15-second floor), trusting X's own number.
2. **A later 429 on the same request, and the reset time (if any) is still in the future** —
   waiting exactly as long as X asked did not help last time, so wait the *longer* of the header
   time and an exponential backoff (`60s * 2^(attempt-1)`, capped at 15 minutes).
3. **No usable reset time** — either none was sent, or the one that was sent has already passed
   (a stale/past header is deliberately treated as no header at all, since honoring it verbatim
   would turn into a tight, endless 15-second retry loop that looks exactly like normal rate
   limiting from a silent terminal) — fall back to the same exponential backoff on its own.

Either way, the actual sleep is additionally capped at `config.maxRateLimitWaitMs` (20 minutes,
not currently exposed as a flag). And unlike waiting alone, retrying is not unconditional: each
request tracks its own consecutive-429 count, and once a single request has been refused
`MAX_RATE_LIMIT_ATTEMPTS` (8) times in a row — roughly an hour of escalating waits — the client
gives up on it and throws a `UserError` telling the operator to stop, wait, and re-run later (or
raise `--delay`, or refresh the session), rather than spinning against X overnight. A successful
non-429 response on a mutation resets that request's own attempt counter; timeline paging tracks
its counter across pages and resets it on the first non-429 response.

This is why a run can appear to sit idle for a while: it is very likely honoring X's rate limit,
not stuck — but it is no longer *unconditionally* patient the way it once was, and will now
surface an explicit error instead of waiting forever if X keeps refusing the same request.

**`waitWithProgress`** is what keeps a long wait from looking exactly like a hang: a plain
`sleep(ms)` is fine for a short wait, but a 20-minute one, watched from a silent terminal on an
unattended overnight run, is indistinguishable from the process having died. Any wait longer than
`PROGRESS_INTERVAL_MS + 30s` (roughly a minute and a half) is instead broken into ~60-second
sleeps, and after each one — as long as more than a second of the wait remains — logs `Still
waiting out the rate limit - about N minute(s) left before the next attempt`. That heartbeat is the
only signal that separates "still rate limited" from "something broke silently".

## 6. Resumable state (`src/state.js`)

`.nuke-state.json` holds three arrays — `done` (deleted), `gone` (already gone when checked), and
`failed` — plus `startedAt`/`updatedAt` timestamps. `done` and `gone` are merged into one
in-memory `Set` (`handled`) that both `nuke` and `sweep` consult via `isHandled(id)` before ever
calling the API for that id again.

`failed` is keyed by tweet id internally (a `Map`, serialized back to an array on save), not
appended to: `markFailed(id, ...)` overwrites any previous entry for that id, and `markDeleted`/
`markGone` remove it from the map entirely. The same tweet can fail round after round without
piling up duplicate entries, and once it finally succeeds it disappears from `failed` for good —
so `state.counts().failed` (what `status` prints) is always the count of ids that are *currently*
failing, not a lifetime tally of every failure the run has ever hit.

Writes are throttled to once every 5 seconds during a run (`saveThrottled`) and forced on
completion or on error (`finally { state.save() }` in both commands), and each save is atomic —
written to `<file>.tmp` then renamed over the real file — so a hard kill mid-write can't corrupt
the state a resumed run depends on.

If the existing state file fails to parse, it's renamed aside as `<file>.corrupt-<timestamp>` and a
fresh empty state is started rather than blocking the run — but not silently. Two `logger.warn`
calls fire: one names the exact backup file the unreadable original was moved to and states plainly
that this run starts from **zero** recorded progress, the other spells out the practical
consequence (every already-deleted id gets attempted again, which X answers with "not found" and
this tool records as `gone`, harmlessly). The point of making this loud rather than quiet is that
somebody resuming a run of several thousand tweets deserves to know *before* the run spends all
night re-discovering that, not after.

**Saves are also tolerant of failure, not just of corruption on load.** `save()` never throws: a
transient write failure (antivirus or a sync client holding the file for a moment — a normal event
on the platforms this tool runs on) is caught, warned about, and left for the next `saveThrottled`
call to retry — deletions keep happening even though the most recent one couldn't be recorded yet.
What it does *not* do is retry silently forever: `saveThrottled` counts consecutive failures, and
once that count reaches `MAX_CONSECUTIVE_SAVE_FAILURES` (5), it throws a `UserError` and the run
stops *before* deleting anything else. The reasoning is asymmetric on purpose — a single locked
file must not kill an hours-long run, but a disk that's genuinely full or read-only must not be
allowed to let the run keep deleting tweets it has no way to record, because everything deleted
since the last successful save would have to be rediscovered by a full sweep next time.

### The state lock

`loadState(file, { lock: true, logger })` — used by `nuke` and `sweep` whenever they are not a
`--dry-run` — additionally calls `acquireStateLock`, which writes `<file>.lock` containing
`{ pid, host, startedAt }` before the run starts, and refreshes it (`touch()`) on every
`state.save()`. This exists because two runs sharing one data directory (`nuke` in one terminal,
`sweep` in another, both pointed at the same `--data-dir`) each hold the whole state in memory
independently; whichever saves last silently erases the other's progress, and thousands of
already-deleted ids get retried. `status` and dry runs never take the lock, since they never write
the state file.

A lock is judged stale by two independent checks, either of which is sufficient:

- **Silence, on any platform, including this one.** A lock that has gone more than `LOCK_STALE_MS`
  (90 minutes) without a `touch()` is stale regardless of hostname or pid. This is the backstop,
  and it applies even to a lock recorded as belonging to a pid that is technically still alive on
  this machine — because operating systems recycle process ids, especially on Windows and inside
  containers, and a live pid alone was found to pin a lock forever for a run that had actually been
  gone for days. 90 minutes is chosen to comfortably clear the longest silence a genuinely live run
  can have: sitting through the full escalating rate-limit backoff (`MAX_RATE_LIMIT_ATTEMPTS`, 8
  attempts) is roughly 75 minutes without writing anything.
- **A dead pid, on this host specifically, is stale immediately** — no need to wait out the 90
  minutes after an ordinary crash or a hard kill. `process.kill(pid, 0)` settles this
  (`EPERM` — the pid exists but belongs to another user — still counts as alive); it's only ever
  checked for a lock recorded on this same hostname, since a pid from another machine can't be
  probed at all.

You only need to intervene by hand — delete the `.lock` file, or point at a separate `--data-dir`
— if you're certain no other run is using that data directory and the lock is still refused inside
that 90-minute window.

### Interrupt handling

`loadState` installs real handlers for `SIGINT`, `SIGTERM`, `SIGHUP`, and `SIGBREAK` the first time
any run opens the state for writing (`installInterruptHandlers`, once per process — `run` opens the
state twice, for the archive pass and then the sweep, and a second listener set per state object
would trip Node's max-listeners warning; a module-level `signalOwner` variable tracks which state
object is "current" and is the one an interrupt actually flushes).

This replaced relying on `process.on("exit")` alone, which turned out not to be enough: on Windows,
Ctrl-C terminates the process without running `'exit'` handlers at all, so the lock file was left
behind and nothing was flushed — and even on platforms where `'exit'` does fire, it has to run
synchronously, so the `finally { state.save() }` inside an `async` delete loop never gets a turn
before the process is gone. A real signal handler runs synchronously *before* exit and can await
nothing extra, which is exactly the "flush, then leave" shape needed.

On any of those four signals, `handleInterrupt` does exactly two things before calling
`process.exit()` with the conventional `128 + signal` code: `state.save()`, then (if this state
object holds the lock) `lock.release()`. A second signal arriving while the first is still handling
is ignored (an `interrupted` flag), so Ctrl-C twice in a row can't re-enter the flush.

The guarantee that produces, stated exactly and no stronger: **on Ctrl-C, SIGTERM, SIGHUP, or
Ctrl-Break, every tweet id already resolved by this run is written to disk before the process
exits.** At most the single deletion that was in flight at that exact moment is unrecorded, and
that one is harmless — X reports an already-deleted tweet as "not found" the next time it's tried,
which this tool records as `gone`. Only a kill the process cannot intercept at all — `SIGKILL`, an
out-of-memory kill, a power loss — falls back to whatever the last throttled save captured, which
is at most `SAVE_INTERVAL_MS` (5 seconds) of deletions behind.

## 7. `verify`, and the bug it was rewritten to fix

The point of `verify` is to check the deletion through a second, independent surface: a deleter
counting its own reported successes is not proof of an empty account, but a real profile page,
read the way a human would read it, is closer to one. The first version of `verify` did that by
opening the persistent `login` browser profile and counting rendered post links — and it had a
serious blind spot, found by testing it against a real account: **X serves a signed-out browser
completely empty timelines**, for a brand-new account and one with thousands of live tweets alike.
A `verify` run whose browser profile wasn't actually signed in (or wasn't signed in as the right
account) rendered zero post cards on Posts, Replies and Media either way, and the old logic read
"zero cards" as "clean" — meaning it could, and once did in testing, report a full, untouched
account as CLEAN. The current version exists specifically to close that hole, in two ways:

**It authenticates itself, rather than trusting a browser profile to already be authenticated.**
`verify` always runs through `createRunContext`, so it needs the same `.x-session-data.json` that
`nuke` and `sweep` use — even when you pass `--handle` yourself — and it makes one
`fetchOwnHandle()` call before opening a browser at all (a cheap way to fail fast on an expired
session, and a fallback source for the handle). It then launches a **fresh, non-persistent**
Chromium (`chromium.launch()`, not `launchPersistentContext`) and injects the session's cookies
into a new context (`sessionCookies()` splits the saved `cookieHeader` back into individual
`{name, value, domain, path, secure}` cookies for both `.x.com` and `.twitter.com`, since X still
honours the legacy domain on some routes). This means `verify` never touches
`.chrome-user-data/` — that directory, and any lock file inside it, belongs to `login` alone now —
and it means `verify` is authenticated as *exactly* the account the deleter itself acts as, not
as whatever the browser profile happened to be signed into. Before measuring anything,
`requireSignedIn` loads `https://x.com/home` and polls (up to 6 times, 2.5s apart) for a
signed-in marker in the page (`SideNav_AccountSwitcher_Button` and similar `data-testid`s); if a
login wall (`loginButton`/`signupButton`/a login link) shows up instead, or the poll simply times
out, `verify` throws a `UserError` pointing at `login` and produces no verdict at all — not CLEAN,
not NOT CLEAN.

**It requires positive proof a timeline is empty, not merely the absence of cards.** Each tab is
read in-page by `readPage(name)` (injected via `page.evaluate`, so it has to be a
self-contained function with no closures), which returns:

- `signedIn` / `loginWall` — checked again on every tab, since X can drop a session mid-run.
- `ownStatusLinks` / `repostedStatusLinks` — counts of `<a href*="/status/">` links found inside a
  rendered `<article>` (links elsewhere on the page — nav, "who to follow", trends — say nothing
  about this profile and are ignored), split by whether the link's handle matches the profile
  being checked. A **repost** renders its card linking to the *original* author's status, not the
  reposting account's, so `repostedStatusLinks` exists specifically so a timeline full of reposts
  can't be miscounted as empty.
- `articles` — total rendered `<article>` count, a blunt fallback: any card at all counts against
  a CLEAN verdict, even one neither of the two link counts recognized.
- `emptyStateMarker` — whether X's own explicit "nothing here" element is present
  (`[data-testid="empty_state_header_text"]` or `[data-testid="emptyState"]`), found anywhere in
  the profile's main column. This carries a stable test id, so it survives wording changes and
  translation in a way matching text never would.
- `timelineRendered` / `timelineArticles` — whether the profile's own timeline region
  (`[aria-label^="Timeline"]`, found specifically inside the primary column so the sidebar's
  unrelated "Timeline: Trending now" region can't be mistaken for it) is present, and how many
  articles are inside it. The Posts tab in particular renders no empty-state message for the
  account's own owner — X just renders that region with nothing inside it — so `timelineRendered
  && timelineArticles === 0` is its own, separate proof of empty.
- `text` — up to 2000 characters of the column's own text (falling back to `document.body`),
  used only as a last resort against three wording patterns, checked in this order:
  `UNAVAILABLE_STATE` (`/account is suspended|account suspended|these posts are protected|owner
  limits who can view|doesn.t exist|does not exist/i` — X refusing to show this profile at all),
  then, for a genuinely empty timeline, `EMPTY_STATE` (`/hasn.t posted|haven.t posted|hasn.t
  replied|haven.t replied|hasn.t highlighted|haven.t highlighted|no posts yet|nothing to see
  here/i`, for when neither structural signal above fired), and `LOAD_FAILURE`
  (`/something went wrong|try again|retry/i`).

That per-tab judgement lives in one exported pure function, `classifyTab(info, {loadFailed})`,
rather than inline in the browser-driving loop — it is the single most consequential decision in
the tool, so it is unit-testable without a browser (see `test/verify.test.js`). It returns one of
four outcomes, and the order below is also the order they're checked in, because content that
rendered has to outrank every other signal — a half-loaded page that still shows a post is
`stillThere`, not `unconfirmed`, and a page that renders content *and* an "unavailable" message
(shouldn't happen, but if X's markup ever did both) is still `stillThere`:

1. **`stillThere`** — any status link or bare `<article>` rendered at all. Checked first,
   unconditionally.
2. **`unavailable`** — nothing rendered, but the page matches `UNAVAILABLE_STATE`: X is refusing to
   show this profile (suspended, protected and not followed, or nonexistent) rather than showing an
   empty one. This used to sit inside `EMPTY_STATE` — meaning a suspended account, which still
   holds every post it ever made and is merely hidden from view, could be reported `CLEAN` purely
   because the rendered page happened to say "account is suspended". `unavailable` exists
   specifically so that can never happen: it can never resolve to `confirmedEmpty`, because hidden
   is not the same claim as empty.
3. **`confirmedEmpty`** — nothing rendered, no `unavailable` match, and the page is **not** a
   `LOAD_FAILURE` page, and at least one of `emptyStateMarker`, `timelineRendered &&
   timelineArticles === 0`, or the `EMPTY_STATE` text pattern is true. An explicit "Something went
   wrong" page is never accepted as evidence either way, in either direction.
4. **`unconfirmed`** — everything else: zero cards, no `unavailable` match, but none of the three
   positive empty-state signals fired either (X restructured the page, an unrecognized wording, or
   the page genuinely failed to load).

`verify` also optionally loads specific tweet ids directly (`https://x.com/i/status/<id>`) and
checks for either zero `<article>` elements or a match against `MISSING_POST`, same idea at
single-tweet scale.

One legitimate empty state worth calling out, because it looks like it should be a problem and
isn't: on an account without an X Premium subscription, the Highlights tab shows a "Highlight on
your profile / You must be subscribed to Premium to highlight posts on your profile" notice
instead of a timeline. There is no Premium or "subscribe" wording anywhere in `EMPTY_STATE`, and
no `/highlights` special case in the code — none is needed. X renders that notice inside its own
`[data-testid="emptyState"]` container (with `empty_state_header_text` and
`empty_state_button_text` inside it), which is exactly the structural marker `emptyStateMarker`
looks for. So the tab resolves to `confirmedEmpty` on the strongest signal available, not on a
text match, and a genuinely clean non-Premium account is not pushed into `COULD NOT CONFIRM` by
it. Verified against a live non-Premium profile: `emptyStateMarker: true`, `articles: 0`,
`timelineRendered: false`.

For the same reason the Posts tab behaves differently from the others, and it is worth knowing
which signal each one actually fires. Measured on a real signed-in, emptied profile: **Posts**
renders no empty-state element at all — it renders the timeline region (`aria-label="Timeline:
<name>'s posts"`) with zero articles inside it, so `timelineRendered && timelineArticles === 0`
is the only thing that proves it. **Replies** and **Media** render `emptyState` *and* matching
wording ("You haven't replied yet", "You haven't posted videos yet"). **Highlights** and
**Reposts** render `emptyState` with no wording `EMPTY_STATE` matches. All five resolve to
`confirmedEmpty`, by three different routes — which is why all three signals are kept. `login`
visits these same five tabs, in the same order, to capture the timeline requests `sweep` pages
through — see [`PROFILE_TABS`](#1-session-capture-login-srcsessionjs) — and `verify` deliberately
checks the identical list rather than one of its own, imported from `src/session.js`; a tab
`verify` checked but `login` never visited would be an unfalsifiable `NOT CLEAN` forever.

The four tab-level outcomes roll up into four run-level verdicts, checked and reported in this
order (the same order `classifyTab` itself checks in):

| Verdict | Condition | Exit code |
|---|---|---|
| `NOT CLEAN` | at least one tab (or checked id) is `stillThere` | `1` |
| `COULD NOT CHECK` | no tab is `stillThere`, but at least one is `unavailable` (X refused to show that profile — suspended, protected, or nonexistent) | `1` |
| `COULD NOT CONFIRM` | no tab is `stillThere` or `unavailable`, but at least one is `unconfirmed` | `1` |
| `CLEAN` | every tab is `confirmedEmpty` and every checked id is gone | `0` |

`stillThere` always wins over everything else — a tab that unambiguously has content on it makes
the whole run `NOT CLEAN` even if another tab was suspended or unconfirmed. `unavailable` in turn
wins over `unconfirmed`: a profile X is actively refusing to show is a stronger, more specific
signal that something is wrong than a page that simply rendered nothing recognizable. Neither
`COULD NOT CHECK` nor `COULD NOT CONFIRM` can ever become `CLEAN` — see
[Exit codes](CLI.md#exit-codes) in the CLI reference.
