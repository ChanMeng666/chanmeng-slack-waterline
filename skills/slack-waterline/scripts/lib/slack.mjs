// Slack transport, token resolution, and the workspace user directory.
//
// Zero dependencies. Everything here is `fetch` against the Slack Web API, so
// the skill runs from ~/.claude/skills against any repo without an npm install
// landing in it.
//
// TWO TOKENS CAN BE IN PLAY AND THEY SEE DIFFERENT THINGS:
//
//   SLACK_USER_TOKEN (xoxp-)  acts as the authorising human. Sees everything
//                             that person sees: their DMs, their group DMs, and
//                             every private channel they are in — with nobody
//                             inviting a bot.
//   SLACK_BOT_TOKEN  (xoxb-)  sees public channels it has joined and private
//                             channels it was invited to. Can NEVER see a DM
//                             between two humans.
//
// The user token is preferred whenever present, because for READING it is a
// strict superset. The bot token stays a fallback so a workspace that only has
// one keeps working.
//
// The hard limit, before anyone asks for "no blind spots": a user token still
// cannot read DMs between two OTHER people. That needs Slack's Discovery API,
// which is Enterprise Grid only.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------- token

/**
 * Resolve a token from the environment, else from the workspace `.env`.
 *
 * The regex scrape is deliberate rather than a dotenv dependency: a `.env` that
 * holds one or two keys does not justify a package, and this way the file's
 * quoting rules are visible right here.
 */
export function loadTokens(dataDir) {
  const fromEnv = {
    user: process.env.SLACK_USER_TOKEN?.trim() || '',
    bot: process.env.SLACK_BOT_TOKEN?.trim() || '',
  }
  const envFile = dataDir ? join(dataDir, '.env') : null
  if (envFile && existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(SLACK_USER_TOKEN|SLACK_BOT_TOKEN)\s*=\s*(.+?)\s*$/)
      if (!m) continue
      const key = m[1] === 'SLACK_USER_TOKEN' ? 'user' : 'bot'
      // The environment wins, so an ad-hoc override does not need a file edit.
      if (!fromEnv[key]) fromEnv[key] = m[2].replace(/^["']|["']$/g, '')
    }
  }
  return fromEnv
}

/**
 * A Slack client bound to one workspace's data directory.
 *
 * Two clients on purpose. `conversations.join` on a user token makes THE HUMAN
 * join, which posts a visible "has joined the channel" line into the room. When
 * a bot token exists, joining is the bot's job.
 */
export class Slack {
  constructor(dataDir, { require = true } = {}) {
    const { user, bot } = loadTokens(dataDir)
    this.dataDir = dataDir
    this.userToken = user
    this.botToken = bot
    this.usingUserToken = user.length > 0
    this.token = user || bot
    if (!this.token && require) {
      fail(
        'No Slack token found.\n' +
          `Put one in ${dataDir ? join(dataDir, '.env') : '.env'} as:\n` +
          '  SLACK_USER_TOKEN=xoxp-…\n' +
          'See references/tokens-and-scopes.md for how to mint one.'
      )
    }
    this._users = undefined
    this._userInfoMisses = new Set()
  }

  /**
   * Conversation types to enumerate. `im` and `mpim` are only listable on a
   * user token — asking for them with a bot token returns `missing_scope` and
   * aborts the WHOLE listing, so a bot-token run must not request them.
   */
  get conversationTypes() {
    return this.usingUserToken
      ? 'public_channel,private_channel,mpim,im'
      : 'public_channel,private_channel'
  }

  /** One line on stderr so every run says which identity it read as. */
  announceIdentity() {
    note(
      this.usingUserToken
        ? 'auth: SLACK_USER_TOKEN (user identity — includes DMs, group DMs and your private channels)'
        : 'auth: SLACK_BOT_TOKEN (bot identity — public + invited private channels only, NO DMs)'
    )
  }

  async call(method, params = {}, { post = false, token = this.token } = {}) {
    return request(method, params, { post, token })
  }

  /** POST form of `call`, for the write endpoints that require a JSON body. */
  async post(method, params = {}, opts = {}) {
    return this.call(method, params, { ...opts, post: true })
  }

