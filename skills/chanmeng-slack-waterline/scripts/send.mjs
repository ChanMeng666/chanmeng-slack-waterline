#!/usr/bin/env node
// Post to Slack AS YOU. The only script here that writes into a conversation.
//
//   node send.mjs --to '#general' --text '…' --dry-run
//   node send.mjs --to '@Saba'    --file draft.md
//   node send.mjs --to '@me'      --text '…'                  # your own DM
//   node send.mjs --to '@Olga'    --text '…' --thread 1785…   # thread reply
//   node send.mjs --to '@Saba'    --file draft.md --update 1785… --reason '…'
//
// SLACK HAS NO UNSEND. Every attempt is appended to sent.log.jsonl BEFORE the
// API call and again after, so there is a local record of what left this machine
// even if the process dies mid-flight. That log is the only audit trail that
// exists.
//
// --update is the one way to take something back: a message edited before the
// reader gets to it never existed as far as they are concerned, which beats
// posting a correction underneath it. --reason is mandatory, because the log is
// the only place recording why history was rewritten, and the dry-run prints the
// current remote text so you see what you are overwriting.

import { readFileSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Slack, note, fail, refuse, runMain, finish } from './lib/slack.mjs'
import { resolveWorkspace, argValue, hasFlag } from './lib/config.mjs'

// Slack rejects a message body over 40,000 characters outright.
export const MAX_TEXT = 39000

// ---------------------------------------------------------------- library

export async function resolveTarget(slack, target, users) {
  if (target === '@me' || target === 'me' || target === 'self') {
    const me = await slack.call('auth.test', {})
    // Opening a conversation with yourself yields the "you" DM — the one Slack
    // shows at the top of your sidebar.
    const im = await slack.post('conversations.open', { users: me.user_id })
    return { id: im.channel.id, label: `DM · yourself (${me.user})` }
  }

  if (/^[CDG][A-Z0-9]{6,}$/.test(target)) return { id: target, label: target }

  if (target.startsWith('#')) {
    const name = target.slice(1).toLowerCase()
    const convos = await slack.all(
      'users.conversations',
      { types: 'public_channel,private_channel', exclude_archived: true },
      'channels'
    )
    const hit = convos.find((c) => (c.name ?? '').toLowerCase() === name)
    if (!hit) {
      refuse(
        `No channel #${name} that you are a member of.\n` +
          `  You are in: ${convos.map((c) => '#' + c.name).join(', ')}`
      )
    }
    return { id: hit.id, label: `#${hit.name}` }
  }

  if (target.startsWith('@')) {
    const want = target.slice(1).toLowerCase()
    const members = await slack.all('users.list', {}, 'members', { limit: 500 })
    const candidates = members.filter((u) => {
      if (u.deleted || u.is_bot) return false
      const names = [u.profile?.display_name, u.real_name, u.name].filter(Boolean).map((s) => s.toLowerCase())
      return names.some((n) => n === want || n.startsWith(want))
    })
    if (!candidates.length) refuse(`No user matching "${target}".`)
    if (candidates.length > 1) {
      // Refused, never guessed. Sending the wrong person a message is not a
      // recoverable mistake, and a prefix match is not evidence of intent.
      refuse(
        `"${target}" is ambiguous: ` +
          candidates.map((u) => u.profile?.display_name || u.real_name || u.name).join(', ') +
          '.\n  Be more specific, or pass the DM channel ID.'
      )
    }
    const u = candidates[0]
    const im = await slack.post('conversations.open', { users: u.id })
    return { id: im.channel.id, label: `DM · ${u.profile?.display_name || u.real_name || u.name}` }
  }

  refuse(`--to must be "#channel", "@Person", "@me", or a raw channel ID. Got: ${target}`)
}

/** Split on paragraph boundaries so a long report does not lose its shape. */
export function chunk(text, max = MAX_TEXT) {
  if (text.length <= max) return [text]
  const out = []
  let buf = ''
  for (const para of text.split('\n\n')) {
    if (buf && buf.length + para.length + 2 > max) {
      out.push(buf)
      buf = ''
    }
    if (para.length > max) {
      // A single paragraph over the limit — split on lines, then hard-split.
      for (const lineChunk of hardSplit(para, max)) {
        if (buf) {
          out.push(buf)
          buf = ''
        }
        out.push(lineChunk)
      }
      continue
    }
    buf = buf ? `${buf}\n\n${para}` : para
  }
  if (buf) out.push(buf)
  return out
}

function hardSplit(text, max) {
  const out = []
  let buf = ''
  for (const line of text.split('\n')) {
    if (buf.length + line.length + 1 > max) {
      if (buf) out.push(buf)
      buf = line.slice(0, max)
      for (let i = max; i < line.length; i += max) out.push(line.slice(i, i + max))
    } else {
      buf = buf ? `${buf}\n${line}` : line
    }
  }
  if (buf) out.push(buf)
  return out
}

/**
 * Post, logging before and after. Returns the message ts.
 *
 * The log is written BEFORE the call on purpose: a process killed between the
 * request and the response still leaves evidence that something may have been
 * posted, which is the only state you can actually recover from.
 */
