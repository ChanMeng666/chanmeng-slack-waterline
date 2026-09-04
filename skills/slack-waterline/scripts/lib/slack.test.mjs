// Offline assertions on token resolution. No network.
//
//   node --test skills/slack-waterline/scripts/lib/slack.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadTokens } from './slack.mjs'

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'waterline-env-'))
  const saved = { user: process.env.SLACK_USER_TOKEN, bot: process.env.SLACK_BOT_TOKEN }
  delete process.env.SLACK_USER_TOKEN
  delete process.env.SLACK_BOT_TOKEN
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    if (saved.user !== undefined) process.env.SLACK_USER_TOKEN = saved.user
    if (saved.bot !== undefined) process.env.SLACK_BOT_TOKEN = saved.bot
  }
}

const env = (dir, body) => writeFileSync(join(dir, '.env'), body)

test('loadTokens: reads both tokens from .env', () => {
  withDir((dir) => {
    env(dir, 'SLACK_USER_TOKEN=xoxp-aaa\nSLACK_BOT_TOKEN=xoxb-bbb\n')
    assert.deepEqual(loadTokens(dir), { user: 'xoxp-aaa', bot: 'xoxb-bbb' })
  })
})

test('loadTokens: the .env.example placeholder is NOT a token', () => {
  // `cp .env.example .env` is the most common first move. Treating the
  // placeholder as real produces `invalid_auth`, which reads like a revoked
  // credential rather than "you have not filled this in yet".
  withDir((dir) => {
    env(dir, 'SLACK_USER_TOKEN=xoxp-your-token-here\n')
    assert.deepEqual(loadTokens(dir), { user: '', bot: '' })
  })
})

test('loadTokens: strips quotes and surrounding whitespace', () => {
  withDir((dir) => {
    env(dir, '  SLACK_USER_TOKEN = "xoxp-quoted"  \n')
    assert.equal(loadTokens(dir).user, 'xoxp-quoted')
  })
})

test('loadTokens: ignores comments and unrelated keys', () => {
  withDir((dir) => {
    env(dir, '# SLACK_USER_TOKEN=xoxp-commented\nOTHER=1\nSLACK_USER_TOKEN=xoxp-real\n')
    assert.equal(loadTokens(dir).user, 'xoxp-real')
  })
})

test('loadTokens: the environment wins over the file', () => {
  // So an ad-hoc override does not require editing a file, and CI can supply a
  // token to a directory that has none.
  withDir((dir) => {
    env(dir, 'SLACK_USER_TOKEN=xoxp-from-file\n')
    process.env.SLACK_USER_TOKEN = 'xoxp-from-env'
    assert.equal(loadTokens(dir).user, 'xoxp-from-env')
  })
})

test('loadTokens: a missing .env is empty, not an error', () => {
  withDir((dir) => {
    assert.deepEqual(loadTokens(dir), { user: '', bot: '' })
  })
})

test('loadTokens: CRLF line endings parse', () => {
  withDir((dir) => {
    env(dir, 'SLACK_USER_TOKEN=xoxp-crlf\r\nSLACK_BOT_TOKEN=xoxb-crlf\r\n')
    assert.deepEqual(loadTokens(dir), { user: 'xoxp-crlf', bot: 'xoxb-crlf' })
  })
})
