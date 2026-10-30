#!/usr/bin/env node
// Record that a payload was READ. The only writer of `watermarkTs` and `readAt`.
//
//   node record.mjs --from tmp/general.json --digest "Sprint scope settled; …"
//   node record.mjs --from tmp/general.json --digest-file notes.md
//   node record.mjs --channel C0ABC --mapping skip --reason "CI firehose"
//   node record.mjs --batch calls.json
//
// ONLY RUN THIS FOR CONTENT THAT ACTUALLY REACHED A READER. A payload that was
// fetched and never read is not read. Recording it anyway is not a small
// bookkeeping error — it is the one mistake this whole design exists to prevent,
// because the next run then has nothing left to find.

import { readFileSync, existsSync } from 'node:fs'

import { note, fail } from './lib/slack.mjs'
import { resolveWorkspace, argValue, hasFlag } from './lib/config.mjs'
import {
  loadManifest,
  saveManifest,
  emptyChannel,
  normalizeMapping,
  shouldInheritMapping,
  mergeThreadState,
  deliveredPosition,
} from './lib/state.mjs'

const argv = process.argv.slice(2)
const { dataDir } = resolveWorkspace(argv)

// ---------------------------------------------------------------- batch

const batchFile = argValue(argv, 'batch')
if (batchFile) {
  // A batch is a JSON array of argv arrays. It exists because reasons and
  // digests are prose — they carry apostrophes, quotes and newlines — and
  // PowerShell doubles a quote where bash does not. Round-tripping forty of
  // them through a shell mangles them silently.
  const calls = JSON.parse(readFileSync(batchFile, 'utf8'))
  if (!Array.isArray(calls)) fail('--batch expects a JSON array of argv arrays.')
  const manifest = loadManifest(dataDir)
  for (const call of calls) applyOne(manifest, call)
  saveManifest(dataDir, manifest)
  note(`recorded ${calls.length} entries`)
  process.exit(0)
}

const manifest = loadManifest(dataDir)
applyOne(manifest, argv)
saveManifest(dataDir, manifest)

// ================================================================== apply

function applyOne(manifest, args) {
  const from = argValue(args, 'from')
  const explicitChannel = argValue(args, 'channel')

  if (!from && !explicitChannel) {
    fail(
      'Usage: node record.mjs --from <payload.json> [--digest "…"] [--read-source "…"]\n' +
        '       node record.mjs --channel <ID> [--mapping track|skip|none] [--reason "…"]\n' +
        '       node record.mjs --batch <calls.json>'
    )
  }

  let payload = null
  let id = explicitChannel
  if (from) {
    if (!existsSync(from)) fail(`No such payload: ${from}`)
    payload = JSON.parse(readFileSync(from, 'utf8'))
    id = payload.channel?.id
    if (!id) fail(`${from} has no channel.id — is it a fetch.mjs payload?`)
  }

  const prior = manifest.channels[id]
  const entry = prior ? { ...prior } : emptyChannel()

  if (payload) {
    entry.name = payload.channel.name ?? entry.name
    entry.type = payload.channel.type ?? entry.type
  }
  if (argValue(args, 'name')) entry.name = argValue(args, 'name')
  if (argValue(args, 'type')) entry.type = argValue(args, 'type')

  // ---- mapping. Omitting --mapping INHERITS; it must never silently clear.
  const mappingKind = argValue(args, 'mapping')
  if (!shouldInheritMapping(prior, mappingKind)) {
    const m = { kind: mappingKind ?? 'none' }
    const targets = argValue(args, 'targets')
    if (targets) m.targets = targets.split(',').map((s) => s.trim()).filter(Boolean)
    const reason = readValue(args, 'reason')
    if (reason) m.reason = reason
    if (prior?.mapping?.alwaysRead) m.alwaysRead = true
    entry.mapping = normalizeMapping(m)
  } else {
    entry.mapping = normalizeMapping(prior.mapping)
    const reason = readValue(args, 'reason')
    if (reason) entry.mapping.reason = reason
    const targets = argValue(args, 'targets')
    if (targets) entry.mapping.targets = targets.split(',').map((s) => s.trim()).filter(Boolean)
  }

  if (hasFlag(args, 'always-read')) entry.mapping.alwaysRead = true
  if (hasFlag(args, 'no-always-read')) delete entry.mapping.alwaysRead

  // ---- the read position
  if (payload) {
    const wm = payload._meta?.newWatermarkTs
    if (wm && Number(wm) > Number(entry.watermarkTs ?? 0)) entry.watermarkTs = wm

    // Merge only what the payload says it DELIVERED.
    const facts = Object.entries(payload._meta?.threadState ?? {}).map(([ts, t]) => ({
      ts,
      reply_count: t.replyCount,
      latest_reply: t.latestReplyTs,
    }))
    entry.threads = mergeThreadState(facts, new Set(facts.map((f) => f.ts)), entry.threads ?? {})

    entry.readAt = new Date().toISOString()
    const source = readValue(args, 'read-source')
    // A caveat NARROWS the claim. An unqualified readAt says a human or a model
    // actually looked at this content; anything less must say so here.
    if (source) entry.readAtSource = source
    else delete entry.readAtSource

    entry.lastSyncedAt = entry.readAt
  } else {
    const wm = argValue(args, 'watermark')
    if (wm) entry.watermarkTs = wm
    const source = readValue(args, 'read-source')
    if (source) {
      entry.readAt = new Date().toISOString()
      entry.readAtSource = source
    }
  }

  // ---- the backlog marker retires once the delivered position reaches it
  if (entry.pendingTs && deliveredPosition(entry.watermarkTs, entry.threads) >= Number(entry.pendingTs)) {
    delete entry.pendingTs
  }

  // ---- the sediment
  const digest = readValue(args, 'digest')
  if (digest !== undefined) {
    if (digest === '') {
      delete entry.digest
      delete entry.digestAt
    } else {
      entry.digest = digest
      entry.digestAt = new Date().toISOString()
    }
  }

  const fingerprint = argValue(args, 'fingerprint')
  if (fingerprint) entry.fingerprint = fingerprint

  manifest.channels[id] = entry

  const label = `${entry.name || id} [${id}]`
  note(
    `recorded ${label}: watermark=${entry.watermarkTs}` +
      ` threads=${Object.keys(entry.threads ?? {}).length}` +
      ` mapping=${entry.mapping.kind}` +
      (entry.pendingTs ? ` pending=${entry.pendingTs}` : '') +
      (entry.digest ? ' +digest' : '')
  )
}

/**
 * A value that may come from a flag or from a file.
 *
 * `--digest-file` is not a convenience. Prose carries quotes and newlines, and
 * quoting rules differ between the shells this runs under; a file has no
 * quoting rules at all.
 */
function readValue(args, name) {
  const file = argValue(args, `${name}-file`)
  if (file) {
    if (!existsSync(file)) fail(`No such file: ${file}`)
    return readFileSync(file, 'utf8').trim()
  }
  const i = args.indexOf(`--${name}`)
  if (i === -1) return undefined
  const v = args[i + 1]
  // `--digest ""` is a deliberate clear; `--digest` with nothing after it is not.
  if (v === undefined || v.startsWith('--')) return undefined
  return v
}
