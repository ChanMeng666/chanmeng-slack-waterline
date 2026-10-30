// Offline assertions on every read-state rule. No network, no fixtures, ~1s.
//
//   node --test skills/chanmeng-slack-waterline/scripts/lib/
//
// Each test names the miss it prevents. If one starts failing, a message is
// about to go unread — do not adjust the expectation to match the code.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  threadHasUnread,
  mergeThreadState,
  deliveredPosition,
  decideAction,
  isQuiet,
  shouldInheritMapping,
  normalizeMapping,
  auditManifest,
  priorityOf,
  saveManifest,
  loadManifest,
  emptyChannel,
} from './state.mjs'

// ---------------------------------------------------------------- threadHasUnread

test('threadHasUnread: an absent record means zero replies seen, not "skip"', () => {
  // The most common case in the whole system. A message posted with no replies
  // is never written to `threads`, so its FIRST reply lands on a parent the
  // manifest has never heard of. Requiring a prior record made that invisible.
  assert.equal(threadHasUnread({ reply_count: 1, latest_reply: '100.5' }, undefined), true)
})

test('threadHasUnread: a thread with no replies is never unread', () => {
  assert.equal(threadHasUnread({ reply_count: 0 }, undefined), false)
  assert.equal(threadHasUnread({}, undefined), false)
})

test('threadHasUnread: a thread that gains one reply and loses another holds its count', () => {
  // replyCount is identical; only latest_reply moved. Checking the count alone
  // reports this thread as fully read.
  const known = { replyCount: 3, latestReplyTs: '100.000000' }
  assert.equal(threadHasUnread({ reply_count: 3, latest_reply: '250.000000' }, known), true)
})

test('threadHasUnread: a fully-read thread is quiet', () => {
  const known = { replyCount: 3, latestReplyTs: '250.000000' }
  assert.equal(threadHasUnread({ reply_count: 3, latest_reply: '250.000000' }, known), false)
})

test('threadHasUnread: accepts stored-shape keys as well as Slack API keys', () => {
  assert.equal(threadHasUnread({ replyCount: 2, latestReplyTs: '9' }, { replyCount: 1, latestReplyTs: '5' }), true)
})

// ---------------------------------------------------------------- mergeThreadState

test('mergeThreadState: a delivered thread advances', () => {
  const parents = [{ ts: '100', reply_count: 4, latest_reply: '180' }]
  const merged = mergeThreadState(parents, new Set(['100']), {})
  assert.deepEqual(merged, { 100: { replyCount: 4, latestReplyTs: '180' } })
})

test('mergeThreadState: an UNDELIVERED thread keeps what it had', () => {
  // The bug that erased its own evidence. The payload was built, the reader
  // never saw it, and the receipt claimed it was read — so the next run had
  // nothing left to find.
  const parents = [{ ts: '100', reply_count: 9, latest_reply: '900' }]
  const prior = { 100: { replyCount: 2, latestReplyTs: '150' } }
  const merged = mergeThreadState(parents, new Set(), prior)
  assert.deepEqual(merged, { 100: { replyCount: 2, latestReplyTs: '150' } })
})

test('mergeThreadState: an undelivered thread with no prior record stays absent', () => {
  // It must stay absent rather than be invented, so threadHasUnread's
  // "absent means zero seen" rule catches it next run.
  const merged = mergeThreadState([{ ts: '100', reply_count: 3, latest_reply: '300' }], new Set(), {})
  assert.deepEqual(merged, {})
})

test('mergeThreadState: a delivered parent with zero replies is not recorded as a thread', () => {
  const merged = mergeThreadState([{ ts: '100', reply_count: 0 }], new Set(['100']), {})
  assert.deepEqual(merged, {})
})

test('mergeThreadState: prior threads untouched by this delivery survive', () => {
  const prior = { 50: { replyCount: 1, latestReplyTs: '60' } }
  const merged = mergeThreadState([{ ts: '100', reply_count: 2, latest_reply: '120' }], new Set(['100']), prior)
  assert.deepEqual(merged, {
    50: { replyCount: 1, latestReplyTs: '60' },
    100: { replyCount: 2, latestReplyTs: '120' },
  })
})

// ---------------------------------------------------------------- deliveredPosition

