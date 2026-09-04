---
name: slack-waterline
description: Read every message in a Slack workspace and prove nothing was missed — then write the daily or weekly digest and, when asked, the reply. Use whenever someone wants to catch up on Slack, be caught up, or stop tracking it by hand — "catch me up on Slack", "what did I miss", "did anyone need me today", "read everything in #eng since Monday", "summarise this week's Slack", "send me my Slack daily report", "check my DMs", "sync workspace X", "am I behind on anything", "draft a reply to that thread". Also for setting up a new Slack workspace to track, auditing whether the read state is honest, reading a Google Sheet somebody linked in a channel, or downloading and reading an attachment. Works across many workspaces from one install; never marks a message read that nobody read.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Slack waterline

Reads a Slack workspace the way a person would if they had the time: every
channel, every DM, every thread reply, the pinned messages, the attachments, and
the Google Sheets people keep linking. Then it records exactly what was read —
and only what was read — so the next run starts where this one stopped.

**The waterline is the line below which nothing can be missed.** Everything in
this skill exists to keep that line honest.

## The one rule

> **A read receipt may only describe what was DELIVERED, never what EXISTS.**

Fetching is not reading. If a payload was built but nobody looked at it, it is
not read, and recording it as read does not lose a message temporarily — it
loses it permanently, because the next run has nothing left to find.

Everything below follows from that.

---

## Setup

```bash
cd skills/slack-waterline/scripts
node init.mjs --workspace acme --dir /path/to/acme-slack-archive
```

That scaffolds the data directory, writes a `.gitignore` that keeps the token
out of git, and registers `acme` so every other command takes just
`--workspace acme`. Then put a token in `<dir>/.env` and re-run `init.mjs` to
verify it.

**One skill, many workspaces.** The registry lives at
`~/.slack-waterline/config.json` and holds paths only. Tokens live in each
workspace's own `.env`. `node init.mjs --list` shows what is registered.

### Tokens

| | `SLACK_USER_TOKEN` (`xoxp-`) | `SLACK_BOT_TOKEN` (`xoxb-`) |
|---|---|---|
| Public channels | all you can see, without joining | only ones it joined |
| Private channels | every one you are in | only where `/invite`d |
| **DMs / group DMs** | **all of yours** | **never** |
| Threads, pins, bookmarks, files | yes | yes |

The user token is preferred whenever present — for reading it is a strict
superset. **A bot token cannot see a single DM**, so for a personal catch-up
tool it is close to useless on its own.

User token scopes: `channels:history channels:read groups:history groups:read
im:history im:read mpim:history mpim:read users:read files:read pins:read
bookmarks:read`. Add `chat:write` **only** for the digest DM and reply sending.

See `references/tokens-and-scopes.md` for minting one.

### Two blind spots that cannot be fixed

State these plainly rather than promising coverage that does not exist:

1. **DMs between two other people.** Needs Slack's Discovery API — Enterprise
   Grid only.
2. **A private channel nobody with a token is in.** A human has to `/invite`
   someone. `conversations.join` rejects private channels outright.

---

## Catching up — the normal path

```bash
node catchup.mjs --workspace acme --unread
```

That runs the triage, fetches everything actionable, renders each conversation,
and prints an index of rendered deltas plus a prepared record batch.

**Then you read them.** `catchup.mjs` deliberately does not record anything.

1. Read each rendered `.md` listed in the index. For a large backlog, fan out
   subagents over batches — each reports findings only and never carries raw
   message text back into the main context.
2. Delete from `tmp/record-batch.json` any entry whose delta you did not open.
3. Record what you read, with a digest while the understanding is fresh:

```bash
node record.mjs --workspace acme --batch tmp/record-batch.json
node record.mjs --workspace acme --from tmp/<id>.json \
  --digest "Sprint scope settled Tuesday. Open: Olga's PR needs review."
```

The digest is the sediment. The watermark stops the next run re-*fetching* old
messages; the digest stops it re-*deriving their meaning*.

4. Prove nothing is hiding:

```bash
node audit.mjs --workspace acme
node coverage.mjs --workspace acme --enumerate-only
```

### Scoping the read

```bash
node catchup.mjs --workspace acme --all              # every conversation
node catchup.mjs --workspace acme --since 7d         # a window
node catchup.mjs --workspace acme --channels general,eng-backend
node catchup.mjs --workspace acme --dms-only
node catchup.mjs --workspace acme --all --full       # first-ever archive pass
```

---

## The layers

**Layer A — `discover.mjs`** scans the whole workspace and prints one row per
conversation, **never message bodies**, so a model learns the shape of the
workspace in one small read. Columns: new count, priority, action.

**Layer B — `fetch.mjs` → `render.mjs`** opens what matters.

Read a payload with `render.mjs`. Never `head`, `tail` or `jq` it — those give
you a prefix of a JSON file, which is not a prefix of the conversation, and they
silently drop thread replies.

`render.mjs` orders its output deliberately: prior digest, then **pinned**
(canonical, always fetched regardless of the watermark), then bookmarks, then
**run sheets and docs**, then the new messages. Documents outrank the chat —
the decision is usually in the spreadsheet, and the channel is people reacting
to it.

---

## Read state — three positions, one writer each

`state.json`, keyed by channel ID because that survives renames.

| field | means | only writer |
|---|---|---|
| `watermarkTs` | **READ** — newest top-level ts delivered to a reader | `record.mjs --from` |
| `scannedTs` | **TRIAGE** — newest ts the triage scored | `discover.mjs`, and only on quiet rows |
| `pendingTs` | **SLACK** — what Slack held on a row the triage could not clear | `discover.mjs` |
| `readAt` | *that* a real payload was delivered | `record.mjs --from` |
| `readAtSource` | a caveat NARROWING that claim | `--read-source` |

If you add a writer: it moves `scannedTs`, **or** it delivers content to a
reader. Never both, never neither.

`references/read-state.md` explains why each exists, and what went unread
before it did. Read it before changing anything in `lib/state.mjs`.

### Threads are where messages hide

**A reply never moves its parent.** A channel whose entire live conversation is
happening inside one older thread looks completely quiet from the top level.
That is why `state.json` stores per-thread `replyCount` + `latestReplyTs`, and
why a row can read `incremental (thread replies)` — checking that conversation
by eye shows nothing new; you have to open the thread.

### The signal gate decides PRIORITY, never whether something is read

Scores sort the table. They never make a row settled. A quiet channel that
finally says something important must not be skipped because it scored 1.

---

## Two gates that fail differently

Run **both**, every time.

```bash
node audit.mjs --workspace acme                      # offline, instant
node coverage.mjs --workspace acme --enumerate-only  # network, seconds
```

> **A gate that iterates the record can only ever confirm the record is
> self-consistent.**

`audit.mjs` walks `state.json` — so a conversation nobody ever enumerated is
invisible to it. Not "clean", invisible. `coverage.mjs --enumerate-only` asks
the other question against `conversations.list` with `exclude_archived: false`,
which is where forgotten channels live.

A backlog is **not** a build failure. These exit with a finding count so a
script can branch; a scheduled run that goes red because somebody posted in
Slack trains everyone to ignore red.

---

## Reports

```bash
node report.mjs --workspace acme --period day
node report.mjs --workspace acme --period week --send
```

Sections: *needs a reply*, *asked you but you already reacted*, *context*, and
**what this digest could not see**. `--send` DMs it to you, chunked and threaded
under the first message if long.

**A report is a view, not a read.** `report.mjs` never touches `state.json`.
Being told about a message in a summary is not the same as having read the
conversation, and conflating the two is how a backlog disappears without anyone
clearing it. The report says so in its own footer.

Scheduling: `assets/schedule-task.ps1` registers a Windows Scheduled Task;
`assets/github-workflow.tmpl` is the cloud equivalent. Any automated run passes
`--no-record` to the triage — **a machine must never advance a read position.**

---

## Writing to Slack

`send.mjs` posts **as you**, not as a bot. Two guardrails that are not optional:

1. **Always `--dry-run` first, and show the user the resolved target and the
   exact text before sending.** Never send on your own initiative.
2. **Slack has no unsend.** Every attempt is logged to `sent.log.jsonl` before
   the API call and again after.

```bash
node send.mjs --workspace acme --to '@Saba' --file draft.md --dry-run
node send.mjs --workspace acme --to '#general' --text '…' --thread 1785…
node send.mjs --workspace acme --to '@me' --text '…'
```

`--update <ts>` edits a message in place and **requires `--reason`**, which goes
in the log; the dry-run prints the current remote text above the replacement so
you see what you are overwriting. An ambiguous `@Name` is refused, never
guessed.

### Drafting a reply

Read the thread first (`fetch.mjs` + `render.mjs`), draft to a file, show the
user, then send. Write drafts into the workspace directory, never into the
skill repo.

---

## Attachments, sheets, documents

```bash
node download-file.mjs F0ABC123 out/deck.pdf --workspace acme
node extract-docx.mjs out/bio.docx
node fetch-sheet.mjs 'https://docs.google.com/spreadsheets/d/…' --workspace acme
```

> **A gid in a link is not a scope.**

The `#gid=` fragment records which tab somebody's browser happened to be showing
when they copied the URL. `fetch-sheet.mjs` reads **every** tab and merely sorts
the linked one first. Narrow with `--tab` deliberately, never by accident.

Both `download-file.mjs` and `fetch-sheet.mjs` refuse loudly when the response
is an HTML page rather than data — Slack and Google both return login and error
pages with **HTTP 200**, so a naive reader writes a login page to disk under a
`.pdf` name and calls it a success.

---

## Archiving

```bash
node fetch.mjs --workspace acme --many ids.txt --out-dir raw/ --skip-existing
node archive.mjs --workspace acme
```

Markdown, not JSON — a person grepping for who agreed to what should not have to
parse anything. Mechanical messages are dropped **and counted**. `conversations/`
is wiped and rebuilt every run, because a rename or a new calendar year strands
an orphan file and grep then finds both copies with nothing to say which is
current.

`--skip-existing` is resumability and it is a trap on a *stale* list: every stale
payload is already complete, so the flag makes that run a total no-op. Use it for
the "new conversations" pass only.

---

## Conventions for anything you add here

- **Stdout is the payload; diagnostics go to stderr.** `fetch.mjs` writes JSON to
  stdout. A logger sharing that channel is a bug waiting for load.
- **`--out`, never `>`.** A shell redirect truncates the target *before* the
  script runs, so a failed fetch destroys the payload it was replacing.
- **Atomic writes.** Temp file, then rename. A half-written manifest claims
  things were read.
- **Prose goes through files.** `--digest-file`, `--reason-file`, `--batch`:
  PowerShell doubles a quote where bash does not, and a file has no quoting
  rules at all.
- **Refuse ambiguity.** Reading the wrong person's DM is not recoverable.

## What this skill does not do

- Post anything on its own initiative. Every write is shown first.
- Advance a read position for content nobody read.
- Mark a conversation settled because it scored low.
- Claim coverage of the two blind spots above.
- Copy secrets. Never move a credential, access code or private invite link out
  of Slack into a repo, a report, or a commit message — say a credential is
  there, never what it is.

## Failure modes

| symptom | cause |
|---|---|
| `invalid_auth` | the env var is `SLACK_USER_TOKEN`, not `SLACK_TOKEN`; or the token was revoked |
| `missing_scope` | add the scope **and reinstall the app** — scopes do not apply until reinstall |
| `not_in_channel` | private channel; a human must `/invite` you |
| `channel_not_found` on a DM | some app DMs are not readable; reported per row, not fatal |
| triage says a channel is quiet but you saw a message | it was a thread reply; look for `(thread replies)`, or re-fetch with `--full` |
| a payload will not parse | something wrote diagnostics to stdout — refetch with `--out` |
| digest says 0 need you, inbox disagrees | check the identity banner on stderr: a bot token sees no DMs |
