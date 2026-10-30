#!/usr/bin/env node
// Read a workspace. The one command that does the whole loop.
//
//   node catchup.mjs --unread              # everything the triage flagged
//   node catchup.mjs --all                 # every readable conversation
//   node catchup.mjs --since 7d            # a window, regardless of state
//   node catchup.mjs --channels general,eng-backend
//   node catchup.mjs --dms-only
//   node catchup.mjs --all --full          # first-ever archive pass
//
// Runs the triage, fetches every selected conversation, renders each one, and
// leaves you an index plus a prepared record batch.
//
// IT DOES NOT RECORD ANYTHING. Fetching is not reading. The last step is yours:
// read the rendered deltas, delete from the batch anything you did not actually
// read, then run record.mjs --batch.

import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { note, fail } from './lib/slack.mjs'
import { resolveWorkspace, hasFlag, argValue } from './lib/config.mjs'
import { loadManifest, isQuiet } from './lib/state.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const { slug, dataDir } = resolveWorkspace(argv)

const tmpDir = join(dataDir, 'tmp')
const since = argValue(argv, 'since')
const full = hasFlag(argv, 'full')
const channelsArg = argValue(argv, 'channels')

// ---------------------------------------------------------------- select

let ids = []
let selectionLabel = ''

if (channelsArg) {
  // Names resolve inside fetch.mjs, which already refuses an ambiguous one.
  ids = channelsArg.split(',').map((s) => s.trim()).filter(Boolean)
  selectionLabel = `${ids.length} named conversations`
} else {
  const wantAll = hasFlag(argv, 'all')
  const dmsOnly = hasFlag(argv, 'dms-only')

  if (!hasFlag(argv, 'no-discover')) {
    note('── triage ──')
    run('discover.mjs', [...passthrough(), ...(wantAll ? ['--all'] : []), '--json'], { capture: join(tmpDir, 'triage.json') })
  }

  const triagePath = join(dataDir, '.cache', 'triage.json')
  if (!existsSync(triagePath)) fail('No triage available. Run discover.mjs first, or pass --channels.')
  const triage = JSON.parse(readFileSync(triagePath, 'utf8'))

  let rows = triage.rows
  if (dmsOnly) rows = rows.filter((r) => r.type === 'dm' || r.type === 'group-dm')
  if (!wantAll) rows = rows.filter((r) => !isQuiet(r.action) && !r.action.startsWith('unreadable'))
  rows = rows.filter((r) => r.action !== 'archived' || full)

  ids = rows.map((r) => r.id)
  selectionLabel = wantAll ? `all ${ids.length} scanned conversations` : `${ids.length} actionable conversations`
}

if (!ids.length) {
  console.log(`\n✓ ${slug}: nothing to read.`)
  console.log('  Confirm nothing is hiding:  node coverage.mjs --enumerate-only')
  process.exit(0)
}

// ---------------------------------------------------------------- fetch

// A fresh tmp/ every run. A stale payload beside a new one is worse than a
// missing payload: nothing tells you which is current.
rmSync(tmpDir, { recursive: true, force: true })
mkdirSync(tmpDir, { recursive: true })

const idsFile = join(tmpDir, 'ids.txt')
writeFileSync(idsFile, ids.join('\n') + '\n')

note(`\n── fetching ${selectionLabel} ──`)
const fetchArgs = [...passthrough(), '--many', idsFile, '--out-dir', tmpDir]
if (since) fetchArgs.push('--since', since)
else if (full) fetchArgs.push('--full')
else fetchArgs.push('--state')

const fetchResult = run('fetch.mjs', fetchArgs, { allowFailure: true })
if (fetchResult.status) note(`  ${fetchResult.status} conversations failed — they are listed above and were not written`)

// ---------------------------------------------------------------- render

note('\n── rendering ──')
const rendered = []
const batch = []

for (const id of ids) {
  const payloadPath = join(tmpDir, `${id}.json`)
  if (!existsSync(payloadPath)) continue

  let payload
  try {
    payload = JSON.parse(readFileSync(payloadPath, 'utf8'))
  } catch {
    note(`  ✗ ${id}: payload is not valid JSON`)
    continue
  }
  if (!payload._meta?.newCount && !payload.pinned?.length) continue

  const outPath = join(tmpDir, `${id}.md`)
  const r = run('render.mjs', [payloadPath, ...passthrough()], { capture: outPath, allowFailure: true })
  if (r.status) continue

  rendered.push({
    id,
    name: payload.channel?.name ?? id,
    type: payload.channel?.type ?? '?',
    count: payload._meta?.newCount ?? 0,
    path: outPath,
  })
  batch.push(['--from', payloadPath])
}

const batchPath = join(tmpDir, 'record-batch.json')
writeFileSync(batchPath, JSON.stringify(batch, null, 2) + '\n')

// ---------------------------------------------------------------- index

const indexPath = join(tmpDir, 'INDEX.md')
const totalNew = rendered.reduce((n, r) => n + r.count, 0)
const index = [
  `# ${slug} — catchup, ${new Date().toISOString()}`,
  '',
  `${rendered.length} conversations with new content · ${totalNew} new messages`,
  '',
  '| conversation | type | new | rendered delta |',
  '|---|---|---:|---|',
  ...rendered
    .sort((a, b) => b.count - a.count)
    .map((r) => `| ${r.name} | ${r.type} | ${r.count} | \`${r.path}\` |`),
  '',
  '## After reading',
  '',
  'Record ONLY what was actually read. Delete any entry from the batch whose',
  'delta you did not open, then:',
  '',
  '```',
  `node record.mjs --workspace ${slug} --batch ${batchPath}`,
  '```',
  '',
  'Add a digest per conversation while the understanding is fresh — it is what',
  'stops the next run re-deriving the meaning of messages it already fetched:',
  '',
  '```',
  `node record.mjs --workspace ${slug} --from <payload> --digest "…"`,
  '```',
].join('\n')

writeFileSync(indexPath, index + '\n')

console.log(`\n${'─'.repeat(70)}`)
console.log(index)
console.log('─'.repeat(70))
if (!rendered.length) {
  console.log('\nNo conversation had new content. Nothing to record.')
}

// ================================================================== helpers

/** Flags every child needs — the workspace selector, above all. */
function passthrough() {
  const out = []
  const w = argValue(argv, 'workspace') ?? argValue(argv, 'w')
  if (w) out.push('--workspace', w)
  return out
}

/**
 * Spawn a sibling script with no shell.
 *
 * No shell, so an argument containing a space, a quote or a `>` cannot be
 * reinterpreted — conversation names are whatever somebody typed into Slack.
 */
function run(script, args, { capture = null, allowFailure = false } = {}) {
  const res = spawnSync(process.execPath, [join(HERE, script), ...args], {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  })
  if (capture && res.stdout != null) {
    mkdirSync(dirname(capture), { recursive: true })
    writeFileSync(capture, res.stdout)
  }
  if (res.status && !allowFailure) {
    fail(`${script} failed (exit ${res.status})`)
  }
  return res
}
