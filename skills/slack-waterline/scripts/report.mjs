#!/usr/bin/env node
// Build a daily or weekly digest, and optionally DM it to yourself.
//
//   node report.mjs --period day
//   node report.mjs --period week --send
//   node report.mjs --since 72h --send --dry-run
//
// A REPORT IS A VIEW, NOT A READ. This script never touches state.json. Being
// mentioned in a summary is not the same as having read the conversation, and
// conflating the two is how a backlog disappears without anyone clearing it.
//
// It looks at a trailing window rather than at the watermark, so a scheduled run
// tells you what happened *today* whether or not you have caught up.

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { Slack, note, fail, finish } from './lib/slack.mjs'
import { resolveWorkspace, argValue, hasFlag, parseSince } from './lib/config.mjs'
import { loadManifest } from './lib/state.mjs'
import {
  conversationName,
  conversationType,
  compilePatterns,
  renderText,
  fmtTime,
  isMechanical,
} from './lib/markup.mjs'
import { resolveTarget, postLogged, chunk } from './send.mjs'

// Bounded, so a scheduled run has a predictable cost.
const THREAD_PEEK_CAP = 6
const MAX_HISTORY_PAGES = 3

const argv = process.argv.slice(2)
const { slug, dataDir, config } = resolveWorkspace(argv)
const slack = new Slack(dataDir)

const period = argValue(argv, 'period', 'day')
if (!['day', 'week'].includes(period) && !argValue(argv, 'since')) {
  fail('--period must be day or week, or pass --since 72h')
}
const since = parseSince(argValue(argv, 'since') ?? (period === 'week' ? '7d' : '1d'))
const tz = config.timezone
const maxItems = config.report?.maxItemsPerSection ?? 40

slack.announceIdentity()

const me = await slack.call('auth.test', {})
const teamUrl = (me.url ?? '').replace(/\/$/, '')
const users = await slack.users()
const manifest = loadManifest(dataDir)
const needsReplyPatterns = compilePatterns(config.needsReply?.patterns)

// ---------------------------------------------------------------- gather

const convos = await slack.all(
  'users.conversations',
  { types: slack.conversationTypes, exclude_archived: true },
  'channels'
)

const excluded = new Set(config.excludeChannels ?? [])
const items = []
const skippedSettled = []
const unreadable = []

for (const c of convos) {
  if (!slack.isReadable(c, { memberImplied: true })) continue
  const name = conversationName(c, users)
  if (excluded.has(name) || excluded.has(c.id)) continue

  const entry = manifest.channels[c.id]
  if (entry?.mapping?.kind === 'skip' && !entry.mapping?.alwaysRead) {
    skippedSettled.push(name)
    continue
  }

  const type = conversationType(c)
  let messages = []
  try {
    messages = await historyWindow(c.id, since)
  } catch (e) {
    unreadable.push(`${name} (${e.message.replace(/^slack \S+: /, '')})`)
    continue
  }

  for (const m of messages) {
    const item = classify(m, c, name, type, entry)
    if (item) items.push(item)
  }

  // A reply never moves its parent, so a window over top-level messages alone
  // misses an entire live conversation happening inside an older thread.
  let peeked = 0
  for (const m of messages.concat(await recentThreadParents(c.id, since, entry))) {
    if (!m.reply_count || peeked >= THREAD_PEEK_CAP) continue
    if (Number(m.latest_reply ?? 0) <= Number(since)) continue
    peeked++
    let replies = []
    try {
      const r = await slack.call('conversations.replies', { channel: c.id, ts: m.ts, limit: 200 })
      replies = r.messages ?? []
    } catch {
      continue
    }
    for (const reply of replies) {
      if (reply.ts === m.ts) continue
      if (Number(reply.ts) <= Number(since)) continue
      const item = classify(reply, c, name, type, entry, { inThread: true, parentTs: m.ts })
      if (item) items.push(item)
    }
  }
}

items.sort((a, b) => Number(b.ts) - Number(a.ts))

const needsReply = items.filter((i) => i.needsReply && !i.handled)
const handled = items.filter((i) => i.needsReply && i.handled)
const context = items.filter((i) => !i.needsReply)

