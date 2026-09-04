#!/usr/bin/env node
// Scaffold and register one Slack workspace.
//
//   node init.mjs --workspace acme --dir D:/repos/acme-slack-archive
//   node init.mjs --workspace acme --dir ./acme-slack-archive --git
//   node init.mjs --list
//
// Creates the data directory, writes a starter config and a .gitignore that
// keeps the token out of git, and records the slug → path mapping in
// ~/.slack-waterline/config.json so every other script can be run with just
// `--workspace acme`.
//
// Safe to re-run: existing files are never overwritten.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

import { Slack, note, fail, finish } from './lib/slack.mjs'
import {
  DEFAULT_WORKSPACE_CONFIG,
  loadRegistry,
  registerWorkspace,
  argValue,
  hasFlag,
  REGISTRY_PATH,
} from './lib/config.mjs'

const argv = process.argv.slice(2)

if (hasFlag(argv, 'list')) {
  const registry = loadRegistry()
  const slugs = Object.keys(registry.workspaces)
  if (!slugs.length) {
    console.log('No workspaces registered yet.\n  node init.mjs --workspace <slug> --dir <path>')
    process.exit(0)
  }
  console.log(`Registry: ${REGISTRY_PATH}\n`)
  for (const slug of slugs.sort()) {
    const marker = slug === registry.default ? ' (default)' : ''
    const dir = registry.workspaces[slug].dir
    const ok = existsSync(dir) ? '' : '   ← MISSING'
    console.log(`  ${slug}${marker}\n      ${dir}${ok}`)
  }
  process.exit(0)
}

const slug = argValue(argv, 'workspace')
const dirArg = argValue(argv, 'dir')

if (!slug || !dirArg) {
  fail(
    'Usage: node init.mjs --workspace <slug> --dir <path> [--git] [--default]\n' +
      '       node init.mjs --list'
  )
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
  fail(`--workspace must be lowercase-kebab (letters, digits, hyphens). Got: ${slug}`)
}

const dataDir = resolve(dirArg)
const created = []

function write(relPath, content) {
  const path = join(dataDir, relPath)
  if (existsSync(path)) {
    note(`  kept    ${relPath} (already exists)`)
    return
  }
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  created.push(relPath)
  note(`  created ${relPath}`)
}

note(`Workspace "${slug}" → ${dataDir}\n`)
mkdirSync(dataDir, { recursive: true })
for (const d of ['raw', 'reports', 'tmp', '.cache']) mkdirSync(join(dataDir, d), { recursive: true })

// ---------------------------------------------------------------- config

write(
  'config.json',
  JSON.stringify({ ...DEFAULT_WORKSPACE_CONFIG, name: slug }, null, 2) + '\n'
)

// ---------------------------------------------------------------- secrets

write(
  '.env.example',
  `# Slack credentials for the "${slug}" workspace.
#
# SLACK_USER_TOKEN acts as you: your DMs, your group DMs, every private channel
# you are in — with nobody inviting a bot. For reading, it is a strict superset
# of a bot token, and it is what this skill is built around.
#
# SLACK_BOT_TOKEN is optional. It is only needed to auto-join public channels
# without posting a visible "has joined" line as you.
#
# See references/tokens-and-scopes.md for the scope list and how to mint these.

SLACK_USER_TOKEN=xoxp-your-token-here
# SLACK_BOT_TOKEN=xoxb-your-token-here
`
)

write(
  '.gitignore',
  `# The token. Never commit this.
.env

# Local caches — user directory, triage output. Rebuildable, and .cache/triage
# can contain message excerpts.
.cache/
tmp/

# Verbatim Slack payloads. Commit these ONLY if this repo is private and you
# want a durable archive; they contain full message text including DMs.
# Delete the next line to start archiving.
raw/

# The audit trail of everything this machine posted to Slack.
sent.log.jsonl
`
)

// ---------------------------------------------------------------- readme