  /** Walk a cursor-paginated endpoint to exhaustion. */
  async all(method, params, key, { limit = 200, token = this.token } = {}) {
    const out = []
    let cursor
    do {
      const body = await request(method, { ...params, cursor, limit }, { token })
      out.push(...(body[key] || []))
      cursor = body.response_metadata?.next_cursor || ''
    } while (cursor)
    return out
  }

  /**
   * A public channel is readable on a user token WITHOUT joining it, so
   * `is_member` must not gate reading. Private channels and DMs still require
   * actual membership.
   *
   * `memberImplied` is for listings from `users.conversations`, which by
   * definition returns only conversations you are in — and which does not
   * reliably set `is_member` on the objects it returns. Without this, every
   * private channel you are a member of was filtered out of the triage as
   * "not readable", and only the coverage gate noticed they existed at all.
   */
  isReadable(c, { memberImplied = false } = {}) {
    if (c.is_archived) return false
    if (c.is_im || c.is_mpim) return true
    if (!c.is_private && this.usingUserToken) return true
    return memberImplied || !!c.is_member
  }

  /**
   * Workspace user directory, cached on disk.
   *
   * This pages the entire directory, and it is called once per PROCESS. Fetching
   * a hundred conversations therefore walked the whole workspace a hundred
   * times — `users.list` is Tier 2 (20/min), so it was minutes of pure waste per
   * run competing for the same rate-limit budget as the work that mattered.
   *
   * Staleness is cosmetic and self-correcting: every durable record is keyed by
   * channel ID, so a name that lags by a few hours mislabels a row and corrupts
   * nothing. Every failure path degrades to the network, and a cache that cannot
   * be written is not an error — only a slower next run.
   */
  async users() {
    if (this._users) return this._users

    const cacheDir = join(this.dataDir, '.cache')
    const cachePath = join(cacheDir, 'users.json')
    const ttlMs = Number(process.env.SLACK_USERS_CACHE_TTL_MIN || 360) * 60 * 1000

    if (ttlMs > 0) {
      try {
        const raw = JSON.parse(readFileSync(cachePath, 'utf8'))
        if (Date.now() - Date.parse(raw.fetchedAt) < ttlMs && raw.users) {
          this._users = new Map(Object.entries(raw.users))
          return this._users
        }
      } catch {
        /* missing, malformed or expired — fall through and refetch */
      }
    }

    const names = new Map()
    for (const u of await this.all('users.list', {}, 'members', { limit: 500 })) {
      names.set(u.id, u.profile?.display_name || u.real_name || u.name || u.id)
    }

    try {
      mkdirSync(cacheDir, { recursive: true })
      writeFileSync(
        cachePath,
        JSON.stringify({ fetchedAt: new Date().toISOString(), users: Object.fromEntries(names) }, null, 1)
      )
    } catch {
      /* not an error, only a slower next run */
    }

    this._users = names
    return names
  }

  /**
   * Resolve one id the directory lacks — bots, deactivated accounts, and
   * external users in Slack Connect channels are all absent from `users.list`.
   * Misses are remembered so a channel full of one bot does not retry per message.
   */
  async userName(id) {
    if (!id) return 'unknown'
    const users = await this.users()
    const hit = users.get(id)
    if (hit) return hit
    if (this._userInfoMisses.has(id)) return id
    try {
      const r = await this.call('users.info', { user: id })
      const name = r.user?.profile?.display_name || r.user?.real_name || r.user?.name || id
      users.set(id, name)
      return name
    } catch {
      this._userInfoMisses.add(id)
      return id
    }
  }
}

// ---------------------------------------------------------------- transport

const MAX_RETRIES = 6

/**
 * One Slack Web API call, with bounded backoff.
 *
 * Slack signals a rate limit two different ways and both have been seen in
 * practice: HTTP 429 with a `Retry-After` header, and HTTP 200 carrying
 * `{"ok": false, "error": "ratelimited"}`. Handling only one of them looks
 * exactly like a working tool until load arrives.
 *
 * The retry is a bounded loop rather than recursion. An unbounded retry turns a
 * revoked token or a workspace-wide throttle into a process that never exits
 * and never says why.
 */
