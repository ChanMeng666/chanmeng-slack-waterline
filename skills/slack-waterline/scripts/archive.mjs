#!/usr/bin/env node
// Build readable transcripts from raw/*.json.
//
//   node archive.mjs                 # rebuild conversations/, INDEX.md, manifest.json
//   node archive.mjs --stats
//
// MARKDOWN, NOT JSON. A person — or a model — grepping for who agreed to what
// should not have to parse anything to see who said it.
//
// `conversations/` IS WIPED AND REBUILT EVERY RUN. A channel rename, a new
// calendar year, or a conversation crossing the split threshold all strand a
// file under the old name, and grep then finds both copies with nothing to say
// which is current. An orphan is worse than a missing file.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { note, fail } from './lib/slack.mjs'
import { resolveWorkspace, hasFlag } from './lib/config.mjs'
import { renderText, fmtTime, isMechanical, slugify, googleDocId } from './lib/markup.mjs'

// Above this, split by calendar year. A 3,000-message channel in one file is not
// something anybody reads, and it blows a context window in one Read.
const SPLIT_ABOVE = 400

const argv = process.argv.slice(2)
const { slug, dataDir, config } = resolveWorkspace(argv)
const tz = config.timezone

const rawDir = join(dataDir, 'raw')
if (!existsSync(rawDir)) fail(`No raw/ directory in ${dataDir}. Fetch some conversations first.`)

const files = readdirSync(rawDir).filter((f) => f.endsWith('.json'))
if (!files.length) fail(`No payloads in ${rawDir}.`)

const convDir = join(dataDir, 'conversations')
rmSync(convDir, { recursive: true, force: true })

const entries = []
const totals = { messages: 0, mechanical: 0, threads: 0 }
const allLinks = { sheets: [], docs: [], drive: [] }

for (const file of files.sort()) {
  let p
  try {
    p = JSON.parse(readFileSync(join(rawDir, file), 'utf8'))
  } catch (e) {
    note(`skipping ${file}: ${e.message}`)
    continue
  }

  // A partial payload must never be presented as a whole conversation. An
  // incremental fetch holds a delta; filing it as the transcript quietly loses
  // everything before the watermark.
  if (p._meta?.mode !== 'full') {
    note(`skipping ${file}: mode=${p._meta?.mode ?? '?'} — archive needs --full payloads`)
    continue
  }

  const ch = p.channel ?? {}
  const type = ch.type ?? 'channel'
  const users = p.users ?? {}
  const messages = (p.messages ?? []).slice().sort((a, b) => Number(a.ts) - Number(b.ts))

  const kept = messages.filter((m) => !isMechanical(m) || (m.thread ?? []).length)
  const mechanical = messages.length - kept.length
  const threadCount = kept.filter((m) => (m.thread ?? []).length).length

  const years = [...new Set(kept.map((m) => m.iso.slice(0, 4)))].sort()
  const split = kept.length > SPLIT_ABOVE && years.length > 1

  const dir = join(convDir, type)
  mkdirSync(dir, { recursive: true })

  const written = []
  const groups = split
    ? years.map((y) => ({ year: y, msgs: kept.filter((m) => m.iso.startsWith(y)) }))
    : [{ year: null, msgs: kept }]

  for (const g of groups) {
    if (!g.msgs.length) continue
    const base = `${slugify(ch.name ?? ch.id)}--${ch.id}${g.year ? `.${g.year}` : ''}.md`
    const path = join(dir, base)
    writeFileSync(
      path,
      renderConversation(ch, g, kept, users, { type, mechanical, threadCount, split })
    )
    written.push(join('conversations', type, base))
  }

  // Links, deduped by document id so the same sheet pasted five ways is one row.
  const seen = new Set()
  const walk = (m) => {
    for (const l of m.links ?? []) {
      const doc = googleDocId(l)
      if (!doc || seen.has(doc.id)) continue
      seen.add(doc.id)
      const bucket = doc.kind === 'spreadsheets' ? 'sheets' : doc.kind === 'document' ? 'docs' : 'drive'
      allLinks[bucket].push(l)
    }
    for (const t of m.thread ?? []) walk(t)
  }
  ;(p.pinned ?? []).forEach(walk)
  kept.forEach(walk)

  totals.messages += kept.length
  totals.mechanical += mechanical
  totals.threads += threadCount

  entries.push({
    id: ch.id,
    name: ch.name,
    type,
    files: written,
    messages: kept.length,
    mechanical,
    threads: threadCount,
    firstIso: kept[0]?.iso ?? null,
    lastIso: kept[kept.length - 1]?.iso ?? null,
    years: years.map(Number),
  })
}

