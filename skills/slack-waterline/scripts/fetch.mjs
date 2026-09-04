#!/usr/bin/env node
// Fetch one conversation and emit a payload. Layer B.
//
//   node fetch.mjs '#general' --state --out tmp/general.json
//   node fetch.mjs 'dm:Saba'  --state --out tmp/saba.json
//   node fetch.mjs C0ABC123   --since 7d --out tmp/x.json
//   node fetch.mjs C0ABC123   --full --out raw/C0ABC123.json
//   node fetch.mjs --many ids.txt --out-dir raw/ --skip-existing
//
// PREFER --out OVER A SHELL REDIRECT. `> file.json` truncates the target before
// this script runs, so a failed fetch leaves you with an empty file where a
// stale-but-valid payload used to be.
//
// STDOUT IS THE PAYLOAD. Everything else goes to stderr.

import { writeFileSync, renameSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

import { Slack, note, fail, refuse, runMain } from './lib/slack.mjs'
import { resolveWorkspace, argValue, hasFlag, positionals, parseSince } from './lib/config.mjs'
import { loadManifest, threadHasUnread, mergeThreadState } from './lib/state.mjs'
import { conversationName, conversationType, extractLinks, isoOf } from './lib/markup.mjs'

const argv = process.argv.slice(2)
const VALUE_FLAGS = ['workspace', 'w', 'since', 'out', 'out-dir', 'many']

// How far back to look for threads that grew on OLD parents. A reply never
// moves its parent, so a plain `oldest` filter cannot see it.
const THREAD_LOOKBACK_DAYS = 90
// 25 pages × 200 = 5,000 parents. Past the full history of most channels, so in
// practice this means "all of it" with a stop built in.
const THREAD_SCAN_MAX_PAGES = 25
// Known parents older than the lookback window get checked directly, but only
// so many — beyond this, use --full.
const OLD_PARENT_CHECK_CAP = 25

const { slug, dataDir, config } = resolveWorkspace(argv)
const slack = new Slack(dataDir)

await runMain(async () => {
  const manyFile = argValue(argv, 'many')
  if (manyFile) await batchMode(manyFile)
  else await singleMode()
})

// ---------------------------------------------------------------- batch mode

async function batchMode(manyFile) {
  const outDir = argValue(argv, 'out-dir')
  if (!outDir) fail('--many requires --out-dir')
  mkdirSync(outDir, { recursive: true })

  const ids = readFileSync(manyFile, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))

  slack.announceIdentity()
  note(`--many: ${ids.length} conversations → ${outDir}`)

  let failures = 0
  let skipped = 0
  for (const [i, id] of ids.entries()) {
    const out = join(outDir, `${id}.json`)

    // --skip-existing is resumability, and it is a trap on a STALE list: every
    // stale payload is already a complete one, so re-running with this flag is
    // a total no-op. Use it for the "new conversations" pass only.
    if (hasFlag(argv, 'skip-existing') && existsSync(out)) {
      try {
        const prev = JSON.parse(readFileSync(out, 'utf8'))
        if (prev?._meta?.mode === 'full') {
          skipped++
          continue
        }
      } catch {
        /* unparseable — refetch it */
      }
    }

    note(`[${i + 1}/${ids.length}] ${id}`)
    try {
      const payload = await fetchConversation(id)
      writeAtomic(out, JSON.stringify(payload, null, 1))
    } catch (e) {
      // A failing conversation must not abort the batch, and must not truncate
      // the file it would have written. Exit code carries the count so an
      // identical re-run retries only what failed.
      note(`  ✗ ${id}: ${e.message}`)
      failures++
    }
  }

  note(`\n${ids.length - failures - skipped} fetched, ${skipped} skipped, ${failures} failed`)
  // The exit code carries the failure count, so re-running the identical command
  // retries only what failed.
  process.exitCode = Math.min(failures, 250)
}

// ---------------------------------------------------------------- single mode

