// The read-state manifest: what has been read, what has merely been scored, and
// what Slack is still holding.
//
// This file is the whole intellectual content of the skill. Everything else
// fetches bytes. Read `references/read-state.md` before changing anything here —
// every rule below is a real message that went unread, and the comment says
// which.
//
// THE ONE INVARIANT, from which the rest follows:
//
//   A READ RECEIPT MAY ONLY DESCRIBE WHAT WAS DELIVERED, NEVER WHAT EXISTS.
//
// Recording "the current state of the channel" when a payload was built but not
// shown turns a recoverable miss into a permanent silent loss: the next run has
// nothing left to find.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

export const MANIFEST_VERSION = 1

// ---------------------------------------------------------------- load / save

export function manifestPath(dataDir) {
  return join(dataDir, 'state.json')
}

export function loadManifest(dataDir) {
  const path = manifestPath(dataDir)
  if (!existsSync(path)) return { version: MANIFEST_VERSION, channels: {} }
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  return { version: raw.version ?? MANIFEST_VERSION, channels: raw.channels ?? {} }
}

/**
 * Field order is fixed and conditional fields are emitted only when set, so an
 * entry that never had a `digest` stays byte-identical across runs. A manifest
 * that reorders itself produces a git diff on every write, and a diff nobody can
 * read is a diff nobody checks.
 *
 * Written to a temp file and renamed. A half-written manifest is worse than no
 * manifest: it claims things were read.
 */
export function saveManifest(dataDir, manifest) {
  const out = { version: manifest.version ?? MANIFEST_VERSION, channels: {} }

  for (const id of Object.keys(manifest.channels).sort()) {
    const c = manifest.channels[id]
    const entry = {
      name: c.name ?? '',
      type: c.type ?? 'channel',
      mapping: normalizeMapping(c.mapping),
      watermarkTs: c.watermarkTs ?? '0',
      threads: sortThreads(c.threads),
    }
    // Conditional — present only when meaningful.
    if (c.scannedTs) entry.scannedTs = c.scannedTs
    if (c.pendingTs) entry.pendingTs = c.pendingTs
    if (c.readAt) entry.readAt = c.readAt
    if (c.readAtSource) entry.readAtSource = c.readAtSource
    if (c.fingerprint) entry.fingerprint = c.fingerprint
    if (c.digest) entry.digest = c.digest
    if (c.digestAt) entry.digestAt = c.digestAt
    if (c.lastSyncedAt) entry.lastSyncedAt = c.lastSyncedAt
    out.channels[id] = entry
  }

  const path = manifestPath(dataDir)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n')
  renameSync(tmp, path)
  return out
}

function sortThreads(threads) {
  const sorted = {}
  for (const ts of Object.keys(threads ?? {}).sort((a, b) => Number(a) - Number(b))) {
    const t = threads[ts]
    sorted[ts] = { replyCount: t.replyCount ?? 0, latestReplyTs: t.latestReplyTs ?? '0' }
  }
  return sorted
}

export function emptyChannel(name = '', type = 'channel') {
  return { name, type, mapping: { kind: 'none' }, watermarkTs: '0', threads: {} }
}

// ---------------------------------------------------------------- mapping

/**
 * A channel's mapping says what it feeds, if anything.
 *
 *   track — this conversation matters; read it and act on it
 *   skip  — deliberately not read (a bot firehose, a dead channel). Sticky.
 *   none  — enumerated, no decision yet
 *
 * `targets` is opaque to this skill. It is whatever the workspace's own config
 * wants to associate — a slug, a doc id, a project key. Keeping it untyped is
 * what makes the engine reusable across orgs.
 */
export function normalizeMapping(m) {
  const kind = m?.kind === 'track' || m?.kind === 'skip' ? m.kind : 'none'
  const out = { kind }
  if (m?.targets?.length) out.targets = m.targets
  if (m?.reason) out.reason = m.reason
  if (m?.alwaysRead) out.alwaysRead = true
  return out
}

/**
 * Omitting `--mapping` INHERITS the existing one.
 *
 * Recording a read is not a statement about mapping. This used to default to
 * `none`, which silently deleted a channel's targets and its `alwaysRead` flag
 * every time somebody recorded a routine read.
 */
export function shouldInheritMapping(prev, explicitKind) {
  return explicitKind === undefined && !!prev?.mapping
}

