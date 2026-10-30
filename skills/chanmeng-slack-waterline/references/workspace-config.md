# Workspace configuration

Everything org-specific lives in the workspace's own `config.json`, not in code.
That is the whole difference between a tool for one company and a tool you can
take to the next one.

`init.mjs` writes it with defaults. Edit it by hand.

## The registry

`~/.chanmeng-slack-waterline/config.json` maps a slug to a directory, and nothing else:

```json
{
  "default": "acme",
  "workspaces": {
    "acme": { "dir": "D:\\repos\\acme-slack-archive" },
    "shesharp": { "dir": "D:\\repos\\shesharp-slack-archive" }
  }
}
```

Selection order: `--workspace <slug|path>` → `SLACK_WATERLINE_DIR` → the
default. An absolute path works anywhere a slug does, so a directory can be
driven before it is registered.

## The workspace file

```jsonc
{
  "name": "acme",
  "timezone": "Pacific/Auckland",     // all rendered timestamps
  "language": "en",

  // First-ever run only. Without it, the first catchup pulls all history.
  "firstRunLookbackDays": 7,

  // null = everything the token can see, which is the point of the skill.
  // An array narrows to specific names, IDs, or types ("dm", "channel").
  "watch": null,
  "excludeChannels": [],

  // Sorts the triage table. NEVER decides whether something is read.
  "signal": {
    "threshold": 3,
    "patterns": [
      { "pattern": "\\bblock(ed|er|ing)?\\b", "weight": 3 },
      { "pattern": "\\b(urgent|asap|critical|p0|sev1)\\b", "weight": 3 }
    ]
  },

  // Does this message want something from you? A DM, a mention or an
  // attachment counts regardless of these.
  "needsReply": { "patterns": ["\\?", "\\bcould you\\b", "\\bplease\\b"] },

  "report": {
    "deliverTo": "@me",
    "includeContext": true,
    "maxItemsPerSection": 40
  },

  // Optional. See below.
  "fingerprintCommand": null
}
```

Patterns are JavaScript regex **source strings**, matched case-insensitively.
Escape backslashes for JSON: `\\b`, not `\b`. A pattern that does not compile is
skipped rather than taking the run down — it is a config typo, and the run still
has real work to do.

## Tuning the signal patterns

The defaults are deliberately conservative and generic. Replace them with the
words your workspace actually uses when something needs you: your release
vocabulary, your incident vocabulary, the names of the systems you own.

Remember what the score is for. It **sorts** the table so the important thing is
at the top. It never decides that a conversation is settled — a channel with new
messages is always read eventually, whatever it scored.

## `alwaysRead`, not a pattern

For the handful of people whose messages are always work, do not try to write a
regex. Mark the conversation:

```bash
node record.mjs --workspace acme --channel D0ABC123 --always-read
```

That bypasses every heuristic permanently.

## Deliberately not reading something

```bash
node record.mjs --workspace acme --channel C0DEF456 \
  --mapping skip --reason "CI build firehose, nothing a human writes"
```

A skip is sticky and is exempt from the audit — a bot channel is permanently
behind by design, and counting it makes the gate cry wolf. New activity still
surfaces once, as `skip→review (new msgs)`, so a channel that changes character
is not lost.

## `fingerprintCommand`

Optional. Detects that the thing a conversation *feeds* changed outside this
skill.

Any shell command whose stdout is stable; the skill sha256s it and compares
against the stored fingerprint. It is completely opaque to the skill, which is
what lets the same engine serve a website's JSON, a ticket tracker, or nothing.

```json
{ "fingerprintCommand": "node scripts/describe-target.mjs {targets}" }
```

`{channel}` and `{targets}` are substituted; a command with no placeholder runs
once and its hash is shared across rows. Only rows mapped `track` are checked.
A command that fails is reported on stderr and treated as unchanged.

## Multiple workspaces

Register as many as you like. Each has its own token, config, manifest and
archive; nothing is shared but the code.

```bash
node init.mjs --workspace acme     --dir D:/repos/acme-slack-archive
node init.mjs --workspace shesharp --dir D:/repos/shesharp-slack-archive
node init.mjs --list

node catchup.mjs --workspace acme --unread
node report.mjs  --workspace shesharp --period week --send
```

## What lives in the data directory

| path | commit it? |
|---|---|
| `state.json` | **yes** — it is the record |
| `config.json` | yes |
| `.env` | **never** — gitignored |
| `raw/` | only if the repo is private; contains full DM text. Gitignored by default |
| `conversations/` | your call; generated, wiped and rebuilt every run |
| `reports/` | your call |
| `sent.log.jsonl` | gitignored by default; it is your audit trail |
| `.cache/`, `tmp/` | never — rebuildable, and may hold message excerpts |

**If the data directory is a git repo, keep it private.** It holds private
conversations. Never open-source it and never paste its contents into a public
issue.