async function singleMode() {
  const target = positionals(argv, VALUE_FLAGS)[0]
  if (!target) {
    fail(
      'Usage: node fetch.mjs <#channel|dm:Name|@Name|ID> [--state|--since 7d|--full] [--out path]\n' +
        '       node fetch.mjs --many ids.txt --out-dir raw/ [--skip-existing]'
    )
  }

  slack.announceIdentity()
  const payload = await fetchConversation(target)
  const out = argValue(argv, 'out')
  if (out) {
    writeAtomic(out, JSON.stringify(payload, null, 1))
    note(`wrote ${out} (${payload._meta.newCount} new messages)`)
  } else {
    process.stdout.write(JSON.stringify(payload, null, 1) + '\n')
  }
}

// ================================================================== core

async function fetchConversation(target) {
  const users = await slack.users()
  const channel = await resolveChannel(target, users)
  const manifest = loadManifest(dataDir)
  const prior = manifest.channels[channel.id]

  // ---- what window are we reading?
  const useState = hasFlag(argv, 'state')
  const full = hasFlag(argv, 'full')
  const sinceArg = parseSince(argValue(argv, 'since'))

  let oldest = null
  let mode = 'full'
  if (full) {
    oldest = null
  } else if (sinceArg) {
    oldest = sinceArg
    mode = 'incremental'
  } else if (useState && prior?.watermarkTs && prior.watermarkTs !== '0') {
    oldest = prior.watermarkTs
    mode = 'incremental'
  } else if (useState) {
    // First sight of this conversation. Do not pull all history by accident.
    oldest = (Date.now() / 1000 - (config.firstRunLookbackDays ?? 7) * 86400).toFixed(6)
    mode = 'incremental'
  }

  // ---- top-level history
  const messages = await historyFrom(channel.id, oldest)
  messages.sort((a, b) => Number(a.ts) - Number(b.ts))

  // ---- threads
  const deliveredThreads = new Set()
  const threadFacts = []

  // New top-level messages get their FULL thread — there is no prior position
  // inside a thread whose parent we are seeing for the first time.
  for (const m of messages) {
    if (!m.reply_count) continue
    m._replies = (await repliesOf(channel.id, m.ts)).filter((r) => r.ts !== m.ts)
    deliveredThreads.add(m.ts)
    threadFacts.push({ ts: m.ts, reply_count: m.reply_count, latest_reply: m.latest_reply ?? m.ts })
  }

  // Old parents whose threads grew. THIS IS THE WHOLE POINT OF THE THREAD PASS:
  // a reply never moves its parent, so a channel whose only new content is a
  // thread reply looks completely quiet from the top level.
  const grown = []
  if (mode === 'incremental' && oldest) {
    const seen = new Set(messages.map((m) => m.ts))
    const floor = Math.min(
      Number(oldest),
      Date.now() / 1000 - THREAD_LOOKBACK_DAYS * 86400
    ).toFixed(6)

    for (const parent of await threadParentsFrom(channel.id, floor)) {
      if (seen.has(parent.ts)) continue
      const known = prior?.threads?.[parent.ts]
      if (!threadHasUnread(parent, known)) continue
      grown.push({ parent, known })
    }

    // Known parents older than the scan floor. Capped: past the cap, the honest
    // thing is to say so rather than silently look at a subset.
    const scannedFloor = Number(floor)
    const olderKnown = Object.entries(prior?.threads ?? {})
      .filter(([ts]) => Number(ts) < scannedFloor)
      .slice(0, OLD_PARENT_CHECK_CAP)
    for (const [ts, known] of olderKnown) {
      const replies = await repliesOf(channel.id, ts)
      const parentMsg = replies.find((r) => r.ts === ts)
      const facts = {
        ts,
        reply_count: Math.max(0, replies.length - 1),
        latest_reply: replies.length ? replies[replies.length - 1].ts : ts,
      }
      if (!threadHasUnread(facts, known)) continue
      grown.push({ parent: { ...(parentMsg ?? { ts }), ...facts }, known, prefetched: replies })
    }

    for (const g of grown) {
      const replies =
        g.prefetched ?? (await repliesOf(channel.id, g.parent.ts))
      const cut = Number(g.known?.latestReplyTs ?? 0)
      const fresh = replies.filter((r) => r.ts !== g.parent.ts && Number(r.ts) > cut)
      if (!fresh.length) continue
      const parentMsg = replies.find((r) => r.ts === g.parent.ts) ?? g.parent
      messages.push({ ...parentMsg, _replies: fresh, _threadOnly: true })
      deliveredThreads.add(g.parent.ts)
      threadFacts.push({
        ts: g.parent.ts,
        reply_count: g.parent.reply_count ?? replies.length - 1,
        latest_reply: replies.length ? replies[replies.length - 1].ts : g.parent.ts,
      })
    }
    messages.sort((a, b) => Number(a.ts) - Number(b.ts))
  }

  // ---- canonical content, ALWAYS fetched regardless of the watermark.
  // Pins and bookmarks are not incremental: they are what the room decided is
  // permanently important, and a delta that omits them reads as if nothing is.
  let pinned = []
  try {
    const r = await slack.call('pins.list', { channel: channel.id })
    pinned = (r.items ?? []).filter((i) => i.message).map((i) => i.message)
  } catch {
    /* pins:read missing, or a DM — not fatal */
  }

  let bookmarks = []
  try {
    const r = await slack.call('bookmarks.list', { channel_id: channel.id })
    bookmarks = (r.bookmarks ?? []).map((b) => ({
      title: b.title,
      link: b.link,
      emoji: b.emoji ?? null,
      type: b.type,
      rank: b.rank ?? '',
    }))
  } catch {
    /* bookmarks:read missing — not fatal */
  }

  // ---- normalise
  const normalized = messages.map((m) => normalize(m, users))
  const normalizedPins = pinned.map((m) => normalize(m, users))

  // The users dict is built from THIS payload's referenced ids only, not from
  // the process-wide directory. Under --many a wholesale dump made the file
  // bytes depend on fetch order, in files whose entire purpose is to be a stable
  // record under git.
  const referenced = new Set()
  const collect = (m) => {
    if (m.user_id) referenced.add(m.user_id)
    for (const mm of m.text.matchAll(/<@([UW][A-Z0-9]+)/g)) referenced.add(mm[1])
    for (const t of m.thread) collect(t)
  }
  normalized.forEach(collect)
  normalizedPins.forEach(collect)
  if (channel.user) referenced.add(channel.user)

  const usersOut = {}
  for (const id of [...referenced].sort()) {
    usersOut[id] = { name: users.get(id) ?? (await slack.userName(id)) }
  }

  const newWatermarkTs = normalized.reduce(
    (max, m) => (Number(m.ts) > Number(max) ? m.ts : max),
    oldest && mode === 'incremental' ? String(oldest) : '0'
  )

  return {
    _meta: {
      workspace: slug,
      mode,
      since: oldest ? String(oldest) : null,
      fetchedAt: new Date().toISOString(),
      newCount: normalized.length,
      newWatermarkTs,
      // What was DELIVERED, never what exists. record.mjs writes exactly this.
      threadState: mergeThreadState(threadFacts, deliveredThreads, {}),
      priorDigest: prior?.digest ?? null,
      priorWatermarkTs: prior?.watermarkTs ?? null,
      threadScanFloor: mode === 'incremental' && oldest ? String(oldest) : null,
    },
    channel: {
      id: channel.id,
      name: conversationName(channel, users),
      type: conversationType(channel),
      purpose: channel.purpose?.value ?? '',
      topic: channel.topic?.value ?? '',
      num_members: channel.num_members ?? null,
      created: channel.created ?? null,
      is_archived: !!channel.is_archived,
    },
    pinned: normalizedPins,
    bookmarks,
    users: usersOut,
    messages: normalized,
  }
}

