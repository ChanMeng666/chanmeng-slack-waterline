#!/usr/bin/env node
// Get from nothing to a working workspace, and say exactly what is left.
//
//   node setup.mjs                            # diagnose; prints the next step
//   node setup.mjs --workspace acme
//   node setup.mjs --manifest                 # the Slack app manifest to paste
//   node setup.mjs --token-from-clipboard     # clipboard → .env, then verify
//   node setup.mjs --verify                   # granted scopes vs required
//
// Every check prints ✓ or ✗ and, when something is missing, the exact command
// or click that fixes it. It stops at the first real blocker rather than
// printing a wall of consequences.
//
// THE TOKEN IS NEVER PRINTED. `--token-from-clipboard` exists precisely so a
// live credential can reach `.env` without passing through a terminal, a chat
// transcript, or a shell history file.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { Slack, note, fail, refuse, runMain } from './lib/slack.mjs'
import { loadRegistry, argValue, hasFlag, REGISTRY_PATH } from './lib/config.mjs'

// ---------------------------------------------------------------- scopes

// Without these the skill cannot do the thing it exists to do.
const REQUIRED_USER = [
  ['channels:history', 'read public channel messages'],
  ['channels:read', 'list public channels'],
  ['groups:history', 'read private channel messages'],
  ['groups:read', 'list private channels'],
  ['im:history', 'read your DMs'],
  ['im:read', 'list your DMs'],
  ['mpim:history', 'read your group DMs'],
  ['mpim:read', 'list your group DMs'],
  ['users:read', 'turn user IDs into names'],
]

// Everything still works without these; specific features go quiet.
const OPTIONAL_READ = [
  ['files:read', 'download attachments'],
  ['pins:read', 'pinned messages — canonical content'],
  ['bookmarks:read', 'channel bookmarks'],
]

// Only needed for the digest DM and for replying.
const WRITE = [
  ['chat:write', 'post and edit as you'],
  ['im:write', 'open a DM, including with yourself'],
]

const ALL_USER_SCOPES = [...REQUIRED_USER, ...OPTIONAL_READ, ...WRITE].map(([s]) => s)

const argv = process.argv.slice(2)

await runMain(async () => {
  if (hasFlag(argv, 'manifest')) return emitManifest()
  if (hasFlag(argv, 'token-from-clipboard')) return await takeTokenFromClipboard()
  if (hasFlag(argv, 'verify')) return await verifyScopes()
  await diagnose()
})

// ================================================================== diagnose

