# Setting up from zero

Three ways to get a working token. They end in the same place; pick by how much
you want to do yourself.

Whichever you pick, `setup.mjs` is the thing that tells you where you are:

```bash
node setup.mjs --workspace acme
```

It checks Node, the workspace, the token, every scope, and whether anything has
been read yet — then stops at the first real blocker and prints the exact
command or click that clears it.

---

## The rule that governs all three

> **A live token must never enter a terminal, a shell history, or a chat
> transcript.**

It only has to travel from Slack's page into one file. Every path below moves it
by clipboard, because that is the one channel that already holds it — you just
clicked Copy — and that nothing else records:

```bash
node setup.mjs --workspace acme --token-from-clipboard
```

That reads the clipboard, checks the shape, writes it to the workspace `.env`,
verifies it against Slack, and prints only which team and user it belongs to.
It never echoes the token, and on a mismatch it does not echo the clipboard
either — your clipboard is yours, and it routinely holds other people's secrets.

**Never** pass a token as `--token xoxp-…`. That lands in shell history and in
the process list, and if an agent typed it, in a transcript that outlives the
session.

---

## Path 1 — the manifest (fastest)

A Slack app manifest sets every scope in one paste, instead of you finding and
ticking twelve checkboxes.

```bash
node setup.mjs --workspace acme --manifest --out slack-app.yaml
```

1. Open <https://api.slack.com/apps>
2. **Create New App** → **From an app manifest**
3. Pick your workspace → paste `slack-app.yaml` → **Next** → **Create**
4. **Install to Workspace** → **Allow**
5. **OAuth & Permissions** → click **Copy** under *User OAuth Token*
6. `node setup.mjs --workspace acme --token-from-clipboard`

Roughly two minutes. Step 4 is the one people skip; an app that exists but was
never installed has no token at all.

---

## Path 2 — browser-assisted

Ask your agent:

> Set up my Slack token in Chrome.

The agent drives the pages, fills the manifest, and clicks through the install —
then hands the last step back to you, deliberately.

### Instructions for the agent

Load the browser tools in **one** `ToolSearch` call:

```
select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__find,mcp__claude-in-chrome__form_input
```

Then:

1. `tabs_context_mcp` first, to see what is open. Do not reuse an existing tab
   unless the user asks — `tabs_create_mcp` a new one.
2. Generate the manifest first (`setup.mjs --manifest`) so you have the YAML
   before you need it.
3. Navigate to `https://api.slack.com/apps`. If the user is not signed in, stop
   and ask them to sign in — never attempt to drive a login form.
4. **Create New App** → **From an app manifest** → pick the workspace → paste
   the YAML into the manifest editor → **Next** → **Create**.
5. **Install to Workspace** → **Allow**. This is the consent screen; read the
   scope list back to the user before clicking, so they are agreeing to
   something they have seen.
6. Navigate to **OAuth & Permissions**.
7. **Stop here.** Tell the user, in words:
   > Click **Copy** under *User OAuth Token*, then tell me and I'll pull it in.
8. When they confirm, run `setup.mjs --workspace <slug> --token-from-clipboard`
   and report the team and user it came back with.

### What the agent must not do

- **Do not read the token off the page.** No `read_page`, `get_page_text`,
  `find`, `javascript_tool` or screenshot aimed at the token field, and do not
  click **Show** to unmask it. Slack masks that field by default; unmasking it
  and capturing it would write a live credential into the conversation
  transcript, where it outlives the session and is far harder to revoke than to
  leak. Step 7 exists precisely so it never has to.
- **Do not click Allow without showing the user the scopes.** It is their
  workspace and their consent.
- **Do not touch Client Secret, Signing Secret or App-Level Tokens.** This skill
  needs none of them.
- **Do not create the app in a workspace the user did not name.** People are
  signed into several; ask which one.

If a page will not load or a click does not register after two or three
attempts, stop and hand back to Path 3 rather than clicking around.

---

## Path 3 — by hand

Use this when the manifest editor is unavailable, or you want to see exactly
what you are granting.

1. <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. Name it anything; pick your workspace.
3. **OAuth & Permissions** in the left sidebar.
4. Scroll to **Scopes** → **User Token Scopes** (*not* Bot Token Scopes — that
   is the mistake that produces a token which cannot see a single DM).
5. Add:

```
channels:history   channels:read
groups:history     groups:read
im:history         im:read
mpim:history       mpim:read
users:read
```

Then the optional ones — everything works without them, but the matching
feature goes quiet:

```
files:read       attachments
pins:read        pinned messages
bookmarks:read   channel bookmarks
```

And, only if you want the digest DM'd to you and the ability to reply:

```
chat:write       post and edit as you
im:write         open a DM, including with yourself
```

6. Scroll up → **Install to Workspace** → **Allow**.
7. Copy the **User OAuth Token** (`xoxp-…`).
8. `node setup.mjs --workspace acme --token-from-clipboard`

---

## Checking what you actually got

```bash
node setup.mjs --workspace acme --verify
```

Reads the scopes Slack says it granted — from the `x-oauth-scopes` response
header, not from the app config page — and lists them against what the skill
needs.

That distinction is the single most common setup failure: **adding a scope does
nothing until you reinstall the app.** The config page will happily show a scope
that your token does not have. This check reads the token, so it cannot be
fooled that way.

---

## When it goes wrong

| what you see | what it means |
|---|---|
| `invalid_auth` | wrong token, revoked token, or the variable is misspelled. It is `SLACK_USER_TOKEN`, not `SLACK_TOKEN` — and a misspelling looks exactly like a revoked token |
| `missing_scope` | add the scope **and reinstall**, then re-copy the token: the old one keeps the old scopes |
| `not_authed` | no token reached Slack at all — check the `.env` line has no stray quotes |
| The clipboard step says it found no token | you copied the Client Secret or the App ID. It is the field labelled *User OAuth Token*, starting `xoxp-` |
| Everything works but there are no DMs | you installed **Bot** Token Scopes instead of **User** Token Scopes. A bot cannot see a DM between two humans — the result is invisible, not empty. Check the identity line the scripts print on stderr |
| `not_in_channel` on a private channel | nobody can fix this from an API. A human has to invite you |
| An admin has to approve the app | some workspaces require it. Slack shows a *Request to Install* button instead of *Install*; the token appears once someone approves |

---

## Google Sheets need no credentials

People link run sheets and trackers into Slack constantly, and reading them
takes no setup at all — a link-viewable sheet serves over the plain CSV export
endpoint:

```bash
node fetch-sheet.mjs 'https://docs.google.com/spreadsheets/d/…' --workspace acme
```

If it refuses with a sign-in page, the sheet is genuinely not shared. Ask the
owner to set link sharing to *Anyone with the link — Viewer*, or to export the
tab. **Do not guess at its contents**, and do not sign a browser session into
Google to get around it.

---

## Joining somewhere new later

That is the point of the design. Register another workspace; nothing is shared
but the code.

```bash
node init.mjs  --workspace newco --dir ~/newco-slack-archive
node setup.mjs --workspace newco
node init.mjs  --list
```

Each workspace keeps its own token, config, read state and archive. Set a
default with `--default`, or pass `--workspace` every time.

**Keep each data directory private.** It holds real conversations, including
DMs. If you make it a git repo, make it a private one.

## Leaving somewhere

Revoke the token at <https://api.slack.com/apps> → your app → **OAuth &
Permissions** → *Revoke All OAuth Tokens*, or delete the app entirely. Then
decide what happens to the archive: it is a record of other people's messages,
and keeping it after you no longer have access is a choice worth making
deliberately rather than by forgetting.