// ---------------------------------------------------------------- slack calls

async function historyFrom(channelId, oldest) {
  const out = []
  let cursor
  do {
    const body = await slack.call('conversations.history', {
      channel: channelId,
      oldest: oldest ?? undefined,
      limit: 200,
      cursor,
    })
    out.push(...(body.messages ?? []))
    cursor = body.response_metadata?.next_cursor || ''
  } while (cursor)
  return out
}

/** Every parent with replies back to `floor`, for the thread-growth comparison. */
async function threadParentsFrom(channelId, floor) {
  const parents = []
  let cursor
  let pages = 0
  do {
    const body = await slack.call('conversations.history', {
      channel: channelId,
      oldest: floor,
      limit: 200,
      cursor,
    })
    for (const m of body.messages ?? []) {
      if (m.reply_count > 0) {
        parents.push({ ts: m.ts, reply_count: m.reply_count, latest_reply: m.latest_reply ?? m.ts })
      }
    }
    cursor = body.response_metadata?.next_cursor || ''
  } while (cursor && ++pages < THREAD_SCAN_MAX_PAGES)
  return parents
}

async function repliesOf(channelId, ts) {
  const out = []
  let cursor
  do {
    const body = await slack.call('conversations.replies', {
      channel: channelId,
      ts,
      limit: 200,
      cursor,
    })
    out.push(...(body.messages ?? []))
    cursor = body.response_metadata?.next_cursor || ''
  } while (cursor)
  return out
}

