#!/usr/bin/env node
// Triage the whole workspace. Layer A.
//
//   node discover.mjs                 # actionable rows only
//   node discover.mjs --all           # include settled rows
//   node discover.mjs --no-dms        # skip DMs
//   node discover.mjs --no-record     # report only, move nothing (USE THIS IN CI)
//   node discover.mjs --json          # machine output
//
// PRINTS ROWS, NEVER MESSAGE BODIES. The whole point is that a model learns the
// shape of the workspace in one small read, and only then opens what matters.
//
// --no-record IS LOAD-BEARING FOR ANY AUTOMATED RUN. A machine must never
// advance a read position: nobody read anything, and the next human run would
// find a clean board over a real backlog.

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'

import { Slack, note, fail, finish } from './lib/slack.mjs'
import { resolveWorkspace, hasFlag, argValue } from './lib/config.mjs'
import {
  loadManifest,
  saveManifest,
  emptyChannel,
  threadHasUnread,
  decideAction,
  isQuiet,
  priorityOf,
} from './lib/state.mjs'
import { conversationName, conversationType, compilePatterns, scoreText, renderText } from './lib/markup.mjs'

// How many grown threads ONE channel's peek will open. Uncapped, a busy channel
// costs a call per thread, times every conversation in the workspace.
const GROWN_THREAD_PEEK_CAP = 8
// Messages whose bodies get scored. Hitting this makes the row unquiet, because
// a partial scan cannot conclude anything — INCLUDING "nothing here".
const SCAN_CAP = 60

const argv = process.argv.slice(2)
const { slug, dataDir, config } = resolveWorkspace(argv)
const slack = new Slack(dataDir)
const record = !hasFlag(argv, 'no-record')
const showAll = hasFlag(argv, 'all')
const asJson = hasFlag(argv, 'json')

slack.announceIdentity()
if (!record) note('--no-record: nothing will be written to state.json')

const me = await slack.call('auth.test', {})
const myId = me.user_id
const users = await slack.users()
const manifest = loadManifest(dataDir)
const signal = compilePatterns(config.signal?.patterns)
const signalThreshold = config.signal?.threshold ?? 3

// ---------------------------------------------------------------- enumerate

const convos = await slack.all(
  'users.conversations',
  { types: slack.conversationTypes, exclude_archived: false },
  'channels'
)

const notVisible = []
if (!slack.usingUserToken) {
  notVisible.push('DMs and group DMs (bot token — they are invisible, not empty)')
}
if (hasFlag(argv, 'no-dms')) notVisible.push('DMs (--no-dms)')
notVisible.push('DMs between two other people (needs Slack Discovery API — Enterprise Grid only)')
notVisible.push('private channels you are not in (a human has to /invite you)')

const excluded = new Set(config.excludeChannels ?? [])
const watch = config.watch ? new Set(config.watch) : null

const targets = convos.filter((c) => {
  // users.conversations returns only what you are in, so membership is implied.
  if (!slack.isReadable(c, { memberImplied: true }) && !c.is_archived) return false
  if (hasFlag(argv, 'no-dms') && (c.is_im || c.is_mpim)) return false
  const name = conversationName(c, users)
  if (excluded.has(name) || excluded.has(c.id)) return false
  if (watch && !watch.has(name) && !watch.has(c.id) && !watch.has(conversationType(c))) return false
  return true
})

note(`scanning ${targets.length} of ${convos.length} conversations…`)

// ---------------------------------------------------------------- triage

const rows = []
const fingerprints = new Map()