async function diagnose() {
  const steps = []
  const ok = (label, detail) => steps.push({ state: 'ok', label, detail })
  const todo = (label, detail, how) => steps.push({ state: 'todo', label, detail, how })

  // ---- 1. Node
  const major = Number(process.versions.node.split('.')[0])
  if (major >= 18) ok('Node ' + process.versions.node, 'has global fetch and node --test')
  else {
    todo('Node ' + process.versions.node + ' is too old', 'this skill needs Node 18+ for global fetch', 'Install Node 18 or newer: https://nodejs.org')
    return render(steps)
  }

  // ---- 2. A workspace
  const registry = loadRegistry()
  const slugs = Object.keys(registry.workspaces)
  const wanted = argValue(argv, 'workspace') ?? argValue(argv, 'w') ?? registry.default

  if (!slugs.length) {
    todo(
      'No workspace registered',
      'a workspace is a slug plus a directory that holds its token, read state and archive',
      'node init.mjs --workspace <slug> --dir <path>\n' +
        'e.g.  node init.mjs --workspace acme --dir ~/acme-slack-archive'
    )
    return render(steps)
  }
  if (!wanted || !registry.workspaces[wanted]) {
    todo(
      'No workspace selected',
      `registered: ${slugs.join(', ')}`,
      `node setup.mjs --workspace ${slugs[0]}`
    )
    return render(steps)
  }

  const dataDir = registry.workspaces[wanted].dir
  if (!existsSync(dataDir)) {
    todo(`Workspace "${wanted}" directory is missing`, dataDir, `node init.mjs --workspace ${wanted} --dir ${dataDir}`)
    return render(steps)
  }
  ok(`Workspace "${wanted}"`, dataDir)

  // ---- 3. A token
  const envPath = join(dataDir, '.env')
  const tokens = envTokens(envPath)
  if (!tokens.user && !tokens.bot) {
    todo(
      'No Slack token yet',
      'the skill reads Slack as you, so it needs a user token (xoxp-)',
      manifestInstructions(wanted)
    )
    return render(steps)
  }
  ok(
    tokens.user ? 'User token present' : 'Bot token present (no user token)',
    tokens.user ? envPath : `${envPath} — a bot token CANNOT see a single DM`
  )

  // ---- 4. Is it live?
  const slack = new Slack(dataDir, { require: false })
  let granted
  try {
    granted = await slack.grantedScopes()
  } catch (e) {
    const msg = e.message.replace(/^slack \S+: /, '')
    todo(
      `Slack rejected the token (${msg})`,
      msg === 'invalid_auth'
        ? 'the token is wrong, revoked, or the variable is misspelled — it is SLACK_USER_TOKEN, not SLACK_TOKEN'
        : 'see references/tokens-and-scopes.md',
      `Re-copy the token from https://api.slack.com/apps → your app → OAuth & Permissions,\n` +
        `        then: node setup.mjs --workspace ${wanted} --token-from-clipboard --force`
    )
    return render(steps)
  }
  ok(`Connected to ${granted.identity.team} as ${granted.identity.user}`, `user id ${granted.identity.user_id}`)

  // ---- 5. Scopes
  const missingRequired = REQUIRED_USER.filter(([s]) => !granted.scopes.has(s))
  const missingOptional = OPTIONAL_READ.filter(([s]) => !granted.scopes.has(s))
  const missingWrite = WRITE.filter(([s]) => !granted.scopes.has(s))

  if (missingRequired.length) {
    todo(
      `${missingRequired.length} required scope(s) missing`,
      missingRequired.map(([s, why]) => `${s} — ${why}`).join('\n            '),
      'Add them at https://api.slack.com/apps → your app → OAuth & Permissions →\n' +
        '        User Token Scopes, then REINSTALL the app (adding a scope does\n' +
        '        nothing until you reinstall), then re-copy the token:\n' +
        `        node setup.mjs --workspace ${wanted} --token-from-clipboard --force`
    )
    return render(steps)
  }
  ok(`All ${REQUIRED_USER.length} required read scopes granted`, 'channels, private channels, DMs, group DMs, users')

  if (missingOptional.length) {
    steps.push({
      state: 'warn',
      label: `${missingOptional.length} optional scope(s) missing`,
      detail: missingOptional.map(([s, why]) => `${s} — ${why} will be silently absent`).join('\n            '),
    })
  } else {
    ok('Attachments, pins and bookmarks readable', 'files:read, pins:read, bookmarks:read')
  }

  if (missingWrite.length) {
    steps.push({
      state: 'warn',
      label: 'Read-only — cannot DM you the digest or send replies',
      detail: missingWrite.map(([s, why]) => `${s} — ${why}`).join('\n            ') +
        '\n            This is a defensible way to run it. report.mjs still writes to a file.',
    })
  } else {
    ok('Can DM you the digest and send replies', 'chat:write, im:write')
  }

  // ---- 6. Has it ever read anything?
  const statePath = join(dataDir, 'state.json')
  const known = existsSync(statePath)
    ? Object.keys(JSON.parse(readFileSync(statePath, 'utf8')).channels ?? {}).length
    : 0
  if (!known) {
    todo(
      'Nothing has been read yet',
      'the manifest is empty, so there is no waterline to be below',
      `node discover.mjs --workspace ${wanted} --all\n` +
        `node catchup.mjs --workspace ${wanted} --unread`
    )
  } else {
    ok(`${known} conversations in the read state`, statePath)
    steps.push({
      state: 'next',
      label: 'Ready',
      detail:
        `node catchup.mjs --workspace ${wanted} --unread     # read what is new\n` +
        `            node report.mjs  --workspace ${wanted} --period day   # today's digest\n` +
        `node audit.mjs   --workspace ${wanted}                # is the record honest?`,
    })
  }

  render(steps)
}