/**
 * `alwaysRead` separates two questions that look alike: "is this worth opening?"
 * and "does this feed an output?". A DM from someone who sends actual work must
 * be read even when it scores zero on every keyword — the signal gate decides
 * PRIORITY, never whether something is read.
 */
export function isAlwaysRead(state) {
  return !!state?.mapping?.alwaysRead
}

// ---------------------------------------------------------------- thread state

/**
 * Has this thread gained replies we have not seen?
 *
 * TWO RULES, EACH A REAL MISS:
 *
 * 1. An absent `known` means ZERO REPLIES SEEN, not "skip". A message posted
 *    with no replies is never written to `threads`, so the FIRST reply it ever
 *    gets lands on a parent the manifest has never heard of — which is the most
 *    common case, and was invisible while this required a prior record.
 *
 * 2. `latestReplyTs` is checked as well as `replyCount`, because a thread that
 *    gains one reply and loses another holds its count exactly.
 */
export function threadHasUnread(current, known) {
  const replies = current?.reply_count ?? current?.replyCount ?? 0
  if (replies <= 0) return false
  const latest = Number(current?.latest_reply ?? current?.latestReplyTs ?? 0)
  return replies > (known?.replyCount ?? 0) || latest > Number(known?.latestReplyTs ?? 0)
}

/**
 * Merge thread facts into the stored state after a delivery.
 *
 * A DELIVERED thread advances. An UNDELIVERED one keeps whatever it had,
 * possibly nothing.
 *
 * Never widen this to "the current state of everything". The earlier version
 * built its map from the full history before the emit loop, so it recorded
 * threads nobody had been shown as read. That is the difference between a bug
 * that gets caught on the next run and one that erases its own evidence.
 *
 * @param parents  [{ ts, reply_count, latest_reply }] as seen right now
 * @param delivered Set<ts> of parents whose new replies actually reached a reader
 * @param prior    the stored `threads` map
 */
export function mergeThreadState(parents, delivered, prior = {}) {
  const merged = {}
  for (const [ts, t] of Object.entries(prior)) {
    merged[ts] = { replyCount: t.replyCount ?? 0, latestReplyTs: t.latestReplyTs ?? '0' }
  }
  for (const p of parents) {
    if (!delivered.has(p.ts)) continue
    const replies = p.reply_count ?? p.replyCount ?? 0
    if (replies <= 0) continue
    merged[p.ts] = {
      replyCount: replies,
      latestReplyTs: String(p.latest_reply ?? p.latestReplyTs ?? p.ts),
    }
  }
  return sortThreads(merged)
}

/**
 * How far this conversation has actually been read, threads included.
 *
 * A reply never moves its parent, so the top-level watermark alone understates
 * the position. `pendingTs` is frequently a REPLY ts, which means comparing it
 * against `watermarkTs` on its own could never retire it — and two live channels
 * sat permanently red in the audit because of exactly that.
 */
export function deliveredPosition(watermarkTs, threads = {}) {
  let max = Number(watermarkTs ?? 0)
  for (const t of Object.values(threads)) max = Math.max(max, Number(t.latestReplyTs ?? 0))
  return max
}

// ---------------------------------------------------------------- triage decision

/**
 * What should happen to this conversation?
 *
 * A LOCAL CONDITION NEVER MASKS A REMOTE ONE. These are different questions —
 * "Slack is holding unread content" and "the thing this feeds changed out of
 * band" — and a row can be either, both, or neither. An earlier version returned
 * on the local condition first, so on one run every tracked channel printed
 * `local-stale`, and the two holding thirteen and fourteen unread messages were
 * indistinguishable from the eight that held nothing.
 */
export function decideAction(input) {
  const {
    prior,
    isArchived = false,
    hasNewTopLevel = false,
    hasThreadReplies = false,
    scanTruncated = false,
    localStale = false,
  } = input

  if (isArchived) return 'archived'

  const kind = prior?.mapping?.kind ?? 'none'
  const hasNew = hasNewTopLevel || hasThreadReplies

  // A skip is sticky — somebody decided this conversation is not worth reading —
  // but new activity is still worth one line of your attention.
  if (kind === 'skip') return hasNew ? 'skip→review (new msgs)' : 'skip'

  let remote = null
  if (hasNew && scanTruncated) {
    // A truncated scan cannot conclude anything, INCLUDING "nothing here".
    remote = 'read in full (scan truncated)'
  } else if (hasNewTopLevel) {
    remote = kind === 'track' ? 'incremental' : 'read'
  } else if (hasThreadReplies) {
    // Checking this conversation by eye shows no new message. Open the thread.
    remote = kind === 'track' ? 'incremental (thread replies)' : 'read (thread replies)'
  }

  const local = localStale ? 'local-stale' : null

  if (remote && local) return `${remote} + ${local}`
  if (remote) return remote
  if (local) return local
  return 'no-op'
}