async function request(method, params, { post = false, token }) {
  let attempt = 0
  for (;;) {
    const opts = { headers: { Authorization: `Bearer ${token}` } }
    let url = `https://slack.com/api/${method}`

    if (post) {
      opts.method = 'POST'
      opts.headers['Content-Type'] = 'application/json; charset=utf-8'
      const body = {}
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body[k] = v
      opts.body = JSON.stringify(body)
    } else {
      const u = new URL(url)
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v))
      }
      url = u
    }

    let res
    let body
    try {
      res = await fetch(url, opts)
      body = await res.json()
    } catch (e) {
      // A transport-level failure is worth one or two retries; a DNS or TLS
      // problem that persists is not, and must surface as itself.
      if (attempt++ >= 2) throw new Error(`slack ${method}: ${e.message}`)
      await sleep(1000 * attempt)
      continue
    }

    if (body.ok) return body

    if (body.error === 'ratelimited' || res.status === 429) {
      if (attempt++ >= MAX_RETRIES) {
        throw new Error(`slack ${method}: rate limited, gave up after ${MAX_RETRIES} retries`)
      }
      const wait = Number(res.headers.get('retry-after') || 5)
      note(`rate limited on ${method}, waiting ${wait}s (retry ${attempt}/${MAX_RETRIES})`)
      await sleep(wait * 1000)
      continue
    }

    throw new Error(`slack ${method}: ${body.error}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- output discipline

/**
 * STDOUT IS THE PAYLOAD. DIAGNOSTICS GO TO STDERR.
 *
 * `fetch.mjs` writes JSON to stdout and every caller redirects it to a file. A
 * logger that writes progress onto the same channel as the data is a bug waiting
 * for load: the scripts this is ported from worked perfectly until a backlog
 * pass hit a rate limit, and then ten of eleven payloads came back as JSON with
 * a retry notice wedged into the middle. The failure looked like a network
 * problem and was a plumbing one.
 *
 * If you add a script here, print with `note`/`fail`, never `console.log`,
 * unless what you are printing IS the output.
 */
export function note(...m) {
  console.error(...m)
}

export function fail(msg, code = 1) {
  console.error(msg)
  process.exit(code)
}

/**
 * A refusal: an expected, explainable reason this command cannot continue —
 * an ambiguous name, a sheet nobody shared, a file the token cannot read.
 *
 * Distinct from `fail` because a refusal can happen AFTER network I/O, and
 * `process.exit()` is not safe there (see `finish`). Throwing lets the script
 * unwind to `runMain`, which prints the message and exits naturally.
 */
export class Refusal extends Error {
  constructor(message, code = 1) {
    super(message)
    this.name = 'Refusal'
    this.code = code
  }
}

export function refuse(msg, code = 1) {
  throw new Refusal(msg, code)
}

/**
 * Run a script body and exit cleanly whatever happens.
 *
 * A Refusal prints its message alone — it is an answer, not a crash, and a stack
 * trace on "that sheet is not shared with you" teaches people to ignore output.
 * Anything else prints its stack, because it is a bug.
 */
export async function runMain(fn) {
  try {
    await fn()
    await finish(process.exitCode ?? 0)
  } catch (e) {
    if (e instanceof Refusal) {
      console.error(e.message)
      await finish(e.code)
    } else {
      console.error(e?.stack ?? String(e))
      await finish(1)
    }
  }
}

/**
 * Exit cleanly after network work.
 *
 * Node's global `fetch` keeps HTTP/1.1 sockets alive for reuse. Calling
 * `process.exit()` while they are open trips a libuv assertion on Windows —
 * `!(handle->flags & UV_HANDLE_CLOSING)` — which aborts the process and REPLACES
 * the exit code with 127. That matters here because the gates deliberately exit
 * with a finding count, and a shell branching on it would read every run as the
 * same catastrophic failure.
 *
 * Closing the dispatcher lets the loop drain, so the intended code survives.
 */
export async function finish(code = 0) {
  process.exitCode = code
  const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')]
  if (dispatcher?.close) {
    try {
      await dispatcher.close()
    } catch {
      /* already closed, or a runtime without one — the exit code still stands */
    }
  }
}
