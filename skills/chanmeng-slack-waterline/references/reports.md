# Reports and scheduling

## What a report is

```bash
node report.mjs --workspace acme --period day
node report.mjs --workspace acme --period week --send
node report.mjs --workspace acme --since 72h --send --dry-run
```

Sections, in order:

1. **Needs a reply** — a DM, a mention, a question-shaped message, an
   attachment, or anything from an `alwaysRead` conversation. Full quoted text
   (clipped at 500 chars), tags, attachments, reactions, and a Slack permalink.
2. **Asked you, but you already reacted** — you put an emoji on it, so it is
   probably handled. One line each.
3. **Context** — everything else that happened.
4. **What this digest could not see** — the blind spots, the `skip`ped
   conversations, and anything that errored.

That last section is not filler. A digest that lists five things and says
nothing about its own edges reads as "there were five things", which is a
different and often false claim.

## A report is a view, not a read

`report.mjs` never touches `state.json`.

Being told about a message in a summary is not the same as having read the
conversation it came from, and conflating the two is how a backlog disappears
without anyone clearing it. The report says so in its own footer and points at
`catchup.mjs`.

It also works off a **trailing window**, not the watermark — so a scheduled run
tells you what happened *today* whether or not you are caught up. Being three
weeks behind does not produce a three-week daily digest.

## Reactions

Both systems this skill was generalized from captured reactions into their
payloads and rendered them nowhere. That is a real loss: a 👀 or a ✅ on a
request is the clearest available signal that somebody — often you — already
dealt with it.

Here, your own reaction moves an item out of *needs a reply*, and reactions are
rendered inline everywhere else.

## Delivery

`--send` DMs it to `report.deliverTo` (default `@me`, your own DM-with-self).
Long reports are split on paragraph boundaries and threaded under the first
message rather than flooding the conversation. Every part goes through the same
logged path as `send.mjs`, so `sent.log.jsonl` records it.

`--send --dry-run` resolves the target and prints what would go, without
sending. Do that once before scheduling anything.

## Scheduling on Windows

```powershell
.\assets\schedule-task.ps1 -Workspace acme -Period day -Time 08:00
.\assets\schedule-task.ps1 -Workspace acme -Period week -Time 08:00 -DayOfWeek Monday
.\assets\schedule-task.ps1 -Workspace acme -Unregister
```

Registers a Scheduled Task that runs `report.mjs --send`. Run it once by hand
first — a scheduled task that fails silently at 8am is worse than no task.

## Scheduling in CI

`assets/github-workflow.tmpl` is the cloud equivalent: a cron that runs the
triage and opens or updates an issue.

Two rules for any automated run:

1. **`--no-record`, always.** A machine must never advance a read position.
   Nobody read anything, and the next human run would find a clean board over a
   real backlog.
2. **A backlog is not a build failure.** The gates exit with a finding count so
   a script can branch, but a workflow that goes red because somebody posted in
   Slack trains everybody to ignore red — which costs more than the backlog.

CI needs `SLACK_USER_TOKEN` as a secret. Consider whether you want a token that
can read your DMs living in a CI provider; running the triage locally and only
the reporting in CI is a reasonable split.

## Customising the output

- `report.maxItemsPerSection` caps each section.
- `report.includeContext: false` drops the context section for a terse digest.
- `needsReply.patterns` decides what counts as an ask. A DM, a mention or an
  attachment counts regardless.
- `timezone` controls every rendered timestamp.

## Writing your own summary instead

The report is deliberately mechanical — it classifies, it does not interpret.
For a real weekly summary, read the rendered deltas from `catchup.mjs` and write
prose, then keep the understanding where it will be reused:

```bash
node record.mjs --workspace acme --from tmp/<id>.json --digest-file notes.md
```

Digests come back as `_meta.priorDigest` on the next fetch and as a `↳ digest:`
line in the triage. The watermark stops the next run re-fetching old messages;
the digest stops it re-deriving their meaning.
