// Slack markup, timestamps, and the conversation-shape helpers everything else
// agrees on.

/**
 * Rewrite Slack's wire markup into something a human — and a model — can read.
 *
 * Order matters: the two-part `<url|label>` form must be handled before the bare
 * `<url>` form, or the pipe ends up inside the captured URL.
 */
export function renderText(text, users) {
  if (!text) return ''
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `@${nameOf(users, id)}`)
    .replace(/<#([CGD][A-Z0-9]+)\|([^>]*)>/g, (_, _id, name) => `#${name}`)
    .replace(/<#([CGD][A-Z0-9]+)>/g, (_, id) => `#${id}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_, w) => `@${w}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, h) => h || '@group')
    .replace(/<(https?:[^|>]+)\|([^>]*)>/g, '[$2]($1)')
    .replace(/<(mailto:[^|>]+)\|([^>]*)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

function nameOf(users, id) {
  if (!users) return id
  if (users instanceof Map) return users.get(id) ?? id
  const u = users[id]
  if (!u) return id
  // A payload's users dict stores `{ name }`; a raw Slack profile stores
  // `display_name`/`real_name`. Both reach this function, and omitting `name`
  // left every @-mention in a rendered delta showing as a raw user ID.
  return typeof u === 'string' ? u : u.name || u.display_name || u.real_name || id
}

/** Every URL in a message, with Slack's markup unwrapped first. */
export function extractLinks(text) {
  if (!text) return []
  const out = new Set()
  // Unwrap `<url|label>` before scanning, or the trailing `|label>` is captured
  // as part of the URL — which is how a links index ends up full of entries
  // ending in `>`.
  const unwrapped = text.replace(/<(https?:[^|>]+)\|[^>]*>/g, '$1').replace(/<(https?:[^>]+)>/g, '$1')
  for (const m of unwrapped.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) {
    out.add(m[0].replace(/[.,;:]+$/, ''))
  }
  return [...out]
}

/** Google document id, so the same sheet pasted five ways dedupes to one entry. */
export function googleDocId(url) {
  const m =
    url.match(/docs\.google\.com\/(spreadsheets|document|presentation)\/d\/(?:e\/)?([a-zA-Z0-9_-]{20,})/) ||
    url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=)([a-zA-Z0-9_-]{20,})/)
  if (!m) return null
  return m.length === 3 ? { kind: m[1], id: m[2] } : { kind: 'drive', id: m[1] }
}

export function isoOf(ts) {
  return new Date(Number(ts) * 1000).toISOString()
}

/** `2026-09-04 14:26` in the workspace timezone. */
export function fmtTime(ts, timezone) {
  const d = new Date(Number(ts) * 1000)
  try {
    const parts = new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d)
    return parts.replace(',', '')
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ')
  }
}

/**
 * Messages Slack generates rather than people. Dropped from transcripts — and
 * COUNTED, so a reader can tell "nothing happened here" from "the filter ate it".
 */
export const MECHANICAL_SUBTYPES = new Set([
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'group_join',
  'group_leave',
  'bot_add',
  'bot_remove',
  'pinned_item',
  'reminder_add',
  'thread_broadcast_join',
])

export function isMechanical(m) {
  return !!m.subtype && MECHANICAL_SUBTYPES.has(m.subtype)
}

/**
 * A stable label for any conversation shape. Channels have a `name`; group DMs
 * carry an `mpdm-…` name; 1:1 DMs have neither and are named after the other
 * person. This string is both the human label AND a lookup key, so it must be
 * deterministic for a given conversation.
 */
export function conversationName(c, users) {
  if (c.is_im) return `dm:${nameOf(users, c.user)}`
  return c.name ?? c.id ?? 'unknown'
}

/**
 * Conversation type. Inferred from the shape flags where available, and from
 * the name otherwise — a stored payload has a name but not always the flags.
 * Getting this wrong once filed 27 private conversations under `general`.
 */
export function conversationType(c) {
  if (c.is_im) return 'dm'
  if (c.is_mpim) return 'group-dm'
  if (c.is_private) return 'private'
  const name = c.name ?? ''
  if (/^dm:/.test(name)) return 'dm'
  if (/^mpdm-/.test(name)) return 'group-dm'
  return 'channel'
}

export function slugify(name) {
  return String(name)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/** Compile a config's string patterns once, skipping any that do not compile. */
export function compilePatterns(patterns, flags = 'i') {
  const out = []
  for (const p of patterns ?? []) {
    const src = typeof p === 'string' ? p : p.pattern
    const weight = typeof p === 'string' ? 1 : (p.weight ?? 1)
    try {
      out.push({ re: new RegExp(src, flags), weight, source: src })
    } catch {
      // A bad pattern in config must not take the whole run down; it is a
      // config typo, and the run still has real work to do.
    }
  }
  return out
}

export function scoreText(text, compiled) {
  let score = 0
  const hits = []
  for (const { re, weight, source } of compiled) {
    if (re.test(text)) {
      score += weight
      hits.push(source)
    }
  }
  return { score, hits }
}