// ---------------------------------------------------------------- render

const now = new Date()
const label = period === 'week' ? 'Weekly' : 'Daily'
const windowLabel = `${fmtTime(since, tz)} → ${fmtTime(now.getTime() / 1000, tz)}`

const lines = []
lines.push(`*${label} Slack digest — ${slug}*`)
lines.push(`_${windowLabel}_`)
lines.push('')
lines.push(
  `*${needsReply.length}* need you · *${handled.length}* already reacted to · *${context.length}* context`
)

if (needsReply.length) {
  lines.push('', '─'.repeat(30), '*NEEDS A REPLY*', '')
  for (const i of needsReply.slice(0, maxItems)) lines.push(...renderItem(i))
  if (needsReply.length > maxItems) lines.push(`_…and ${needsReply.length - maxItems} more._`)
}

if (handled.length) {
  lines.push('', '─'.repeat(30), '*ASKED YOU, BUT YOU ALREADY REACTED*', '')
  for (const i of handled.slice(0, 10)) lines.push(`• ${i.who} in ${i.channelName} — ${oneLine(i.text)}`)
}

if (context.length && config.report?.includeContext !== false) {
  lines.push('', '─'.repeat(30), '*CONTEXT (no action implied)*', '')
  for (const i of context.slice(0, maxItems)) {
    lines.push(`• *${i.who}* in ${i.channelName} — ${oneLine(i.text)}`)
  }
  if (context.length > maxItems) lines.push(`_…and ${context.length - maxItems} more._`)
}

lines.push('', '─'.repeat(30), '*What this digest could not see*')
if (!slack.usingUserToken) lines.push('• DMs and group DMs (bot token — invisible, not empty)')
lines.push('• DMs between two other people (Enterprise Grid Discovery API only)')
lines.push('• Private channels nobody has invited you to')
if (skippedSettled.length) {
  lines.push(`• ${skippedSettled.length} conversations mapped \`skip\`: ${skippedSettled.slice(0, 8).join(', ')}`)
}
if (unreadable.length) lines.push(`• Errored: ${unreadable.slice(0, 5).join('; ')}`)
lines.push(
  '',
  '_This is a summary, not a read. Your read position has not moved._',
  `_Catch up properly:_ \`node catchup.mjs --workspace ${slug} --unread\``
)

const body = lines.join('\n')

// ---------------------------------------------------------------- write

const reportsDir = join(dataDir, 'reports')
mkdirSync(reportsDir, { recursive: true })
const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(now)
const outPath = join(reportsDir, `${stamp}-${period}.md`)
writeFileSync(outPath, body + '\n')

console.log(body)
note(`\nwrote ${outPath}`)

// ---------------------------------------------------------------- deliver

if (hasFlag(argv, 'send')) {
  await deliver()
} else {
  note(`\nNot sent. Add --send to DM this to ${config.report?.deliverTo ?? '@me'}.`)
  await finish(0)
}

async function deliver() {
const to = argValue(argv, 'to') ?? config.report?.deliverTo ?? '@me'
const target = await resolveTarget(slack, to, users)
const parts = chunk(body)

console.log(`\n${'─'.repeat(60)}`)
console.log(`Send to: ${target.label} [${target.id}] — ${parts.length} message(s)`)
if (hasFlag(argv, 'dry-run')) {
  console.log('--dry-run: nothing sent.')
  await finish(0)
  return
}

let threadTs = null
for (const [i, part] of parts.entries()) {
  const record = {
    at: new Date().toISOString(),
    op: 'chat.postMessage',
    to: target.label,
    channel: target.id,
    thread: threadTs,
    kind: `report:${period}`,
    text: part,
  }
  const ts = await postLogged(slack, dataDir, record, {
    channel: target.id,
    text: part,
    thread_ts: threadTs ?? undefined,
    unfurl_links: false,
    unfurl_media: false,
  })
  // Continuation chunks go under the first message rather than flooding the DM.
  if (i === 0) threadTs = ts
}
console.log(`✓ Sent to ${target.label}${parts.length > 1 ? ` (${parts.length} parts, threaded)` : ''}`)
await finish(0)
}

// ================================================================== helpers

