# Read state — the three positions

Read this before changing anything in `scripts/lib/state.mjs`. Every rule below
is a message that went unread until the rule existed. `scripts/lib/state.test.mjs`
asserts each one offline in about a second; if a test starts failing, a message
is about to go missing — do not adjust the expectation to match the code.

## The manifest

`state.json` in the workspace directory. Committed, if the directory is a repo.
Keyed by **channel ID**, because a channel name changes and an ID does not.

```jsonc
{
  "version": 1,
  "channels": {
    "C0B7K8BFN30": {
      "name": "eng-backend",
      "type": "channel",                      // channel | private | dm | group-dm
      "mapping": {
        "kind": "track",                      // track | skip | none
        "targets": ["…"],                     // opaque to this skill
        "reason": "…",                        // why, for a skip
        "alwaysRead": true                    // bypasses every priority heuristic
      },
      "watermarkTs": "1780954764.500039",     // READ
      "scannedTs":   "1780954764.500039",     // TRIAGE
      "pendingTs":   "1787049715.026849",     // SLACK   (optional)
      "readAt":      "2026-08-12T05:15:34.316Z",
      "readAtSource": "bulk registration — NOT read one by one",
      "threads": { "1780900000.000100": { "replyCount": 4, "latestReplyTs": "1780950000.0001" } },
      "fingerprint": "sha256:…",
      "digest": "What was understood last time, and what is still open.",
      "digestAt": "2026-06-22T…Z",
      "lastSyncedAt": "2026-06-22T…Z"
    }
  }
}
```

Field order is fixed and optional fields are omitted when unset, so an entry
that never had a digest stays byte-identical across runs. A manifest that
reorders itself produces a diff on every write, and a diff nobody can read is a
diff nobody checks. Written temp-file-then-rename: a half-written manifest is
worse than none, because it claims things were read.

**Never hand-edit it.** `record.mjs` is the only writer.

## Why three positions

### `watermarkTs` — READ

The newest top-level ts whose content was actually handed to a reader. Moved
only by `record.mjs --from <payload>`, because only a fetch payload is evidence
that anything was delivered.

### `scannedTs` — TRIAGE

The newest top-level ts the triage has *scored*. Advanced by `discover.mjs`, and
**only on quiet rows**. Always `>= watermarkTs`. The gap between them is the
backlog.

The asymmetry is deliberate: the triage records what it *scored*, the fetch
records what it *delivered*. That is a weaker guarantee, which is exactly why a
quiet DM is not the same thing as a DM somebody has read.

### `pendingTs` — SLACK

The only field that describes Slack rather than us.

**The gap between the first two cannot open on a row that has an action.** The
triage deliberately leaves `scannedTs` alone when a row still needs work —
advancing it would mark unread content read — so a surfaced-and-never-worked row
holds `scannedTs === watermarkTs` forever and the measured gap is zero *by
construction*, however much Slack is holding.

An audit built on that gap alone once reported a whole workspace clean while two
live channels sat thirteen and fourteen messages behind.

So `pendingTs` records the newest ts the triage saw on a row it could not clear:
the max of the channel head and the newest reply on any grown thread, so a
channel behind only *inside a thread* counts too. Written on actionable rows,
deleted when a row goes quiet, and deleted by `record.mjs` once the delivered
position reaches it.

### `readAt` and `readAtSource`

`readAt` records **that** a real payload was delivered. An absent `readAt` is
not the same as `watermarkTs: "0"` — a bulk registration can set a watermark
without anybody having read a word, and the audit must be able to tell those
apart.

`readAtSource` is a **caveat that narrows the claim**. An unqualified `readAt`
asserts a human or a model looked at the content. Anything weaker must say so.

## `deliveredPosition`

```js
deliveredPosition(watermarkTs, threads)  // max of the watermark and every latestReplyTs
```

A reply never moves its parent, so the top-level watermark alone understates how
far a conversation has been read. `pendingTs` is frequently a *reply* ts, which
means comparing it against `watermarkTs` on its own could never retire it — and
two live channels stayed permanently red in the audit because of exactly that.

## Threads

Two functions own the entire question, and both used to have a second copy
somewhere else. That is why they diverged.

### `threadHasUnread(current, known)`

