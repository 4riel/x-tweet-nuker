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

## 1. Session capture (`login`, `src/session.js`)

`login` launches a persistent Playwright Chromium context rooted at `.chrome-user-data/` (so a
second `login` reuses the same signed-in profile), then:

1. Navigates to `https://x.com/home` and polls `context.cookies()` every 3 seconds until both
   `auth_token` and `ct0` cookies are present, prompting the user to sign in if they aren't. In
   headless mode with no existing session this fails fast instead of hanging silently.
2. Once signed in, builds the cookie header by joining every cookie as `name=value; ...`, and
   reads the account's numeric id out of the `twid` cookie (`u=<id>`, URL-decoded).
3. Detects the handle from the app's own nav bar (`a[data-testid="AppTabBar_Profile_Link"]`'s
   `href`), unless `--handle` was given.
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
id, and the count of pages that came back `failed` is tracked alongside it.

**Why rounds, not one pass**: deletion on X is eventually consistent — a tweet can still be served
by a timeline for a while after a successful delete. A single empty-looking harvest proves
nothing about the tens of tweets that were server-side "deleted" moments earlier but haven't
dropped out of the timeline cache yet. So `sweep` repeats the harvest-and-delete cycle, up to
`maxRounds` (default 30, minimum 1, `--max-rounds`) times, and only declares success when one full round's
harvest returns zero items **and zero failed pages** across every timeline. A round that found
nothing only because requests were failing is explicitly *not* treated as clean — it's logged as
inconclusive and retried after a short pause, since a tool that can silently report "CLEAN" after
merely failing to look is worse than one that keeps trying. If it runs out of rounds without a
genuinely clean pass, it says so and suggests running `sweep` again after a short wait, since the
state it needs (`.nuke-state.json`) already reflects everything actually deleted.

Within a round, each item that has a `retweetOf` gets `unretweet(retweetOf)` before
`deleteTweet(item.id)`; both count independently in the round's summary.

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
the state a resumed run depends on. If the existing state file fails to parse, it's renamed aside
as `<file>.corrupt-<timestamp>` and a fresh empty state is started rather than blocking the run;
the worst consequence of losing state is re-issuing some deletes, which X reports back as
"already gone" harmlessly.

### The state lock

`loadState(file, { lock: true, logger })` — used by `nuke` and `sweep` whenever they are not a
`--dry-run` — additionally calls `acquireStateLock`, which writes `<file>.lock` containing
`{ pid, host, startedAt }` before the run starts, and refreshes it (`touch()`) on every
`state.save()`. This exists because two runs sharing one data directory (`nuke` in one terminal,
`sweep` in another, both pointed at the same `--data-dir`) each hold the whole state in memory
independently; whichever saves last silently erases the other's progress, and thousands of
already-deleted ids get retried. `status` and dry runs never take the lock, since they never write
the state file.

Staleness is judged differently depending on where the existing lock came from:

- **Same hostname**: settled by `process.kill(pid, 0)` — if that process is still alive (or exists
  but under another user, which reports `EPERM`, still counted as alive), the lock holds no matter
  how long it's been quiet, because a real run can sit inside an hour of escalating rate-limit
  waits without writing anything. If the pid is gone, the lock is stale and gets taken over
  immediately, with a warning logged.
- **A different hostname** (a data directory shared over a network drive) can't be probed by pid,
  so it falls back to elapsed time since `touchedAt`/`startedAt`: stale after `LOCK_STALE_MS`, 90
  minutes.

The lock is released (`fs.unlinkSync`) on `process.on("exit")`, so a normal exit or Ctrl-C cleans
it up on its own; it is never released if the process is killed outright (`SIGKILL`, an OOM
killer), which is exactly the case the pid-liveness check above is designed to recover from
automatically on the next run.

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
  used only as a last resort against two wording patterns: `EMPTY_STATE` (a list of phrasings —
  "hasn't posted", "no posts yet", "these posts are protected", etc. — for when neither structural
  signal above fired) and `LOAD_FAILURE` (`/something went wrong|try again|retry/i`).

That per-tab judgement lives in one exported pure function, `classifyTab(info, {loadFailed})`,
rather than inline in the browser-driving loop — it is the single most consequential decision in
the tool, so it is unit-testable without a browser (see `test/verify.test.js`). It returns
`stillThere` if any status link or article rendered, `confirmedEmpty` if it is zero cards **and**
proven empty, or `unconfirmed` otherwise. A tab's zero-cards result counts as proven empty only
when the page is **not** a `LOAD_FAILURE` page *and* at least one of `emptyStateMarker`,
`timelineRendered && timelineArticles === 0`, or the `EMPTY_STATE` text pattern is true — an
explicit "Something went wrong" page is never accepted as evidence either way, and zero cards
with no positive signal at all (X restructured the page, an unrecognized wording) is
`unconfirmed`, never clean. Content that did render still wins over a load failure: a page that
half-loaded but showed a post is `stillThere`, not `unconfirmed`. `verify` also optionally loads
specific tweet ids directly
(`https://x.com/i/status/<id>`) and checks for either zero `<article>` elements or a match against
`MISSING_POST`, same idea at single-tweet scale.

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
`confirmedEmpty`, by three different routes — which is why all three signals are kept.

The three tab-level outcomes roll up into three run-level verdicts:

| Verdict | Condition | Exit code |
|---|---|---|
| `NOT CLEAN` | at least one tab (or checked id) is `stillThere` | `1` |
| `COULD NOT CONFIRM` | no tab is `stillThere`, but at least one is `unconfirmed` | `1` |
| `CLEAN` | every tab is `confirmedEmpty` and every checked id is gone | `0` |

`stillThere` always wins over `unconfirmed` — a tab that unambiguously has content on it makes
the whole run NOT CLEAN even if another tab merely couldn't be confirmed. See
[Exit codes](CLI.md#exit-codes) in the CLI reference.