export async function postLogged(slack, dataDir, record, params, { update = null } = {}) {
  const logPath = join(dataDir, 'sent.log.jsonl')
  appendFileSync(logPath, JSON.stringify({ ...record, status: 'attempting' }) + '\n')
  try {
    const res = update
      ? await slack.post('chat.update', params)
      : await slack.post('chat.postMessage', params)
    appendFileSync(
      logPath,
      JSON.stringify({ ...record, status: update ? 'updated' : 'sent', ts: res.ts }) + '\n'
    )
    return res.ts
  } catch (e) {
    appendFileSync(logPath, JSON.stringify({ ...record, status: 'failed', error: e.message }) + '\n')
    throw e
  }
}

// ---------------------------------------------------------------- cli

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isCli) await runMain(main)

async function main() {
  const argv = process.argv.slice(2)
  const { dataDir } = resolveWorkspace(argv)
  const slack = new Slack(dataDir)

  const to = argValue(argv, 'to')
  const thread = argValue(argv, 'thread')
  const file = argValue(argv, 'file')
  const update = argValue(argv, 'update')
  const reason = argValue(argv, 'reason')
  const dryRun = hasFlag(argv, 'dry-run')

  let text = argValue(argv, 'text')
  if (file) {
    if (!existsSync(file)) fail(`No such file: ${file}`)
    text = readFileSync(file, 'utf8')
  }

  if (!to || text === undefined) {
    fail(
      'Usage: node send.mjs --to "#channel"|"@Person"|"@me" (--text "…" | --file draft.md)\n' +
        '                    [--thread <ts>] [--update <ts> --reason "…"] [--dry-run]'
    )
  }

  // An edit rewrites what somebody may already have read. The reason is the only
  // durable record of why, so it is required rather than encouraged.
  if (update && !reason) {
    fail('--update requires --reason "why this message is being rewritten" (it goes in sent.log.jsonl).')
  }

  text = text.trim()
  if (!text) fail('Refusing to send an empty message.')
  if (text.length > MAX_TEXT && !update) {
    fail(
      `Message is ${text.length} chars; Slack's limit is 40,000.\n` +
        '  Split it, or use report.mjs --send which chunks automatically.'
    )
  }

  const me = await slack.call('auth.test', {})
  const users = await slack.users()
  const target = await resolveTarget(slack, to, users)

  const rule = '─'.repeat(64)
  console.log(`\nFrom:   ${me.user} — THIS POSTS AS YOU, NOT AS A BOT`)
  console.log(`To:     ${target.label}  [${target.id}]`)
  if (thread) console.log(`Thread: ${thread}`)

  if (update) {
    const existing = await fetchExisting(slack, target.id, update, thread)
    console.log(`Update: ${update}`)
    console.log(`Reason: ${reason}`)
    if (existing === null) {
      refuse(
        `\n✗ No message at ts=${update} in ${target.label}.\n` +
          '  Wrong ts, wrong channel, or it is a thread reply and you did not pass --thread.'
      )
    }
    console.log(`${rule}\nCURRENT (will be replaced):\n${rule}`)
    console.log(existing)
    console.log(`${rule}\nREPLACEMENT:\n${rule}`)
  } else {
    console.log(rule)
  }
  console.log(text)
  console.log(rule)

  if (dryRun) {
    console.log('\n--dry-run: nothing sent.')
    return
  }

  const record = {
    at: new Date().toISOString(),
    op: update ? 'chat.update' : 'chat.postMessage',
    to: target.label,
    channel: target.id,
    thread: thread ?? null,
    ...(update ? { updates_ts: update, reason } : {}),
    text,
  }

  try {
    const ts = await postLogged(
      slack,
      dataDir,
      record,
      update
        ? { channel: target.id, ts: update, text }
        : {
            channel: target.id,
            text,
            thread_ts: thread || undefined,
            unfurl_links: false,
            unfurl_media: false,
          },
      { update }
    )
    if (update) {
      console.log(`\n✓ Updated ${target.label} message ${ts} in place.`)
      console.log('  No second message was posted. Logged with the reason.')
      console.log('  If they had already read the old text, editing hides it — say so directly.')
    } else {
      console.log(`\n✓ Sent to ${target.label} at ${ts}`)
      console.log('  Slack has no unsend. Logged to sent.log.jsonl.')
    }
  } catch (e) {
    console.error(`\n✗ ${update ? 'Update' : 'Send'} failed: ${e.message}`)
    if (/missing_scope/.test(e.message)) {
      console.error('  This token lacks chat:write. Add it in your Slack app and reinstall.')
    }
    process.exitCode = 1
  }
}

async function fetchExisting(slack, channel, ts, thread) {
  try {
    const h = await slack.call('conversations.history', {
      channel,
      latest: ts,
      oldest: ts,
      inclusive: true,
      limit: 1,
    })
    if (h.messages?.[0]) return h.messages[0].text
  } catch {
    /* a thread reply is not in history — fall through */
  }
  if (thread) {
    try {
      const r = await slack.call('conversations.replies', { channel, ts: thread, limit: 200 })
      const hit = (r.messages ?? []).find((m) => m.ts === ts)
      if (hit) return hit.text
    } catch {
      /* reported as not-found by the caller */
    }
  }
  return null
}
