# Contributing

This is a small, single-purpose CLI. Contributions that keep it small are the most welcome kind.

## Setup

```bash
git clone https://github.com/4riel/x-tweet-nuker.git
cd x-tweet-nuker
npm install
npx playwright install chromium
```

There is no build step — it's a CommonJS Node script (`bin/cli.js` plus `src/`). Run it directly:

```bash
node bin/cli.js --help
```

The package is not on npm, so `npx x-tweet-nuker` will not work. If you want the bare
`x-tweet-nuker` name (the one the tool's own messages use), run `npm link` in the clone.

There is a test suite, and it is fast and offline:

```bash
npm test        # node --test test/*.test.js
```

## Where things live

| File | Responsibility |
|---|---|
| `bin/cli.js` | argument parsing, command dispatch, top-level error handling |
| `src/config.js` | resolves flags / env / `.env` / defaults into one config object |
| `src/session.js` | browser-based login, cookie + queryId + timeline-URL capture |
| `src/client.js` | the browser-free GraphQL client (delete, unretweet, timeline paging) |
| `src/archive.js` | parses `tweets.js` from an X data archive |
| `src/state.js` | resumable run state (`.nuke-state.json`) and its advisory `.lock` file |
| `src/confirm.js` | the type-your-handle confirmation gate |
| `src/context.js` | shared setup (logger, session, client) for the commands that talk to X |
| `src/logger.js` | timestamped console + file logging |
| `src/errors.js` | `UserError` / `SessionExpiredError` and their exit codes |
| `src/commands/verify.js` | independent browser-based proof the account is empty (see below) |
| `src/commands/*.js` | one file per CLI command |
| `test/*.test.js` | the suite; `test/helpers/` holds the fetch/DOM/tmp-dir stand-ins |

Read [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md) before touching `session.js`, `client.js` or
`verify.js` — it documents the exact request/response shapes and DOM signals those files depend
on. `verify.js` deserves particular care: it was already rewritten once after testing found it
could report a full, untouched account as CLEAN (X serves a signed-out browser completely empty
timelines, so an insufficiently authenticated or insufficiently strict check reads exactly like an
empty account). Any change to its empty-state detection needs to be checked against both a
genuinely empty profile and one with real posts still on it — matching "zero rendered cards" is
not enough on its own; see `docs/HOW-IT-WORKS.md` for what counts as actual proof.

## The most useful contribution

X periodically rotates GraphQL `queryId` values and renames its timeline operation names (it has
already done this once — see `KNOWN_TIMELINE_OPS` and `FALLBACK_QUERY_IDS` in `src/session.js`).
When that happens again, this tool breaks for everyone until someone updates those constants. If
you hit this:

1. Run `x-tweet-nuker login --verbose` and check the warning output (or the session file's
   `graphqlOperationsSeen` field) for the operation names your browser actually requested.
2. Add the new timeline operation name(s) to `KNOWN_TIMELINE_OPS` in `src/session.js`.
3. If `DeleteTweet` or `UnretweetTweet` also changed, the scraper in `scrapeQueryIds` should pick
   up the new `queryId` automatically on the next `login` — but check whether `FALLBACK_QUERY_IDS`
   (the last-resort default) also deserves an update.
4. Open a PR describing what changed and how you found it.

## Testing a change

`npm test` runs the whole suite with Node's built-in test runner — no framework, no network, no
browser, no real X account, and nothing written outside `os.tmpdir()`. It covers argument parsing
and help/parser agreement (`test/cli.test.js`), configuration precedence and numeric validation
(`test/config.test.js`), archive parsing (`test/archive.test.js`), the run-state file and its lock
(`test/state.test.js`), the GraphQL client's success/gone/error/rate-limit handling against canned
responses (`test/client.test.js`, via `test/helpers/fake-fetch.js`), and `verify`'s page reader and
per-tab verdict against a scripted DOM (`test/verify.test.js`, via `test/helpers/fake-dom.js`).
Add tests with a change; the suite is expected to stay green and to grow.

What the suite **cannot** cover is x.com's real behaviour: whether a selector still matches, an
operation is still named the same, or a response still has the shape the client expects. So
changes to `src/client.js`, `src/session.js` or `src/commands/verify.js` still need to be checked
against a real account. Use a disposable/test X account if you can, and always start with
`--dry-run` before letting a change near a real account's tweets.

## Guidelines

- Keep the dependency list as it is (Playwright only) unless there's a strong reason to add one.
- Match the existing style: CommonJS, small focused files, JSDoc block comments explaining *why*
  rather than *what*.
- Never commit anything under `.gitignore` — session files, `.env`, archives, browser profiles,
  and run-state files all contain personal or credential-equivalent data.
- If a change affects behavior described in `README.md`, `docs/CLI.md` or
  `docs/HOW-IT-WORKS.md`, update those in the same PR. Flags, defaults, exit codes and file names
  are stated in all three plus `--help`; they have to agree.