for (const c of targets) {
  const name = conversationName(c, users)
  const type = conversationType(c)
  const prior = manifest.channels[c.id]
  const entry = prior ? { ...prior } : emptyChannel(name, type)
  entry.name = name
  entry.type = type

  if (c.is_archived) {
    rows.push(row(c, name, type, entry, 'archived', {}))
    if (record) manifest.channels[c.id] = entry
    continue
  }

  // Scan from the TRIAGE position, not the read position. The gap between them
  // is the backlog, and scanning from the read position would erase it.
  const from = entry.scannedTs ?? entry.watermarkTs
  const oldest =
    from && from !== '0'
      ? from
      : (Date.now() / 1000 - (config.firstRunLookbackDays ?? 7) * 86400).toFixed(6)

  let page
  try {
    page = await slack.call('conversations.history', { channel: c.id, oldest, limit: 200 })
  } catch (e) {
    rows.push(row(c, name, type, entry, `unreadable (${e.message.replace(/^slack \S+: /, '')})`, {}))
    continue
  }

  const fresh = page.messages ?? []
  const hasNewTopLevel = fresh.length > 0
  const scanTruncated = fresh.length > SCAN_CAP || !!page.has_more

  // A reply never moves its parent. Reading one message — or even one page —
  // and calling the channel quiet is how a channel whose entire live
  // conversation happens inside a thread reports zero, every day, forever.
  let hasThreadReplies = false
  let grownPeeked = 0
  let newestReplyTs = 0
  const parents = (fresh.length ? fresh : []).concat(await olderParents(c.id, oldest, entry))
  for (const m of parents) {
    if (!m.reply_count) continue
    if (grownPeeked >= GROWN_THREAD_PEEK_CAP) {
      // Out of budget while threads were still growing: this row cannot be
      // called quiet, so say so rather than guess.
      hasThreadReplies = true
      break
    }
    if (threadHasUnread(m, entry.threads?.[m.ts])) {
      hasThreadReplies = true
      grownPeeked++
      newestReplyTs = Math.max(newestReplyTs, Number(m.latest_reply ?? m.ts))
    }
  }

  // ---- signal. This SORTS the table. It never decides whether a row is read.
  let signalScore = 0
  let hits = []
  let mentionsMe = false
  let hasFiles = false
  if (hasNewTopLevel) {
    const scanned = fresh.slice(0, SCAN_CAP)
    const text = scanned.map((m) => renderText(m.text ?? '', users)).join('\n')
    const scored = scoreText(text, signal)
    signalScore = scored.score
    hits = scored.hits
    mentionsMe = scanned.some((m) => (m.text ?? '').includes(`<@${myId}>`))
    hasFiles = scanned.some((m) => (m.files ?? []).length > 0)
  }

  const localStale = await isLocalStale(entry, fingerprints)

  const action = decideAction({
    prior: entry,
    isArchived: false,
    hasNewTopLevel,
    hasThreadReplies,
    scanTruncated,
    localStale,
  })

  const priority = priorityOf({ prior: entry, type, mentionsMe, signalScore, hasFiles })

  const newestTop = fresh.reduce((max, m) => Math.max(max, Number(m.ts)), 0)
  const slackHead = Math.max(newestTop, newestReplyTs)

  if (record) {
    if (isQuiet(action)) {
      // A quiet row is settled: advance the TRIAGE position so it is not
      // re-scanned, and retire any backlog marker.
      if (slackHead) entry.scannedTs = slackHead.toFixed(6)
      else if (!entry.scannedTs) entry.scannedTs = entry.watermarkTs ?? '0'
      delete entry.pendingTs
    } else if (slackHead) {
      // Actionable. `scannedTs` MUST NOT move — advancing it would mark unread
      // content read. Instead record what Slack was holding, because the gap
      // between the two positions is zero by construction on a row like this,
      // and without pendingTs the audit reports a clean board over a real
      // backlog.
      entry.pendingTs = slackHead.toFixed(6)
    }
    manifest.channels[c.id] = entry
  }

  rows.push(
    row(c, name, type, entry, action, {
      newTopLevel: fresh.length,
      threadReplies: hasThreadReplies,
      priority,
      signalScore,
      signalHits: hits,
      mentionsMe,
      scanTruncated,
      slackHead: slackHead ? slackHead.toFixed(6) : null,
    })
  )
}

if (record) saveManifest(dataDir, manifest)

// ---------------------------------------------------------------- output

mkdirSync(join(dataDir, '.cache'), { recursive: true })
const triage = {
  workspace: slug,
  scannedAt: new Date().toISOString(),
  recorded: record,
  notVisible,
  totals: {
    enumerated: convos.length,
    scanned: targets.length,
    actionable: rows.filter((r) => !isQuiet(r.action)).length,
  },
  rows,
}
writeFileSync(join(dataDir, '.cache', 'triage.json'), JSON.stringify(triage, null, 2))

if (asJson) {
  process.stdout.write(JSON.stringify(triage, null, 2) + '\n')
  await finish(0)
} else {
  printTable()
  await finish(0)
}

