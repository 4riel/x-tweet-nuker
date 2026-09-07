# Security Policy

This is a single-maintainer, unpublished (not on npm) hobby-scale CLI. There is no security team
and no SLA — reports are handled best-effort, when the maintainer has time. That said, real
reports are welcome and taken seriously.

If what you have is "the tool stopped working" rather than a security issue, that's not this file
— open a [bug report](.github/ISSUE_TEMPLATE/bug_report.yml) instead. The most common cause by far
is X renaming or rotating a GraphQL operation id; the template collects what's needed to diagnose
that.

## The real threat model: your session file

This tool doesn't have a server, a database, or user accounts of its own. The one asset worth
protecting is the file `login` writes — by default `.x-session-data.json` in the working
directory (configurable via `--session` / `SESSION_FILE`, see [docs/CLI.md](docs/CLI.md)).

That file contains:

- Your full X cookie header, including `auth_token` — the cookie that keeps you signed in.
- Your CSRF token (`ct0`).
- Your numeric X user id and handle.
- The GraphQL query ids and timeline URLs the tool scraped from your browser session.

**This is equivalent to your live login.** Anyone who obtains it can act as your X account —
read, post, delete, follow, DM — without ever knowing your password, exactly as if they'd stolen a
session cookie. It is not a low-severity secret; treat it the way you'd treat a password manager
export.

What it is *not*: the `authorization: Bearer …` header the tool sends alongside the cookie is a
public constant baked into X's own web client and shared by every browser session on the planet.
It authenticates nothing by itself and leaking it is not a concern — see
[docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md#2-the-graphql-request-shape-srcclientjs) for the exact
request shape.

### How it's protected today

- The session file never leaves your machine. The only network calls the tool makes are to
  `x.com`; nothing is telemetered, logged remotely, or sent anywhere else.
- It's written with `chmod 600` on platforms that honor POSIX file modes (a no-op on Windows,
  where the `.gitignore` entry below is the real protection).
- It, `.env`, `.nuke-state.json`, `.x-session-data.json`, and the Playwright browser profile
  directory (`.chrome-user-data/`) are all listed in [`.gitignore`](.gitignore). If you fork or
  copy this project, keep those entries and double-check before committing.

### If it leaks

Act as if your password leaked, because functionally it did:

1. Go to **x.com → Settings → Security and account access → Sessions** and log out every session
   you don't recognize (or all of them, to be safe).
2. Consider rotating your X password too — revoking sessions ends the immediate access, but a
   password change is the more durable fix if you're not sure how the file got out.
3. Delete the local copy and run `x-tweet-nuker login` again to capture a fresh one.

### If you find a real vulnerability

Something that would let a session file leak unintentionally (e.g. it ending up somewhere it
shouldn't, being written world-readable in a case the code doesn't already account for, a
dependency issue, or anything else with an actual exploit path) — please **do not open a public
issue**. Use GitHub's private reporting instead:

**[Report a vulnerability](https://github.com/4riel/x-tweet-nuker/security/advisories/new)**
(repo → Security tab → "Report a vulnerability"). This reaches the maintainer directly without
disclosing details publicly while a fix is worked out.

If private reporting isn't enabled or isn't working for you, open a regular issue that says only
"security issue, please contact me" with no details, and a way to reach you.

## Supported versions

This project has no release/version track — it isn't published to npm, and there's one moving
target: the latest commit on `main`. That's the only thing that gets security fixes.

## Scope notes

- **Not a vulnerability:** X changing or rotating GraphQL operation ids, query ids, or timeline
  endpoints. This breaks the tool's *function*, not its security, and is the expected, documented
  failure mode of riding an undocumented API — see the
  [troubleshooting section](docs/CLI.md#troubleshooting) and the bug report template.
- **Not a vulnerability:** the fact that this tool uses X's internal, undocumented GraphQL API at
  all, or that doing so likely violates X's Terms of Service. That's a legal/ToS risk the user
  accepts by running the tool (see the [README](README.md#legal)), not a security bug in this
  code.
- **In scope:** anything that could cause the session file (or `.env`, or any other credential-
  bearing local file) to be exposed, written somewhere unexpected, sent somewhere other than
  `x.com`, or otherwise mishandled by the code in this repository.