test('deliveredPosition: a reply ts counts, because a reply never moves its parent', () => {
  // pendingTs is frequently a reply ts. Comparing it against watermarkTs alone
  // could never retire it, and channels sat permanently red in the audit.
  const threads = { 100: { replyCount: 2, latestReplyTs: '900.000500' } }
  assert.equal(deliveredPosition('500.000000', threads), 900.0005)
})

test('deliveredPosition: falls back to the top-level watermark', () => {
  assert.equal(deliveredPosition('500.000000', {}), 500)
  assert.equal(deliveredPosition(undefined, {}), 0)
})

// ---------------------------------------------------------------- decideAction

test('decideAction: a local condition never masks a remote one', () => {
  // Both facts must survive into the label, or a channel holding unread
  // messages is indistinguishable from one that merely changed out of band.
  const action = decideAction({
    prior: { mapping: { kind: 'track' } },
    hasNewTopLevel: true,
    localStale: true,
  })
  assert.equal(action, 'incremental + local-stale')
})

test('decideAction: thread-only activity is labelled as such', () => {
  // Checking this channel by eye shows no new message. You have to open a thread.
  const action = decideAction({
    prior: { mapping: { kind: 'track' } },
    hasNewTopLevel: false,
    hasThreadReplies: true,
  })
  assert.equal(action, 'incremental (thread replies)')
})

test('decideAction: a truncated scan can never be quiet', () => {
  const action = decideAction({
    prior: { mapping: { kind: 'none' } },
    hasNewTopLevel: true,
    scanTruncated: true,
  })
  assert.equal(action, 'read in full (scan truncated)')
  assert.equal(isQuiet(action), false)
})

test('decideAction: a LOW SCORE NEVER MAKES A ROW QUIET', () => {
  // The signal gate decides priority, never whether something is read. Letting a
  // below-threshold score return `no-op` advances the triage position past
  // unread messages, so a quiet channel that finally says something important is
  // marked settled without anybody seeing it.
  const action = decideAction({ prior: { mapping: { kind: 'none' } }, hasNewTopLevel: true })
  assert.equal(action, 'read')
  assert.equal(isQuiet(action), false)
})

test('decideAction: no new content is the only thing that makes a row quiet', () => {
  const action = decideAction({ prior: { mapping: { kind: 'none' } }, hasNewTopLevel: false })
  assert.equal(action, 'no-op')
  assert.equal(isQuiet(action), true)
})

test('priorityOf: a direct message outranks any keyword score', () => {
  // Somebody addressed you personally. No amount of scoring makes that untrue.
  const dm = priorityOf({ type: 'dm', signalScore: 0 })
  const chatty = priorityOf({ type: 'channel', signalScore: 4 })
  assert.ok(dm > chatty, `dm ${dm} should outrank channel ${chatty}`)
})

test('priorityOf: alwaysRead and a mention both lift a zero-scoring row', () => {
  assert.ok(priorityOf({ type: 'channel', signalScore: 0, mentionsMe: true }) > 0)
  assert.ok(priorityOf({ type: 'channel', prior: { mapping: { alwaysRead: true } } }) > 0)
})

test('decideAction: a skip is sticky but new activity still surfaces once', () => {
  const prior = { mapping: { kind: 'skip', reason: 'CI firehose' } }
  assert.equal(decideAction({ prior, hasNewTopLevel: false }), 'skip')
  assert.equal(decideAction({ prior, hasNewTopLevel: true }), 'skip→review (new msgs)')
})

test('decideAction: archived wins over everything', () => {
  const action = decideAction({
    prior: { mapping: { kind: 'track' } },
    isArchived: true,
    hasNewTopLevel: true,
  })
  assert.equal(action, 'archived')
})

test('isQuiet: only settled rows are quiet', () => {
  assert.equal(isQuiet('no-op'), true)
  assert.equal(isQuiet('archived'), true)
  assert.equal(isQuiet('skip'), true)
  assert.equal(isQuiet('skip→review (new msgs)'), false)
  assert.equal(isQuiet('incremental'), false)
  assert.equal(isQuiet('local-stale'), false)
})

// ---------------------------------------------------------------- mapping

