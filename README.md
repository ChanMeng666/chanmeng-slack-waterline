<!-- AGENT-FIRST NOTICE -->
> [!IMPORTANT]
> ### 🤖 Read this with your AI agent — don't read it by hand.
> This repo is written agent-first. Point Claude Code, GitHub Copilot, Cursor, or any agent at it:
> *"Read the README and SKILL.md, then install and use this skill."*
<!-- /AGENT-FIRST NOTICE -->

<div align="center">

# chanmeng-slack-waterline

**Read every message in a Slack workspace — and prove nothing was missed.**

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code/skills) skill that catches you up on Slack, DMs you a daily or weekly digest, and drafts the reply. Works across every workspace you join, from one install.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
[![Claude Code Skill](https://img.shields.io/badge/Claude%20Code-Skill-d97757?style=flat-square)](https://docs.anthropic.com/en/docs/claude-code/skills)
[![Node.js](https://img.shields.io/badge/Node.js-zero%20dependencies-339933?style=flat-square)](https://nodejs.org)
[![test](https://github.com/ChanMeng666/chanmeng-slack-waterline/actions/workflows/test.yml/badge.svg)](https://github.com/ChanMeng666/chanmeng-slack-waterline/actions/workflows/test.yml)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-EA4AAA?style=flat-square&logo=githubsponsors)](https://github.com/sponsors/ChanMeng666)

</div>

---

## The problem

Slack tools tell you what is unread. None of them can tell you what you *missed*.

The gap is threads. **A reply never moves its parent**, so a channel whose entire
live conversation is happening inside one older thread reports zero unread from
the top level — every day, silently, forever. A colleague's thirteen-item review
of a deck sits there for a day while the tool that was supposed to surface it
reports a clean board.

The second gap is honesty about what "read" means. Most catch-up tooling marks
things read when it *fetches* them. If the summary was never generated, or the
model never saw it, or the run died halfway, that message is now read and gone.
The miss is not temporary — the next run has nothing left to find.

## What this does

One command, and then you read what it puts in front of you:

```bash
node catchup.mjs --workspace acme --unread
```

| | |
|---|---|
| **Reads everything** | public and private channels, DMs, group DMs, thread replies, pinned messages, bookmarks, attachments |
| **Finds the hidden messages** | tracks per-thread reply counts, so a reply on a three-month-old parent still surfaces |
| **Never lies about what it read** | a read position moves only when a payload was actually delivered to a reader |
| **Proves it** | two gates that fail differently — one iterates the record, one interrogates Slack |
| **Reads the linked docs** | every tab of a Google Sheet, not the one in the `#gid=` |
| **DMs you a digest** | daily or weekly, with what needs a reply, what you already reacted to, and **what it could not see** |
| **Drafts and sends replies** | as you, dry-run first, every send logged before the call |
| **Travels with you** | one install, many workspaces — a slug and a directory per org |

Zero dependencies. Plain `fetch` against the Slack Web API, so nothing lands in
whatever repo you point it at.

## Design choices

**Three read positions, one writer each.** `watermarkTs` is what was READ — only
a delivered payload moves it. `scannedTs` is what the triage SCORED, and it only
advances on rows that are settled. `pendingTs` is what SLACK is holding on a row
the triage could not clear. The third exists because the gap between the first
two is zero *by construction* on any row that still needs work, so an audit built
on that gap alone reports a clean board over a real backlog.

**A read receipt may only describe what was delivered, never what exists.** This
is the whole thing. `catchup.mjs` deliberately records nothing; you read the
rendered deltas, delete anything you skipped from the prepared batch, and record
the rest.

**The signal gate decides priority, never whether something is read.** Keyword
scores sort the table. They never mark a row settled. A quiet channel that
finally says something important must not be skipped for scoring low — and a
direct message outranks any keyword, because somebody addressed you personally.

**A gate that iterates the record can only confirm the record is self-consistent.**
`audit.mjs` walks the manifest, so a conversation nobody ever enumerated is
invisible to it — not "clean", invisible. `coverage.mjs --enumerate-only` asks
the other question against Slack. Building this, that gate immediately found a
private channel and a DM the triage had never once looked at.

**A backlog is not a build failure.** The gates exit with a finding count so a
script can branch. A scheduled run that goes red because somebody posted in
Slack trains everyone to ignore red.

**HTTP 200 is not success.** Slack serves files from a CDN that returns a *login
page* with a 200 when auth fails; Google does the same for sheets. Both readers
check and refuse, because a login page written to disk as `deck.pdf` fails much
later, somewhere unrelated.

## Requirements

- **Node 18+** (uses global `fetch` and `node --test`). No npm install.
- **A Slack user token** (`xoxp-`). A bot token cannot see a single DM, which
  makes it close to useless for catching *you* up. See
  [`references/tokens-and-scopes.md`](skills/chanmeng-slack-waterline/references/tokens-and-scopes.md).

Two things no token can fix, stated plainly rather than papered over: **DMs
between two other people** need Slack's Discovery API (Enterprise Grid only), and
**a private channel nobody with a token is in** needs a human to invite you.

## Install

**Plugin marketplace** — in Claude Code:

```
/plugin marketplace add ChanMeng666/chanmeng-slack-waterline
/plugin install chanmeng-slack-waterline@chanmeng-slack-waterline
```

**Clone and copy:**

```bash
git clone https://github.com/ChanMeng666/chanmeng-slack-waterline.git
cp -r chanmeng-slack-waterline/skills/chanmeng-slack-waterline ~/.claude/skills/
```

**Symlink** (best while iterating):

```bash
git clone https://github.com/ChanMeng666/chanmeng-slack-waterline.git
ln -s "$PWD/chanmeng-slack-waterline/skills/chanmeng-slack-waterline" ~/.claude/skills/chanmeng-slack-waterline
```

<details>
<summary>Windows PowerShell</summary>

```powershell
New-Item -ItemType SymbolicLink `
  -Path "$env:USERPROFILE\.claude\skills\chanmeng-slack-waterline" `
  -Target "$PWD\chanmeng-slack-waterline\skills\chanmeng-slack-waterline"
```
</details>

## Setting up from zero

Never used the Slack API before? The skill walks you through it and checks its
own work:

```bash
node setup.mjs --workspace acme
```

That prints ✓ or ✗ for Node, the workspace, the token and **every scope**, then
stops at the first real blocker with the exact command or click that clears it.

The fast path is a Slack app manifest — one paste instead of ticking twelve
scope checkboxes, and it puts them under *User* Token Scopes, which is the
mistake that otherwise yields a token that cannot see a single DM:

```bash
node setup.mjs --workspace acme --manifest --out slack-app.yaml
# api.slack.com/apps → Create New App → From an app manifest → paste → Install
node setup.mjs --workspace acme --token-from-clipboard
```

Or let your agent drive Chrome: **"set up my Slack token in Chrome"**. It fills
the manifest, reads the consent screen back to you before clicking Allow, and
then deliberately stops and asks *you* to click Copy.

**The token never passes through a terminal, a shell history, or a chat
transcript.** It only has to get from Slack's page into one file, so it moves by
clipboard — `--token-from-clipboard` validates it, writes it, verifies it
against Slack, and prints only which team and user it belongs to. The agent is
told never to read that field off the page, and never to unmask it.

Already set up and something is off? `--verify` reads the scopes Slack actually
*granted*, from the `x-oauth-scopes` response header rather than the app config
page. That distinction is the most common setup failure in this whole tool:
**adding a scope does nothing until you reinstall the app**, so the config page
and your token routinely disagree.

## Usage

Set up a workspace once:

```bash
cd skills/chanmeng-slack-waterline/scripts
node init.mjs  --workspace acme --dir /path/to/acme-slack-archive
node setup.mjs --workspace acme     # tells you exactly what is left
```

Then just ask your agent:

> Catch me up on Slack.
>
> What did I miss in #eng this week?
>
> Did anyone need me today?
>
> Send me my Slack weekly report.
>
> Draft a reply to Saba's last message.

Or drive it directly:

```bash
node discover.mjs --workspace acme --all       # triage — rows, never bodies
node catchup.mjs  --workspace acme --unread    # fetch + render everything actionable
node record.mjs   --workspace acme --batch tmp/record-batch.json
node audit.mjs    --workspace acme             # is the record self-consistent?
node coverage.mjs --workspace acme --enumerate-only   # is the record complete?
node report.mjs   --workspace acme --period week --send
node send.mjs     --workspace acme --to '@Saba' --file draft.md --dry-run
```

## Layout

```
skills/chanmeng-slack-waterline/
  SKILL.md                    what the agent reads
  references/
    setup.md                  three paths to a token, including browser-driven
    read-state.md             the three positions, and what went unread before each existed
    tokens-and-scopes.md      xoxp vs xoxb, the scope list, the HTTP 200 trap
    workspace-config.md       config schema, signal patterns, multi-workspace
    reports.md                digest format, delivery, scheduling
  scripts/
    setup.mjs                 guided setup + scope doctor (start here)
    init.mjs                  scaffold and register a workspace
    discover.mjs              Layer A — triage the whole workspace
    fetch.mjs                 Layer B — pull one conversation
    render.mjs                the canonical way to read a payload
    record.mjs                the ONLY writer of the read position
    catchup.mjs               the whole loop
    audit.mjs  coverage.mjs   the two gates
    report.mjs  send.mjs      digest, and writing to Slack
    archive.mjs               raw payloads → readable Markdown transcripts
    fetch-sheet.mjs           every tab of a Google Sheet, no credentials
    download-file.mjs  extract-docx.mjs
    lib/                      slack, state, config, markup + offline tests
  assets/                     Windows Scheduled Task, GitHub Actions template
```

Your Slack data never lives here. Each workspace gets its own directory, with its
own token, manifest and archive — keep it private.

## Provenance

Generalized from two Slack ingestion systems the author ran daily for a year: a
personal reply queue for a startup workspace, and a 208-conversation archive for
a nonprofit. Every rule in `lib/state.mjs` is a message that actually went
unread, and `lib/state.test.mjs` names which. The design notes say what was
learned from running it; where something is untested at scale it says so.

## ❤️ Sponsor

If this saves you an hour a week, that is roughly the point.

<a href="https://github.com/sponsors/ChanMeng666"><img src="https://img.shields.io/badge/GitHub%20Sponsors-EA4AAA?style=for-the-badge&logo=githubsponsors&logoColor=white" alt="GitHub Sponsors"/></a>
<a href="https://buymeacoffee.com/chanmeng66u"><img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black" alt="Buy Me a Coffee"/></a>

## 📄 License

MIT © 2026 Chan Meng. See [LICENSE](LICENSE).

---

<!-- CHAN MENG PERSONAL BRAND -->
<div align="center">

  <p><strong>Chan Meng</strong><br/>Need a custom app like this one? I build them — let's talk.</p>

  <a href="mailto:chanmeng.dev@gmail.com"><img src="https://img.shields.io/badge/Email-chanmeng.dev@gmail.com-EA4335?style=flat-square&logo=gmail&logoColor=white" alt="Email Chan Meng"/></a>
  <a href="https://github.com/ChanMeng666"><img src="https://img.shields.io/badge/GitHub-ChanMeng666-181717?style=flat-square&logo=github&logoColor=white" alt="Chan Meng on GitHub"/></a>
</div>
<!-- /CHAN MENG PERSONAL BRAND -->