async function historyWindow(channelId, oldest) {
  const out = []
  let cursor
  let pages = 0
  do {
    const body = await slack.call('conversations.history', {
      channel: channelId,
      oldest,
      limit: 200,
      cursor,
    })
    out.push(...(body.messages ?? []))
    cursor = body.response_metadata?.next_cursor || ''
  } while (cursor && ++pages < MAX_HISTORY_PAGES)
  return out
}

async function recentThreadParents(channelId, oldest, entry) {
  const known = Object.entries(entry?.threads ?? {})
    .filter(([ts]) => Number(ts) < Number(oldest))
    .slice(-THREAD_PEEK_CAP)
  const out = []
  for (const [ts] of known) {
    try {
      const r = await slack.call('conversations.replies', { channel: channelId, ts, limit: 1 })
      if (r.messages?.[0]) out.push(r.messages[0])
    } catch {
      /* gone */
    }
  }
  return out
}

function classify(m, c, channelName, type, entry, { inThread = false, parentTs = null } = {}) {
  if (isMechanical(m)) return null
  if (m.bot_id && !m.user) return null
  if (m.user === me.user_id) return null // your own messages are not your inbox
  if (Number(m.ts) <= Number(since)) return null

  const text = renderText(m.text ?? '', users)
  const isDM = type === 'dm' || type === 'group-dm'
  const mentionsMe = (m.text ?? '').includes(`<@${me.user_id}>`)
  const hasFiles = (m.files ?? []).length > 0
  const asks = needsReplyPatterns.some(({ re }) => re.test(text))
  const alwaysRead = !!entry?.mapping?.alwaysRead

  // Your own reaction is a real signal that you saw it and dealt with it. Both
  // systems this was generalized from captured reactions and rendered them
  // nowhere, which meant a digest kept renominating things already handled.
  const handled = (m.reactions ?? []).some((r) => (r.users ?? []).includes(me.user_id))

  const needsReply = isDM || mentionsMe || asks || hasFiles || alwaysRead

  return {
    ts: m.ts,
    channelId: c.id,
    channelName: isDM ? channelName : `#${channelName}`,
    type,
    who: m.user ? (users.get(m.user) ?? m.user) : (m.username ?? 'bot'),
    text,
    files: (m.files ?? []).map((f) => `${f.name} (${f.filetype})`),
    inThread,
    parentTs,
    mentionsMe,
    needsReply,
    handled,
    reactions: (m.reactions ?? []).map((r) => `:${r.name}:×${r.count}`),
    permalink: permalink(c.id, m.ts, parentTs),
  }
}

function renderItem(i) {
  const tags = []
  if (i.type === 'dm') tags.push('DM')
  else if (i.type === 'group-dm') tags.push('group DM')
  if (i.mentionsMe) tags.push('@you')
  if (i.inThread) tags.push('thread reply')
  if (i.files.length) tags.push(`${i.files.length} file${i.files.length > 1 ? 's' : ''}`)

  const out = [
    `*${i.who}* · ${i.channelName} · ${fmtTime(i.ts, tz)}${tags.length ? `  _(${tags.join(', ')})_` : ''}`,
  ]
  for (const line of clip(i.text, 500).split('\n')) out.push(`> ${line}`)
  if (i.files.length) out.push(`  📎 ${i.files.join(', ')}`)
  if (i.reactions.length) out.push(`  ${i.reactions.join(' ')}`)
  if (i.permalink) out.push(`  <${i.permalink}|open in Slack>`)
  out.push('')
  return out
}

function oneLine(t) {
  return clip(t.replace(/\s+/g, ' ').trim(), 140)
}

function clip(t, n) {
  return t.length > n ? t.slice(0, n) + '…' : t
}

/**
 * Built rather than fetched. `chat.getPermalink` is one API call per message,
 * which on a busy week is hundreds of calls for a link that is fully derivable.
 */
function permalink(channelId, ts, parentTs) {
  if (!teamUrl) return null
  const p = 'p' + String(ts).replace('.', '')
  const base = `${teamUrl}/archives/${channelId}/${p}`
  return parentTs ? `${base}?thread_ts=${parentTs}&cid=${channelId}` : base
}