/**
 * Indent a block consistently, whatever indentation the source string carried.
 *
 * These strings are assembled from concatenated JS literals, so their leading
 * whitespace reflects where they sit in this file rather than how they should
 * look on a terminal. Stripping it here means a message can be edited without
 * anyone having to think about the column it happens to start in.
 */
function block(text, indent) {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''))
  const widths = lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length)
  const common = widths.length ? Math.min(...widths) : 0
  return lines.map((l) => (l.trim() ? indent + l.slice(common) : '')).join('\n')
}

function render(steps) {
  console.log('')
  for (const s of steps) {
    const mark = { ok: '  ✓', todo: '  ✗', warn: '  !', next: '  →' }[s.state]
    console.log(`${mark} ${s.label}`)
    if (s.detail) console.log(block(s.detail, '      '))
    if (s.how) {
      console.log('')
      console.log('      Do this:')
      console.log(block(s.how, '        '))
    }
  }
  const blocked = steps.find((s) => s.state === 'todo')
  console.log('')
  if (blocked) {
    console.log('Blocked on the ✗ above. Run this again after fixing it.')
    process.exitCode = 1
  }
}

// ================================================================== manifest

function manifestInstructions(slug) {
  return (
    'Create the Slack app from a manifest — that sets every scope at once,\n' +
    'instead of you clicking twelve of them.\n' +
    '\n' +
    `  node setup.mjs --workspace ${slug} --manifest --out slack-app.yaml\n` +
    '\n' +
    '1. Open https://api.slack.com/apps\n' +
    '2. "Create New App" → "From an app manifest"\n' +
    '3. Pick your workspace → paste the YAML → Next → Create\n' +
    '4. "Install to Workspace" → Allow\n' +
    '5. "OAuth & Permissions" → click Copy under "User OAuth Token"\n' +
    `6. node setup.mjs --workspace ${slug} --token-from-clipboard\n` +
    '\n' +
    'Step 6 takes the token straight from the clipboard into .env, so it never\n' +
    'goes through your terminal, your shell history, or a chat transcript.\n' +
    '\n' +
    'Want to be walked through it in the browser instead? Ask your agent:\n' +
    '  "set up my Slack token in Chrome"'
  )
}

function emitManifest() {
  const yaml = `display_information:
  name: Slack Waterline
  description: Personal catch-up, digest and reply tooling.
  background_color: "#2d3436"
  long_description: >-
    Reads a Slack workspace on your behalf so nothing goes unread: channels,
    DMs, group DMs, thread replies, pins and attachments. Tracks a per-thread
    read position so a reply on an old parent still surfaces, writes a daily or
    weekly digest to your own DM, and drafts replies for you to approve.
    Everything runs locally; nothing is sent anywhere but Slack.
features:
  bot_user:
    display_name: Slack Waterline
    always_online: false
oauth_config:
  scopes:
    user:
${ALL_USER_SCOPES.map((s) => `      - ${s}`).join('\n')}
    bot:
      - channels:history
      - channels:read
      - channels:join
      - groups:history
      - groups:read
      - users:read
      - files:read
      - pins:read
      - bookmarks:read
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`

  const out = argValue(argv, 'out')
  if (out) {
    mkdirSync(join(out, '..'), { recursive: true })
    writeFileSync(out, yaml)
    note(`wrote ${out}`)
    note('')
    note('Next: https://api.slack.com/apps → Create New App → From an app manifest')
    note('      Pick your workspace, paste this file, Create, then Install to Workspace.')
  } else {
    process.stdout.write(yaml)
  }
}