async function resolveChannel(target, users) {
  // A raw id is unambiguous — take it.
  if (/^[CDG][A-Z0-9]{6,}$/.test(target)) {
    const r = await slack.call('conversations.info', { channel: target })
    return r.channel
  }

  const convos = await slack.all(
    'users.conversations',
    { types: slack.conversationTypes, exclude_archived: false },
    'channels'
  )

  const want = target.replace(/^[#@]/, '').toLowerCase()

  if (target.startsWith('@') || target.startsWith('dm:')) {
    const person = target.replace(/^(@|dm:)/, '').toLowerCase()
    const hits = convos.filter((c) => {
      if (!c.is_im) return false
      const name = (users.get(c.user) ?? '').toLowerCase()
      return name === person || name.startsWith(person)
    })
    if (!hits.length) refuse(`No DM matching "${target}". Names come from your Slack display names.`)
    if (hits.length > 1) {
      // Ambiguity is refused, never guessed. Reading the wrong person's DM is
      // not a recoverable mistake.
      refuse(
        `"${target}" is ambiguous: ` +
          hits.map((c) => users.get(c.user) ?? c.user).join(', ') +
          '. Be more specific, or pass the channel ID.'
      )
    }
    return hits[0]
  }

  const hit = convos.find((c) => (c.name ?? '').toLowerCase() === want)
  if (!hit) {
    refuse(
      `No conversation "${target}" visible to this token.\n` +
        (slack.usingUserToken
          ? '  You may not be a member of it, or it may be archived.'
          : '  On a bot token, DMs are invisible and private channels need an /invite.')
    )
  }
  return hit
}

// ---------------------------------------------------------------- normalize

function normalize(m, users) {
  return {
    ts: m.ts,
    iso: isoOf(m.ts),
    user_id: m.user ?? m.bot_id ?? null,
    user_name: m.user ? (users.get(m.user) ?? m.user) : (m.username ?? m.bot_id ?? 'unknown'),
    text: m.text ?? '',
    subtype: m.subtype ?? null,
    // Captured for fidelity AND rendered downstream. A 👀 or a ✅ on a request
    // is real signal about whether it still needs you.
    reactions: (m.reactions ?? []).map((r) => ({ name: r.name, count: r.count })),
    files: (m.files ?? []).map((f) => ({
      id: f.id,
      name: f.name ?? f.title ?? '',
      title: f.title ?? '',
      filetype: f.filetype ?? '',
      mimetype: f.mimetype ?? '',
      size: f.size ?? 0,
      url_private: f.url_private ?? null,
      url_private_download: f.url_private_download ?? null,
      permalink: f.permalink ?? null,
    })),
    links: extractLinks(m.text ?? ''),
    thread: (m._replies ?? []).map((r) => normalize(r, users)),
    thread_only: !!m._threadOnly,
  }
}

// ---------------------------------------------------------------- io

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}