/**
 * How much this row wants your attention. NOT whether it gets read.
 *
 * THE SIGNAL GATE DECIDES PRIORITY, NEVER WHETHER SOMETHING IS READ. An earlier
 * version of this let a below-threshold score return `no-op`, which advanced the
 * triage position past unread messages — so a low-chatter channel that finally
 * said something important was marked settled without anybody seeing it. Scoring
 * now only sorts the table.
 *
 * A direct message outranks any keyword: somebody addressed you personally, and
 * no amount of scoring makes that not true.
 */
export function priorityOf({ prior, type, mentionsMe = false, signalScore = 0, hasFiles = false }) {
  let p = signalScore ?? 0
  if (type === 'dm' || type === 'group-dm') p += 5
  if (mentionsMe) p += 4
  if (isAlwaysRead(prior)) p += 5
  if (hasFiles) p += 1
  return p
}

/**
 * A quiet row is a SETTLED one — nothing here needs a human or a model.
 *
 * Only a quiet row may advance `scannedTs`. Advancing it on an actionable row
 * would mark unread content read, which is the failure this whole file exists
 * to prevent.
 */
export function isQuiet(action) {
  return action === 'no-op' || action === 'archived' || action === 'skip'
}

// ---------------------------------------------------------------- the audit

/**
 * The backlog, measured against the record.
 *
 * THE MANIFEST CANNOT TELL YOU WHAT IS MISSING FROM THE MANIFEST. Every gate
 * built on this iterates its key set, so a conversation nobody ever enumerated
 * is invisible to all of them at once. That is not a bug in any of them; it is
 * the shape of the question. `coverage.mjs --enumerate-only` asks the other one.
 *
 * Three failure classes, because they need different fixes:
 *
 *   never-read     enumerated, never delivered to a reader. An absent `readAt`
 *                  is NOT the same as `watermarkTs: "0"` — a bulk registration
 *                  can set a watermark without anybody having read a word.
 *   never-triaged  no `scannedTs`, so the backlog is UNKNOWN, not zero.
 *   behind         Slack held content the triage could not clear, and the
 *                  delivered position has still not reached it.
 */
export function auditManifest(manifest) {
  const findings = []

  for (const [id, c] of Object.entries(manifest.channels)) {
    const kind = c.mapping?.kind ?? 'none'

    // A settled skip is permanently behind BY DESIGN — a bot firehose, a dead
    // channel. Counting it makes the gate cry wolf, which is the one failure
    // mode a gate cannot survive.
    if (kind === 'skip' && !c.mapping?.alwaysRead) continue

    const label = `${c.name || id} [${id}]`

    if (!c.readAt) {
      findings.push({
        id,
        label,
        kind: 'never-read',
        detail: c.readAtSource ? `recorded without a delivery: ${c.readAtSource}` : 'no payload has ever been delivered',
        remedy: `fetch.mjs ${id} --state --out tmp/${id}.json && render.mjs tmp/${id}.json`,
      })
      continue
    }

    if (!c.scannedTs) {
      findings.push({
        id,
        label,
        kind: 'never-triaged',
        detail: 'never scored — the backlog here is unknown, not zero',
        remedy: 'discover.mjs --all',
      })
      continue
    }

    const delivered = deliveredPosition(c.watermarkTs, c.threads)
    if (c.pendingTs && Number(c.pendingTs) > delivered) {
      findings.push({
        id,
        label,
        kind: 'behind',
        detail: `Slack held ${c.pendingTs}, delivered position is ${delivered.toFixed(6)}`,
        remedy: `fetch.mjs ${id} --state --out tmp/${id}.json && render.mjs tmp/${id}.json`,
      })
    }
  }

  return findings
}