// ================================================================== clipboard

/**
 * Take the token from the clipboard rather than from an argument.
 *
 * A token passed as `--token xoxp-…` lands in shell history, in the process
 * list, and — when an agent is driving — in a conversation transcript that
 * outlives the session. The clipboard is the one channel that already holds it
 * (you just clicked Copy) and that nothing else records.
 *
 * So this reads it, checks its shape, writes it, verifies it against Slack, and
 * prints only who it belongs to.
 */
async function takeTokenFromClipboard() {
  const registry = loadRegistry()
  const slug = argValue(argv, 'workspace') ?? argValue(argv, 'w') ?? registry.default
  if (!slug || !registry.workspaces[slug]) {
    refuse(
      'No workspace selected.\n' +
        `  Registered: ${Object.keys(registry.workspaces).join(', ') || '(none)'}\n` +
        '  Run init.mjs first, or pass --workspace <slug>.'
    )
  }
  const dataDir = registry.workspaces[slug].dir
  const envPath = join(dataDir, '.env')

  const clip = readClipboard().trim()
  if (!clip) refuse('The clipboard is empty. Copy the token from Slack first, then re-run.')

  const m = clip.match(/^(xox[pbe])-[A-Za-z0-9-]{10,}$/)
  if (!m) {
    // Says nothing about what it DID find. The clipboard belongs to the user and
    // routinely holds passwords, addresses and half-written messages; echoing
    // even a few characters of it into a terminal or an agent transcript is a
    // leak this tool has no reason to risk. Length and prefix-shape are enough
    // to tell the three likely mistakes apart.
    refuse(
      'The clipboard does not hold a Slack token.\n' +
        `  Expected one starting xoxp- (user) or xoxb- (bot); found ${clip.length} characters` +
        `${clip.startsWith('xox') ? ' that start with "xox" but do not match a token' : ' that do not start with "xox"'}.\n` +
        '  On the OAuth & Permissions page click Copy under "User OAuth Token" —\n' +
        '  not Client Secret, not Signing Secret, not the App ID.'
    )
  }

  const kind = m[1] === 'xoxb' ? 'bot' : 'user'
  const varName = kind === 'bot' ? 'SLACK_BOT_TOKEN' : 'SLACK_USER_TOKEN'

  const existing = envTokens(envPath)
  if (existing[kind] && !hasFlag(argv, 'force')) {
    refuse(
      `${envPath} already has a ${varName}.\n` +
        '  Re-run with --force to replace it. The old one is not recoverable from here,\n' +
        '  so revoke it at https://api.slack.com/apps if it is still live.'
    )
  }

  writeEnvVar(envPath, varName, clip)
  note(`wrote ${varName} to ${envPath}`)

  // Verify immediately. A token that was pasted but never checked is a setup
  // that fails tomorrow morning instead of now.
  const slack = new Slack(dataDir, { require: false })
  let granted
  try {
    granted = await slack.grantedScopes()
  } catch (e) {
    refuse(
      `Slack rejected it: ${e.message.replace(/^slack \S+: /, '')}\n` +
        '  The token was still written. Check you copied the whole thing, then\n' +
        '  re-run with --force.'
    )
  }

  console.log(`\n✓ ${granted.identity.team} — ${granted.identity.user} (${granted.identity.user_id})`)
  const missing = REQUIRED_USER.filter(([s]) => !granted.scopes.has(s))
  if (missing.length && kind === 'user') {
    console.log(`\n! ${missing.length} required scope(s) missing: ${missing.map(([s]) => s).join(', ')}`)
    console.log('  Add them, REINSTALL the app, and re-copy the token.')
  }
  console.log(`\nNext: node setup.mjs --workspace ${slug}`)
}

