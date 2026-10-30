#!/usr/bin/env node
// Is everything the manifest knows about actually read? Offline, free, ~instant.
//
//   node audit.mjs                 # exits 1 if anything is unread
//   node audit.mjs --json
//
// THIS GATE CAN ONLY EVER CONFIRM THE RECORD IS SELF-CONSISTENT. It iterates
// the manifest's key set, so a conversation nobody ever enumerated is invisible
// to it — not "clean", invisible. That is a different question and it has a
// different tool: `coverage.mjs --enumerate-only`. Run both.

import { fail } from './lib/slack.mjs'
import { resolveWorkspace, hasFlag } from './lib/config.mjs'
import { loadManifest, auditManifest } from './lib/state.mjs'

const argv = process.argv.slice(2)
const { slug, dataDir } = resolveWorkspace(argv)

const manifest = loadManifest(dataDir)
const findings = auditManifest(manifest)
const total = Object.keys(manifest.channels).length

if (hasFlag(argv, 'json')) {
  process.stdout.write(JSON.stringify({ workspace: slug, total, findings }, null, 2) + '\n')
  process.exit(findings.length ? 1 : 0)
}

if (!total) {
  console.log(`${slug}: the manifest is empty. Run discover.mjs first.`)
  process.exit(1)
}

if (!findings.length) {
  console.log(`✓ ${slug}: all ${total} known conversations are read up to their recorded position.`)
  console.log('  This says nothing about conversations the manifest has never heard of.')
  console.log('  Ask that question with:  node coverage.mjs --enumerate-only')
  process.exit(0)
}

const byKind = { 'never-read': [], 'never-triaged': [], behind: [] }
for (const f of findings) byKind[f.kind]?.push(f)

console.log(`✗ ${slug}: ${findings.length} of ${total} conversations are not fully read\n`)

const explain = {
  'never-read': 'NEVER READ — enumerated, but no payload has ever been delivered to a reader',
  'never-triaged': 'NEVER TRIAGED — never scored, so the backlog here is unknown, not zero',
  behind: 'BEHIND — Slack held content past the delivered position',
}

for (const [kind, items] of Object.entries(byKind)) {
  if (!items.length) continue
  console.log(`## ${explain[kind]}  (${items.length})\n`)
  for (const f of items) {
    console.log(`  ${f.label}`)
    console.log(`      ${f.detail}`)
    console.log(`      → ${f.remedy}`)
  }
  console.log('')
}

console.log('Or clear the lot:  node catchup.mjs --unread')
process.exit(1)
