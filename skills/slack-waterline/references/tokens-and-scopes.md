# Tokens and scopes

## Which token

| | `SLACK_USER_TOKEN` (`xoxp-`) | `SLACK_BOT_TOKEN` (`xoxb-`) |
|---|---|---|
| Public channels | all you can see, **without joining** | only ones it has joined |
| Private channels | every one you are in | only where it was `/invite`d |
| **DMs** | **all of yours** | **never** |
| **Group DMs** | **all of yours** | **never** |
| Threads, pins, bookmarks, files | yes | yes |
| Posting | as **you** | as the app |

The user token wins whenever both are present, because for reading it is a
strict superset. The bot token stays a fallback so a workspace that only has one
keeps working.

**A bot can only see DMs sent to the bot.** For a personal catch-up tool that
makes a bot token close to useless on its own: it cannot see your conversation
with your CEO at all. If a run reports far less than you expect, check the
identity banner the scripts print on stderr.

The bot token has exactly one job here it does better: `conversations.join`.
Joining a public channel on a *user* token makes **you** join, which posts a
visible "has joined the channel" line into the room.

## Minting a user token

1. <https://api.slack.com/apps> → **Create New App** → *From scratch*.
2. **OAuth & Permissions** → **User Token Scopes** (not Bot Token Scopes).
3. Add the scopes below.
4. **Install to Workspace** at the top of the same page.
5. Copy the **User OAuth Token** — it starts `xoxp-`.
6. Put it in the workspace's `.env` as `SLACK_USER_TOKEN=xoxp-…`.

### Read scopes

```
channels:history   public channel messages
channels:read      public channel metadata
groups:history     private channel messages
groups:read        private channel metadata
im:history         your DMs
im:read            your DM list
mpim:history       your group DMs
mpim:read          your group DM list
users:read         resolve user IDs to names
files:read         download attachments
pins:read          pinned messages
bookmarks:read     channel bookmarks
```

### Write scopes — only if you want them

```
chat:write         post and edit as you (digest DM, replies)
im:write           open a DM conversation, including with yourself
```

Without `chat:write` the skill is read-only by construction, which is a
defensible way to run it. `report.mjs` still writes its digest to a file; it
just cannot DM it to you.

## Scope changes need a reinstall

Adding a scope does nothing until you **reinstall the app to the workspace**.
A token minted before the change carries the old scopes, so the symptom is a
`missing_scope` error on a scope the app config clearly lists.

## Reading the errors

| error | what it actually means |
|---|---|
| `invalid_auth` | wrong env var name, wrong token, or revoked. Reads exactly like a revoked token when the variable is misspelled — it is `SLACK_USER_TOKEN`, not `SLACK_TOKEN` |
| `not_authed` | no token was sent at all |
| `missing_scope` | add the scope **and reinstall** |
| `not_in_channel` | a private channel; a human has to `/invite` you |
| `channel_not_found` | wrong ID, or a conversation this token cannot see. Some app DMs report this permanently; it is per-row, not fatal |
| `ratelimited` | handled automatically with bounded backoff |
| **HTTP 200 with an HTML body** | on a file download this is an auth failure wearing a success code — see below |

## The HTTP 200 trap

Slack serves files from a CDN host, not the Web API. When auth fails there, you
do not get `missing_scope` or even an error status — you get **HTTP 200 carrying
a login page**. A naive downloader writes that HTML to disk under a `.pdf` name
and reports success, and the failure surfaces much later somewhere unrelated.

`download-file.mjs` checks the content type and refuses. Google does the same
thing with sheets, and `fetch-sheet.mjs` refuses the same way.

## Rate limits

Slack tiers its methods. The ones that matter here:

- `users.list` — **Tier 2, ~20/min**. This is why the user directory is cached
  on disk (`.cache/users.json`, TTL `SLACK_USERS_CACHE_TTL_MIN`, default 360
  minutes). Without the cache, a hundred-conversation run walked the whole
  workspace a hundred times and competed for the same budget as the real work.
- `conversations.history` / `.replies` — Tier 3, ~50/min.
- `conversations.list` — Tier 2.

Retries are bounded: HTTP 429 **and** `{"ok":false,"error":"ratelimited"}` are
both handled, since Slack uses both and handling only one looks like a working
tool right up until load arrives.

Set `SLACK_USERS_CACHE_TTL_MIN=0` to force a directory refresh.

## Keeping the token safe

- It lives in the **workspace data directory's** `.env`, which `init.mjs`
  gitignores. Never in the skill repo, never in the registry.
- The registry at `~/.slack-waterline/config.json` holds paths only.
- The SDK-style debug logging that dumps full response bodies is deliberately
  absent: on a token that can read your DMs, that is private conversation
  written to a log file.
- A user token can post as you. Treat it like a password, and revoke it at
  <https://api.slack.com/apps> if it leaks.