function readClipboard() {
  const attempts =
    process.platform === 'win32'
      ? [['powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw']]]
      : process.platform === 'darwin'
        ? [['pbpaste', []]]
        : [
            ['wl-paste', ['--no-newline']],
            ['xclip', ['-selection', 'clipboard', '-o']],
            ['xsel', ['--clipboard', '--output']],
          ]

  for (const [cmd, args] of attempts) {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      /* try the next one */
    }
  }
  refuse(
    'Could not read the clipboard on this platform.\n' +
      (process.platform === 'linux' ? '  Install wl-clipboard or xclip, or ' : '  ') +
      'paste the token into the workspace .env by hand:\n' +
      '    SLACK_USER_TOKEN=xoxp-…'
  )
}

// ================================================================== verify

async function verifyScopes() {
  const registry = loadRegistry()
  const slug = argValue(argv, 'workspace') ?? argValue(argv, 'w') ?? registry.default
  if (!slug || !registry.workspaces[slug]) refuse('No workspace selected. Pass --workspace <slug>.')
  const dataDir = registry.workspaces[slug].dir

  const slack = new Slack(dataDir)
  const { identity, scopes } = await slack.grantedScopes()

  console.log(`\n${identity.team} — ${identity.user} (${identity.user_id})`)
  console.log(`Token: ${slack.usingUserToken ? 'SLACK_USER_TOKEN (user)' : 'SLACK_BOT_TOKEN (bot)'}\n`)

  const groups = [
    ['REQUIRED', REQUIRED_USER],
    ['OPTIONAL', OPTIONAL_READ],
    ['WRITE', WRITE],
  ]
  let missingRequired = 0
  for (const [title, list] of groups) {
    console.log(`  ${title}`)
    for (const [scope, why] of list) {
      const has = scopes.has(scope)
      if (!has && title === 'REQUIRED') missingRequired++
      console.log(`    ${has ? '✓' : '✗'} ${scope.padEnd(18)} ${why}`)
    }
    console.log('')
  }

  const extra = [...scopes].filter((s) => !ALL_USER_SCOPES.includes(s))
  if (extra.length) console.log(`  Also granted: ${extra.join(', ')}\n`)

  if (missingRequired) {
    console.log(
      'Add the missing scopes at https://api.slack.com/apps → OAuth & Permissions,\n' +
        'then REINSTALL the app. A scope added but not reinstalled does nothing —\n' +
        'the config page and this list will disagree until you do.'
    )
    process.exitCode = 1
  } else {
    console.log('Every required scope is granted.')
  }

  if (!slack.usingUserToken) {
    console.log(
      '\n! This is a bot token. It cannot see a single DM — not "no DMs found",\n' +
        '  invisible. Add a user token to catch up on your own conversations.'
    )
  }
}

// ================================================================== env io

function envTokens(envPath) {
  const out = { user: '', bot: '' }
  if (!existsSync(envPath)) return out
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(SLACK_USER_TOKEN|SLACK_BOT_TOKEN)\s*=\s*(.+?)\s*$/)
    if (!m) continue
    const v = m[2].replace(/^["']|["']$/g, '')
    if (!v || v.includes('your-token-here')) continue
    out[m[1] === 'SLACK_USER_TOKEN' ? 'user' : 'bot'] = v
  }
  return out
}

/** Replace the line if present, append if not. Comments and order survive. */
function writeEnvVar(envPath, name, value) {
  mkdirSync(join(envPath, '..'), { recursive: true })
  const lines = existsSync(envPath) ? readFileSync(envPath, 'utf8').split(/\r?\n/) : []
  let replaced = false
  const out = lines.map((line) => {
    if (new RegExp(`^\\s*${name}\\s*=`).test(line)) {
      replaced = true
      return `${name}=${value}`
    }
    return line
  })
  if (!replaced) {
    if (out.length && out[out.length - 1] !== '') out.push('')
    out.push(`${name}=${value}`)
  }
  writeFileSync(envPath, out.join('\n').replace(/\n{3,}$/, '\n\n'))
}