write(
  'README.md',
  `# ${slug} — Slack archive

Data directory for the [slack-waterline](https://github.com/ChanMeng666/slack-waterline-skill)
skill. Not a codebase — this holds read state and message history for the
\`${slug}\` Slack workspace.

| File | What it is |
|---|---|
| \`state.json\` | The manifest. What has been read, scored, and is still outstanding. **Commit this.** |
| \`config.json\` | Watch scope, signal patterns, reply heuristics, report preferences. |
| \`.env\` | Slack token. **Never committed.** |
| \`raw/\` | Verbatim fetch payloads, one per conversation. |
| \`conversations/\` | Generated Markdown transcripts. Wiped and rebuilt — never hand-edit. |
| \`reports/\` | Generated daily and weekly digests. |
| \`sent.log.jsonl\` | Append-only record of everything posted to Slack from this machine. |

**This directory contains private conversations.** If it is a git repo, keep it
private. Never open-source it, and never paste its contents into a public issue.

## Everyday use

Point your agent at it:

> Catch me up on ${slug} Slack.

Or drive it directly:

\`\`\`bash
node <skill>/scripts/catchup.mjs --workspace ${slug} --unread
node <skill>/scripts/report.mjs  --workspace ${slug} --period day
\`\`\`
`
)

// ---------------------------------------------------------------- git

if (hasFlag(argv, 'git') && !existsSync(join(dataDir, '.git'))) {
  try {
    execFileSync('git', ['init', '-q'], { cwd: dataDir, stdio: 'inherit' })
    note('  created .git (private repo recommended — this holds DM content)')
  } catch (e) {
    note(`  git init failed: ${e.message}`)
  }
}

// ---------------------------------------------------------------- register

registerWorkspace(slug, dataDir, { makeDefault: hasFlag(argv, 'default') })
note(`\nRegistered in ${REGISTRY_PATH}`)

// ---------------------------------------------------------------- verify token

const slack = new Slack(dataDir, { require: false })
if (!slack.token) {
  console.log(
    `\nNext: put a token in ${join(dataDir, '.env')}\n` +
      `  cp ${join(dataDir, '.env.example')} ${join(dataDir, '.env')}\n\n` +
      'Mint one at https://api.slack.com/apps → your app → OAuth & Permissions.\n' +
      'User token scopes for full read coverage:\n' +
      '  channels:history channels:read groups:history groups:read\n' +
      '  im:history im:read mpim:history mpim:read\n' +
      '  users:read files:read pins:read bookmarks:read\n' +
      'Add chat:write only if you want the digest DM and reply sending.\n\n' +
      'Then verify:  node init.mjs --workspace ' + slug + ' --dir ' + dataDir
  )
  await finish(0)
}

slack.announceIdentity()
try {
  const me = await slack.call('auth.test', {})
  console.log(`\n✓ Connected to ${me.team} as ${me.user} (${me.user_id})`)

  const convos = await slack.all(
    'users.conversations',
    { types: slack.conversationTypes, exclude_archived: true },
    'channels'
  )
  const byType = { channel: 0, private: 0, dm: 0, 'group-dm': 0 }
  for (const c of convos) {
    if (c.is_im) byType.dm++
    else if (c.is_mpim) byType['group-dm']++
    else if (c.is_private) byType.private++
    else byType.channel++
  }
  console.log(
    `  visible: ${convos.length} conversations — ` +
      `${byType.channel} public, ${byType.private} private, ${byType.dm} DMs, ${byType['group-dm']} group DMs`
  )

  if (!slack.usingUserToken) {
    console.log(
      '\n  ⚠ Running on a bot token. DMs and group DMs are invisible to it — not\n' +
        '    "empty", invisible. Add SLACK_USER_TOKEN to see your own conversations.'
    )
  }

  console.log(`\nNext:\n  node discover.mjs --workspace ${slug} --all`)
} catch (e) {
  console.error(`\n✗ ${e.message}`)
  if (/invalid_auth|not_authed/.test(e.message)) {
    console.error(
      '  The token was rejected. Check it is SLACK_USER_TOKEN (not SLACK_TOKEN),\n' +
        '  that it starts with xoxp- or xoxb-, and that it has not been revoked.'
    )
  }
  if (/missing_scope/.test(e.message)) {
    console.error('  Add the missing scope in your Slack app, then REINSTALL the app to the workspace.')
  }
  await finish(1)
}