entries.sort((a, b) => a.type.localeCompare(b.type) || (a.name ?? '').localeCompare(b.name ?? ''))

writeFileSync(
  join(dataDir, 'manifest.json'),
  JSON.stringify(
    { generatedFrom: slug, generatedAt: new Date().toISOString(), conversations: entries.length, totals, entries },
    null,
    2
  ) + '\n'
)

for (const k of Object.keys(allLinks)) allLinks[k] = [...new Set(allLinks[k])].sort()
writeFileSync(join(dataDir, 'links.json'), JSON.stringify(allLinks, null, 2) + '\n')

writeFileSync(join(dataDir, 'INDEX.md'), renderIndex(entries, totals))

console.log(
  `${entries.length} conversations · ${totals.messages} messages · ${totals.threads} threads · ` +
    `${totals.mechanical} mechanical omitted`
)
console.log(`  ${convDir}`)
console.log(`  ${join(dataDir, 'INDEX.md')}`)
console.log(
  `  links: ${allLinks.sheets.length} sheets, ${allLinks.docs.length} docs, ${allLinks.drive.length} drive`
)

// ================================================================== render

function renderConversation(ch, group, allKept, users, meta) {
  const msgs = group.msgs
  const out = []
  out.push(`# ${ch.name}`)
  out.push('')
  out.push('| | |')
  out.push('|---|---|')
  out.push(`| conversation id | \`${ch.id}\` |`)
  out.push(`| type | ${meta.type} |`)
  out.push(`| scope of this file | ${group.year ? `calendar year ${group.year}` : 'whole conversation'} |`)
  out.push(`| messages here | ${msgs.length} |`)
  if (meta.split) out.push(`| messages in whole conversation | ${allKept.length} |`)
  out.push(`| threads in whole conversation | ${meta.threadCount} |`)
  // COUNTED, not just dropped. Otherwise a reader cannot tell "nothing happened
  // here" from "the filter ate it".
  out.push(`| mechanical messages omitted | ${meta.mechanical} (joins, leaves, topic changes) |`)
  out.push(`| date range | ${msgs[0].iso.slice(0, 10)} → ${msgs[msgs.length - 1].iso.slice(0, 10)} |`)
  out.push('')
  out.push('> Nothing else has been filtered. Message text is verbatim and untruncated;')
  out.push('> thread replies are indented under their parent.')
  out.push('')
  out.push('---')
  out.push('')

  for (const m of msgs) {
    out.push(`**${m.user_name}** · ${fmtTime(m.ts, tz)}`)
    const body = renderText(m.text, users)
    out.push(body || '_(no text)_')
    for (const f of m.files ?? []) out.push(`\`[file: ${f.name} (${f.filetype})]\``)
    if (m.reactions?.length) out.push(`_${m.reactions.map((r) => `:${r.name}:×${r.count}`).join(' ')}_`)

    if ((m.thread ?? []).length) {
      out.push('')
      out.push(`  _thread — ${m.thread.length} replies_`)
      for (const r of m.thread) {
        out.push('')
        out.push(`  > **${r.user_name}** · ${fmtTime(r.ts, tz)}`)
        const rb = renderText(r.text, users) || '_(no text)_'
        for (const line of rb.split('\n')) out.push(`  > ${line}`)
        for (const f of r.files ?? []) out.push(`  > \`[file: ${f.name} (${f.filetype})]\``)
      }
    }
    out.push('')
  }
  return out.join('\n')
}

function renderIndex(entries, totals) {
  const out = []
  out.push(`# ${slug} — Slack archive`)
  out.push('')
  out.push(
    `${entries.length} conversations · ${totals.messages} messages · ${totals.threads} threads · ` +
      `${totals.mechanical} mechanical omitted`
  )
  out.push('')
  out.push(`_Generated ${new Date().toISOString()} by slack-waterline. Do not hand-edit._`)
  out.push('')

  for (const type of ['dm', 'group-dm', 'private', 'channel']) {
    const rows = entries.filter((e) => e.type === type)
    if (!rows.length) continue
    out.push(`## ${type} (${rows.length})`)
    out.push('')
    out.push('| conversation | messages | threads | range | file |')
    out.push('|---|---:|---:|---|---|')
    // Biggest first. Size is the least-bad available proxy for "was anything
    // actually decided in here".
    for (const e of rows.sort((a, b) => b.messages - a.messages)) {
      const range = e.firstIso ? `${e.firstIso.slice(0, 10)} → ${e.lastIso.slice(0, 10)}` : '—'
      out.push(`| ${e.name} | ${e.messages} | ${e.threads} | ${range} | ${e.files.map((f) => `\`${f}\``).join('<br>')} |`)
    }
    out.push('')
  }
  return out.join('\n')
}