function printTable() {
const shown = showAll ? rows : rows.filter((r) => !isQuiet(r.action))
const w = Math.max(24, ...shown.map((r) => r.name.length))

console.log(`\n# ${slug} — ${triage.totals.actionable} actionable of ${targets.length} scanned\n`)
if (!shown.length) {
  console.log('  Nothing actionable. Run with --all to see settled rows.')
} else {
  console.log(`  ${'CONVERSATION'.padEnd(w)}  ${'TYPE'.padEnd(9)}  ${'NEW'.padEnd(4)}  ${'PRI'.padEnd(4)}  ACTION`)
  console.log(`  ${'-'.repeat(w)}  ${'-'.repeat(9)}  ${'-'.repeat(4)}  ${'-'.repeat(4)}  ${'-'.repeat(30)}`)
  // Highest priority first — the gate sorts, it does not filter.
  for (const r of shown.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))) {
    const n = r.newTopLevel ? String(r.newTopLevel) : r.threadReplies ? '↳' : '·'
    const pri = isQuiet(r.action) ? '·' : String(r.priority)
    console.log(`  ${r.name.padEnd(w)}  ${r.type.padEnd(9)}  ${n.padEnd(4)}  ${pri.padEnd(4)}  ${r.action}`)
    if (r.mentionsMe) console.log(`  ${' '.repeat(w)}  mentions you`)
    if (r.signalHits?.length) console.log(`  ${' '.repeat(w)}  evidence: ${r.signalHits.join(', ')}`)
    if (r.digest) console.log(`  ${' '.repeat(w)}  ↳ digest: ${r.digest.slice(0, 140)}`)
  }
}

console.log('\n## What this scan could not see')
for (const n of notVisible) console.log(`  • ${n}`)
console.log(
  `\nFull triage: ${join(dataDir, '.cache', 'triage.json')}\n` +
    `Next: node catchup.mjs --workspace ${slug} --unread`
)
}

// ================================================================== helpers

function row(c, name, type, entry, action, extra) {
  return {
    id: c.id,
    name,
    type,
    action,
    mapping: entry.mapping?.kind ?? 'none',
    watermarkTs: entry.watermarkTs ?? '0',
    scannedTs: entry.scannedTs ?? null,
    pendingTs: entry.pendingTs ?? null,
    readAt: entry.readAt ?? null,
    digest: entry.digest ?? null,
    newTopLevel: 0,
    threadReplies: false,
    priority: 0,
    signalScore: 0,
    ...extra,
  }
}

/**
 * Parents older than the scan window that the manifest already knows have
 * threads. Their replies are exactly the content a top-level scan cannot see.
 */
async function olderParents(channelId, oldest, entry) {
  const known = Object.keys(entry.threads ?? {}).filter((ts) => Number(ts) < Number(oldest))
  if (!known.length) return []
  const out = []
  for (const ts of known.slice(-GROWN_THREAD_PEEK_CAP)) {
    try {
      const r = await slack.call('conversations.replies', { channel: channelId, ts, limit: 1 })
      const parent = (r.messages ?? [])[0]
      if (parent) out.push(parent)
    } catch {
      /* deleted parent, or no access — nothing to report */
    }
  }
  return out
}

/**
 * Did the thing this conversation feeds change outside this skill?
 *
 * Entirely optional and entirely opaque: any command whose stdout is stable.
 * `{channel}` and `{targets}` are substituted so one command can serve a whole
 * workspace. A command with no placeholder is run once and its hash shared.
 */
async function isLocalStale(entry, cache) {
  const cmd = config.fingerprintCommand
  if (!cmd || entry.mapping?.kind !== 'track') return false

  const targets = (entry.mapping.targets ?? []).join(',')
  const resolved = cmd.replace('{channel}', entry.name ?? '').replace('{targets}', targets)
  if (cache.has(resolved)) return cache.get(resolved) !== (entry.fingerprint ?? '')

  let hash = ''
  try {
    const out = execSync(resolved, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 })
    hash = 'sha256:' + createHash('sha256').update(out).digest('hex').slice(0, 32)
  } catch (e) {
    // A broken fingerprint command must not make every row look stale, and must
    // not make every row look fresh either. Say it broke, and report not-stale.
    note(`  fingerprintCommand failed (${e.message.split('\n')[0]}) — treating as unchanged`)
    return false
  }
  cache.set(resolved, hash)
  return hash !== (entry.fingerprint ?? '')
}