test('shouldInheritMapping: omitting --mapping keeps targets and alwaysRead', () => {
  // It used to default to `none`, which silently deleted a channel's mapping
  // every time somebody recorded a routine read.
  const prev = { mapping: { kind: 'track', targets: ['x'], alwaysRead: true } }
  assert.equal(shouldInheritMapping(prev, undefined), true)
  assert.equal(shouldInheritMapping(prev, 'none'), false)
  assert.equal(shouldInheritMapping(undefined, undefined), false)
})

test('normalizeMapping: unknown kinds collapse to none, flags survive', () => {
  assert.deepEqual(normalizeMapping({ kind: 'nonsense' }), { kind: 'none' })
  assert.deepEqual(normalizeMapping({ kind: 'track', targets: ['a'], alwaysRead: true }), {
    kind: 'track',
    targets: ['a'],
    alwaysRead: true,
  })
  assert.deepEqual(normalizeMapping(undefined), { kind: 'none' })
})

// ---------------------------------------------------------------- audit

test('auditManifest: an absent readAt is never-read, even with a watermark set', () => {
  // A bulk registration can set a watermark without anybody reading a word.
  const findings = auditManifest({
    channels: { C1: { name: 'c', watermarkTs: '900.0', scannedTs: '900.0', threads: {} } },
  })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].kind, 'never-read')
})

test('auditManifest: no scannedTs means the backlog is unknown, not zero', () => {
  const findings = auditManifest({
    channels: { C1: { name: 'c', watermarkTs: '900.0', readAt: '2026-01-01T00:00:00Z', threads: {} } },
  })
  assert.equal(findings[0].kind, 'never-triaged')
})

test('auditManifest: pendingTs beyond the delivered position is a backlog', () => {
  const findings = auditManifest({
    channels: {
      C1: {
        name: 'c',
        watermarkTs: '500.0',
        scannedTs: '500.0',
        pendingTs: '900.0',
        readAt: '2026-01-01T00:00:00Z',
        threads: {},
      },
    },
  })
  assert.equal(findings[0].kind, 'behind')
})

test('auditManifest: a pendingTs already covered by a thread reply is retired', () => {
  const findings = auditManifest({
    channels: {
      C1: {
        name: 'c',
        watermarkTs: '500.0',
        scannedTs: '500.0',
        pendingTs: '900.0',
        readAt: '2026-01-01T00:00:00Z',
        threads: { 400: { replyCount: 2, latestReplyTs: '950.0' } },
      },
    },
  })
  assert.deepEqual(findings, [])
})

test('auditManifest: a settled skip is behind by design and must not cry wolf', () => {
  const findings = auditManifest({
    channels: {
      C1: { name: 'ci-bot', mapping: { kind: 'skip', reason: 'firehose' }, watermarkTs: '0', threads: {} },
    },
  })
  assert.deepEqual(findings, [])
})

test('auditManifest: an always-read skip is still audited', () => {
  const findings = auditManifest({
    channels: {
      C1: { name: 'x', mapping: { kind: 'skip', alwaysRead: true }, watermarkTs: '0', threads: {} },
    },
  })
  assert.equal(findings[0].kind, 'never-read')
})

// ---------------------------------------------------------------- serialization

test('saveManifest: output is deterministic and omits unset optional fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'waterline-'))
  try {
    const manifest = {
      version: 1,
      channels: {
        C2: { ...emptyChannel('beta'), watermarkTs: '2.0' },
        C1: { ...emptyChannel('alpha'), watermarkTs: '1.0', threads: { 9: { replyCount: 1, latestReplyTs: '9.5' }, 3: { replyCount: 2, latestReplyTs: '4' } } },
      },
    }
    saveManifest(dir, manifest)
    const first = readFileSync(join(dir, 'state.json'), 'utf8')

    // Channels sorted by id, threads sorted numerically, no digest/readAt keys.
    assert.match(first, /"C1"[\s\S]*"C2"/)
    assert.match(first, /"3":[\s\S]*"9":/)
    assert.equal(first.includes('"digest"'), false)
    assert.equal(first.includes('"readAt"'), false)

    // A round-trip must be byte-stable, or every run produces a git diff.
    saveManifest(dir, loadManifest(dir))
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), first)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
