#!/usr/bin/env node
// Render a payload for a reader. THE canonical way to look at a fetch result.
//
//   node render.mjs tmp/general.json
//   node render.mjs tmp/*.json          # several at once
//
// Never `head`/`tail`/`jq` a payload to see what is in it. Those give you a
// prefix of a JSON file, which is not the same thing as a prefix of the
// conversation, and they silently drop thread replies.
//
// Individual message text is clipped. THE SET OF MESSAGES IS NEVER TRIMMED —
// you cannot miss a message by capping output.

import { readFileSync, existsSync } from 'node:fs'

import { fail } from './lib/slack.mjs'
import { positionals, argValue, resolveWorkspace } from './lib/config.mjs'
import { renderText, fmtTime, googleDocId } from './lib/markup.mjs'

const TEXT_CLIP = 600

const argv = process.argv.slice(2)
const files = positionals(argv, ['workspace', 'w', 'clip'])
if (!files.length) fail('Usage: node render.mjs <payload.json> [more.json …]')

const clip = Number(argValue(argv, 'clip', TEXT_CLIP))
let timezone = 'UTC'
try {
  timezone = resolveWorkspace(argv).config.timezone
} catch {
  // Rendering must work on a payload alone, with no workspace registered.
}

for (const [i, file] of files.entries()) {
  if (i) console.log('\n' + '='.repeat(78) + '\n')
  renderFile(file)
}

function renderFile(file) {
  if (!existsSync(file)) fail(`No such payload: ${file}`)
  const raw = readFileSync(file, 'utf8')

  // A payload with a log line wedged into it parses as nothing at all. Say so
  // plainly, because the symptom otherwise looks like a network failure.
  let p
  try {
    p = JSON.parse(raw)
  } catch (e) {
    const firstLine = raw.split('\n', 1)[0].slice(0, 120)
    fail(
      `${file} is not valid JSON (${e.message}).\n` +
        `  First line: ${firstLine}\n` +
        '  If that looks like a log line, something wrote diagnostics to stdout.\n' +
        '  Refetch with --out instead of a shell redirect.'
    )
  }

  const m = p._meta ?? {}
  const ch = p.channel ?? {}
  const users = p.users ?? {}

  console.log(`# ${ch.name ?? '?'}  [${ch.id ?? '?'}]  (${ch.type ?? '?'})`)
  console.log(
    `_meta: mode=${m.mode} since=${m.since ?? 'none'} new=${m.newCount} ` +
      `watermark→${m.newWatermarkTs} fetched=${m.fetchedAt ?? '?'}`
  )
  if (ch.purpose) console.log(`purpose: ${ch.purpose}`)
  if (ch.topic) console.log(`topic: ${ch.topic}`)
  if (ch.is_archived) console.log('⚠ ARCHIVED')

  if (m.priorDigest) {
    console.log(`\n## PRIOR DIGEST — what was understood last time\n${m.priorDigest}`)
  }

  // ---- canonical content first
  if (p.pinned?.length) {
    console.log(`\n## PINNED (${p.pinned.length}) — canonical, not incremental`)
    for (const msg of p.pinned) console.log(line(msg, users, '  '))
  }

  if (p.bookmarks?.length) {
    console.log(`\n## BOOKMARKS (${p.bookmarks.length})`)
    for (const b of p.bookmarks) console.log(`  • ${b.emoji ?? ''} ${b.title} — ${b.link}`)
  }

  // ---- documents outrank the chat
  const docs = collectDocs(p)
  if (docs.length) {
    console.log(`\n## RUN SHEETS & DOCS (${docs.length}) — READ THESE, THEY OUTRANK THE CHAT`)
    for (const d of docs) {
      console.log(`  • ${d.url}`)
      console.log(`      ${d.where}, referenced ${d.count}×`)
      if (d.kind === 'spreadsheets') {
        console.log(`      node fetch-sheet.mjs '${d.url}'`)
      } else if (d.kind === 'document' || d.kind === 'presentation') {
        console.log(`      (Google ${d.kind === 'document' ? 'Doc' : 'Slides'} — open it, there is no CSV export)`)
      } else {
        console.log('      (Drive item — open it)')
      }
    }
  }

  // ---- the delta
  const msgs = p.messages ?? []
  if (!msgs.length) {
    console.log('\n## NEW MESSAGES (0)')
    console.log(
      '\n  Nothing past the watermark at the top level.\n' +
        '  If you expected something: a reply on an old thread does not move its\n' +
        '  parent. This payload checked for that, but only back to ' +
        `${m.threadScanFloor ?? 'the fetch window'}.\n` +
        '  Re-run with --full to be certain.'
    )
    return
  }

  console.log(`\n## NEW MESSAGES (${msgs.length})`)
  for (const msg of msgs) {
    console.log(`\n--- ${msg.iso}${msg.thread_only ? '   [thread-only: parent is older than the watermark]' : ''}`)
    console.log(line(msg, users, ''))
    for (const r of msg.thread ?? []) {
      console.log(line(r, users, '   ↳ '))
    }
  }
}

function line(msg, users, indent) {
  const when = fmtTime(msg.ts, timezone)
  const who = msg.user_name || nameOf(users, msg.user_id)
  const body = clipText(renderText(msg.text, users))
  const parts = [`${indent}**${who}** · ${when}`]

  const meta = []
  if (msg.reactions?.length) {
    meta.push(msg.reactions.map((r) => `:${r.name}:×${r.count}`).join(' '))
  }
  if (msg.files?.length) {
    meta.push(msg.files.map((f) => `[file: ${f.name} (${f.filetype}, ${kb(f.size)})]`).join(' '))
  }
  if (meta.length) parts[0] += `   ${meta.join('   ')}`

  const text = body || '_(no text)_'
  parts.push(
    text
      .split('\n')
      .map((l) => `${indent}${l}`)
      .join('\n')
  )
  return parts.join('\n')
}

function nameOf(users, id) {
  const u = users[id]
  return (typeof u === 'string' ? u : u?.name) ?? id ?? 'unknown'
}

function clipText(t) {
  if (t.length <= clip) return t
  return t.slice(0, clip) + `… [clipped, ${t.length} chars total]`
}

function kb(bytes) {
  if (!bytes) return '?'
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`
}

/**
 * Every Google document referenced anywhere in this payload, deduped by document
 * id and ranked by how often it was referenced.
 *
 * The most-repasted link is the one people keep pointing each other at, which is
 * almost always the document that actually holds the decisions. Bookmarks and
 * pins outrank message mentions because somebody deliberately put them there.
 */
function collectDocs(p) {
  const byId = new Map()

  const add = (url, where, rank) => {
    const doc = googleDocId(url)
    if (!doc) return
    const prev = byId.get(doc.id)
    if (prev) {
      prev.count++
      if (rank < prev.rank) {
        prev.rank = rank
        prev.where = where
        prev.url = url
      }
      return
    }
    byId.set(doc.id, { url, kind: doc.kind, where, rank, count: 1 })
  }

  for (const b of p.bookmarks ?? []) add(b.link ?? '', 'bookmarked', 0)
  for (const msg of p.pinned ?? []) {
    for (const l of msg.links ?? []) add(l, 'in a pinned message', 1)
  }
  const walk = (msg) => {
    for (const l of msg.links ?? []) add(l, 'in the messages', 2)
    for (const t of msg.thread ?? []) walk(t)
  }
  for (const msg of p.messages ?? []) walk(msg)

  return [...byId.values()].sort((a, b) => a.rank - b.rank || b.count - a.count)
}