- **An absent `known` means ZERO REPLIES SEEN, not "skip".** A message posted
  with no replies is never written to `threads`, so the *first* reply it ever
  gets lands on a parent the manifest has never heard of. That is the most
  common case, and it was invisible while the test required a prior record.
- **`latestReplyTs` is checked as well as `replyCount`,** because a thread that
  gains one reply and loses another holds its count exactly.

### `mergeThreadState(parents, delivered, prior)`

A **delivered** thread advances. An **undelivered** one keeps whatever it had,
possibly nothing.

Never widen this to "the current state of everything". An earlier version built
its map from the full history *before* the emit loop, so it recorded threads
nobody had been shown as read. That is the difference between a bug caught on
the next run and a bug that erases its own evidence.

### Why the triage reads a page, not a message

`conversations.history limit: 1` returns the newest *parent*. A reply never
moves a parent. So a channel whose only new content was thread replies got
reported quiet, hidden behind `--all`, and advanced past — every day, silently.

The triage now reads a page of 200 and compares every parent's `reply_count` and
`latest_reply` against the manifest.

## The triage decision

`decideAction()` composes two independent facts:

- **remote** — Slack is holding unread content (`incremental`, `read`,
  `read (thread replies)`, `read in full (scan truncated)`)
- **local** — the thing this conversation feeds changed out of band
  (`local-stale`)

**A local condition never masks a remote one.** They answer different questions
and a row can be either, both, or neither. An earlier version returned on the
local condition first; on one run every tracked channel printed `local-stale`,
and the two holding unread messages were indistinguishable from the ones that
held nothing. Hence `incremental + local-stale`.

`isQuiet()` is true only for `no-op`, `archived` and `skip`. Only a quiet row may
advance `scannedTs`.

### A truncated scan can never be quiet

If the body scan hits its cap, the row becomes `read in full (scan truncated)`.
A partial scan cannot conclude anything — **including "nothing here"**.

### The signal gate decides priority, never whether something is read

`priorityOf()` sorts the table. It does not filter it. An earlier version let a
below-threshold score return `no-op`, which advanced the triage position past
unread messages — so a low-traffic channel that finally said something important
was marked settled without anybody seeing it.

A direct message outranks any keyword score. Somebody addressed you personally,
and no amount of scoring makes that untrue.

## `alwaysRead`

Separates two questions that look alike: *"is this worth opening?"* and *"does
this feed an output?"*. A DM from someone who sends actual work scores zero on
every keyword list ever written. Set it on those.

## Mapping inheritance

Omitting `--mapping` **inherits** the existing mapping. Recording a read is not
a statement about mapping. It used to default to `none`, which silently deleted a
channel's targets and its `alwaysRead` flag every time somebody recorded a
routine read.

`--mapping none` still clears it, deliberately.

## Fingerprints — the optional no-op short-circuit

`fingerprintCommand` in the workspace config is any shell command whose stdout
is stable; its sha256 is compared against the stored `fingerprint`. If a re-sync
would produce the same result, the row is a no-op and costs zero tokens.

Deliberately opaque: the skill never learns what the output artifact is, which
is what lets the same engine serve an events JSON, a ticket tracker, or nothing
at all. `{channel}` and `{targets}` are substituted. A command that fails is
reported and treated as unchanged — a broken fingerprint must not make every row
look stale, and must not make every row look fresh either.

## The two gates

**`audit.mjs`** iterates the manifest. Three failure classes because they need
different fixes:

| class | means |
|---|---|
| `never-read` | enumerated, but no payload was ever delivered |
| `never-triaged` | never scored — the backlog is **unknown**, not zero |
| `behind` | Slack held content past the delivered position |

A settled `skip` is exempt: a bot firehose is permanently behind by design, and
counting it makes the gate cry wolf — the one failure mode a gate cannot survive.

**`coverage.mjs`** walks Slack itself.

> A gate that iterates the record can only ever confirm the record is
> self-consistent.

Everything built on the manifest iterates its key set, so a conversation nobody
ever enumerated is invisible to all of them at once. That is not a bug in any of
them; it is the shape of the question. `--enumerate-only` asks the other one
against `conversations.list` with `exclude_archived: false`, in seconds. During
development of this skill it immediately found a private channel and a DM that
the triage had never once looked at.

## Automation

Any scheduled or CI run passes `--no-record`. **A machine must never advance a
read position** — nobody read anything, and the next human run would find a
clean board over a real backlog.
