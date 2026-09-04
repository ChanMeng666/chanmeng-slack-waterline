#!/usr/bin/env node
// Does Slack hold a conversation the manifest has never heard of?
//
//   node coverage.mjs --enumerate-only    # ~seconds. Run this every sync.
//   node coverage.mjs                     # also re-checks each known position
//   node coverage.mjs --json
//
// THE QUESTION THIS ASKS IS NOT THE ONE `audit.mjs` ASKS, and confusing them is
// expensive. A gate that iterates the record can only ever confirm the record is
// self-consistent. This one walks `conversations.list` — including archived
// channels, which is where they hide — and compares Slack against the manifest.
//
// Exits with the number of findings, so a shell can branch on it. That is not a
// build failure: see the note at the bottom of the file.

import { Slack, note, finish } from './lib/slack.mjs'
import { resolveWorkspace, hasFlag } from './lib/config.mjs'
import { loadManifest, deliveredPosition } from './lib/state.mjs'
import { conversationName, conversationType } from './lib/markup.mjs'

const argv = process.argv.slice(2)
const { slug, dataDir } = resolveWorkspace(argv)
const slack = new Slack(dataDir)
const enumerateOnly = hasFlag(argv, 'enumerate-only')

slack.announceIdentity()

const manifest = loadManifest(dataDir)
const users = await slack.users()

// exclude_archived: false is the whole point. Archived channels are exactly the
// ones a membership-scoped listing quietly omits, and they still hold history.
const convos = await slack.all(
  'conversations.list',
  { types: slack.conversationTypes, exclude_archived: false },
  'channels',
  { limit: 1000 }
)

const findings = []
const known = new Set(Object.keys(manifest.channels))

for (const c of convos) {
  if (!slack.isReadable(c) && !c.is_archived) continue
  if (known.has(c.id)) continue
  findings.push({
    id: c.id,
    name: conversationName(c, users),
    type: conversationType(c),
    kind: 'unenumerated',
    detail: c.is_archived
      ? 'archived, and the manifest has never heard of it'
      : 'visible to this token, and the manifest has never heard of it',
    remedy: `node fetch.mjs ${c.id} --full --out raw/${c.id}.json`,
  })
}

// The reverse direction: the manifest naming something Slack no longer returns.
for (const [id, c] of Object.entries(manifest.channels)) {
  if (convos.some((x) => x.id === id)) continue
  findings.push({
    id,
    name: c.name || id,
    type: c.type ?? '?',
    kind: 'vanished',
    detail: 'in the manifest, but Slack did not return it — deleted, or access was revoked',
    remedy: 'confirm with a human; the archive still holds whatever was fetched',
  })
}

if (!enumerateOnly) {
  note(`re-checking ${known.size} known positions against Slack…`)
  for (const [id, entry] of Object.entries(manifest.channels)) {
    if (entry.mapping?.kind === 'skip' && !entry.mapping?.alwaysRead) continue
    if (!convos.some((x) => x.id === id)) continue
    try {
      const r = await slack.call('conversations.history', { channel: id, limit: 1 })
      const head = Number(r.messages?.[0]?.ts ?? 0)
      if (!head) continue
      const delivered = deliveredPosition(entry.watermarkTs, entry.threads)
      if (head > delivered) {
        findings.push({
          id,
          name: entry.name || id,
          type: entry.type ?? '?',
          kind: 'behind-at-source',
          detail: `Slack head ${head.toFixed(6)} > delivered ${delivered.toFixed(6)}`,
          remedy: `node fetch.mjs ${id} --state --out tmp/${id}.json && node render.mjs tmp/${id}.json`,
        })
      }
    } catch {
      /* unreadable now — the enumeration pass above already reports access loss */
    }
  }
}

if (hasFlag(argv, 'json')) {
  process.stdout.write(
    JSON.stringify({ workspace: slug, enumerated: convos.length, known: known.size, findings }, null, 2) + '\n'
  )
  await finish(Math.min(findings.length, 250))
  process.exit()
}

console.log(
  `\n${slug}: Slack returned ${convos.length} conversations; the manifest knows ${known.size}.`
)

if (!findings.length) {
  console.log('✓ Nothing Slack holds is missing from the record.')
  await finish(0)
  process.exit()
}

const groups = {
  unenumerated: 'NOT IN THE MANIFEST — Slack holds these and nothing has ever looked',
  vanished: 'IN THE MANIFEST, NOT IN SLACK — deleted, or access was revoked',
  'behind-at-source': 'BEHIND AT SOURCE — Slack has moved past the delivered position',
}
for (const [kind, title] of Object.entries(groups)) {
  const items = findings.filter((f) => f.kind === kind)
  if (!items.length) continue
  console.log(`\n## ${title}  (${items.length})\n`)
  for (const f of items) {
    console.log(`  ${f.name} [${f.id}] (${f.type})`)
    console.log(`      ${f.detail}`)
    console.log(`      → ${f.remedy}`)
  }
}

// A BACKLOG IS NOT A BUILD FAILURE. The exit code carries the count so a script
// can branch, but a scheduled run that goes red because somebody posted in Slack
// trains everyone to ignore red — which costs more than the backlog.
console.log(`\n${findings.length} findings. This is a backlog, not a build failure.`)
await finish(Math.min(findings.length, 250))
