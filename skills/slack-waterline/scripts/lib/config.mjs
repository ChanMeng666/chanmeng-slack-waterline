// Workspace resolution: one skill installation, many Slack workspaces.
//
// A registry at ~/.slack-waterline/config.json maps a workspace slug to a data
// directory. The data directory holds everything specific to that workspace —
// its token, its config, its manifest, its archive.
//
// TOKENS NEVER LIVE IN THE REGISTRY, and never in the skill repo. They live in
// the data directory's `.env`, which the scaffolded `.gitignore` excludes. The
// registry holds paths and nothing else, so it can be read without care.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { fail } from './slack.mjs'

export const REGISTRY_DIR = join(homedir(), '.slack-waterline')
export const REGISTRY_PATH = join(REGISTRY_DIR, 'config.json')

export function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) return { default: null, workspaces: {} }
  try {
    const raw = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'))
    return { default: raw.default ?? null, workspaces: raw.workspaces ?? {} }
  } catch (e) {
    fail(`${REGISTRY_PATH} is not valid JSON (${e.message}). Fix or delete it.`)
  }
}

export function saveRegistry(registry) {
  mkdirSync(REGISTRY_DIR, { recursive: true })
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n')
}

export function registerWorkspace(slug, dir, { makeDefault = false } = {}) {
  const registry = loadRegistry()
  registry.workspaces[slug] = { dir: resolve(dir) }
  if (makeDefault || !registry.default) registry.default = slug
  saveRegistry(registry)
  return registry
}

/**
 * Defaults for a workspace's own `config.json`.
 *
 * Everything org-specific in the systems this was generalized from lives here
 * rather than in code — the signal patterns, the reply heuristics, what is
 * deliberately not read. That is the whole difference between a tool for one
 * company and a tool you can take to the next one.
 */
export const DEFAULT_WORKSPACE_CONFIG = {
  name: '',
  timezone: 'Pacific/Auckland',
  language: 'en',

  // First-ever run only. Without this the first `catchup` pulls all history.
  firstRunLookbackDays: 7,

  // Conversations to enumerate. `null` means "everything the token can see",
  // which is the point of the skill; an allowlist is available for a workspace
  // where that is genuinely too much.
  watch: null,
  excludeChannels: [],

  // Does an unmapped conversation deserve attention? Weighted, thresholded, and
  // deliberately conservative — the gate decides PRIORITY, never whether
  // something is read. Anything mapped `track` or flagged `alwaysRead` bypasses
  // this entirely.
  signal: {
    threshold: 3,
    patterns: [
      { pattern: '\\bblock(ed|er|ing)?\\b', weight: 3 },
      { pattern: '\\b(urgent|asap|critical|p0|sev1)\\b', weight: 3 },
      { pattern: '\\b(deadline|due (today|tomorrow|by)|end of day|eod)\\b', weight: 2 },
      { pattern: '\\b(decision|decide|sign ?off|approve|approval)\\b', weight: 2 },
      { pattern: '\\b(review|feedback|thoughts)\\b', weight: 1 },
      { pattern: '\\b(release|deploy|incident|outage|rollback)\\b', weight: 1 },
    ],
  },

  // Does this message want something from you? Seeded from a queue that ran
  // daily for months. A DM, a mention, or an attachment counts regardless.
  needsReply: {
    patterns: [
      '\\?',
      '\\bcould you\\b',
      '\\bcan you\\b',
      '\\bplease\\b',
      '\\bwould you\\b',
      '\\bconfirm\\b',
      '\\blet me know\\b',
      '\\bthoughts\\b',
      '\\bapprove\\b',
      '\\bblocked\\b',
      '\\bwaiting on\\b',
      '\\bASAP\\b',
    ],
  },

  report: {
    // Where a `--send` digest goes. "@me" is your own DM-with-self.
    deliverTo: '@me',
    includeContext: true,
    maxItemsPerSection: 40,
  },

  // Optional. Any shell command whose stdout is hashed to detect that the thing
  // this workspace feeds changed out of band. Leave null if nothing is fed.
  // The hash is opaque to the skill, so this works for a JSON file, a git
  // rev-parse, an API response — anything with stable output.
  fingerprintCommand: null,
}

export function loadWorkspaceConfig(dataDir) {
  const path = join(dataDir, 'config.json')
  if (!existsSync(path)) return { ...DEFAULT_WORKSPACE_CONFIG }
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    fail(`${path} is not valid JSON (${e.message}).`)
  }
  // Shallow-merge with a nested merge for the object-valued keys, so a config
  // that overrides one signal pattern does not lose the report defaults.
  return {
    ...DEFAULT_WORKSPACE_CONFIG,
    ...raw,
    signal: { ...DEFAULT_WORKSPACE_CONFIG.signal, ...(raw.signal ?? {}) },
    needsReply: { ...DEFAULT_WORKSPACE_CONFIG.needsReply, ...(raw.needsReply ?? {}) },
    report: { ...DEFAULT_WORKSPACE_CONFIG.report, ...(raw.report ?? {}) },
  }
}

/**
 * Which workspace is this command about?
 *
 * Precedence: `--workspace <slug|path>` → SLACK_WATERLINE_DIR → the registry
 * default. An explicit path is accepted anywhere a slug is, so a workspace can
 * be driven before it is registered.
 */
export function resolveWorkspace(argv = process.argv.slice(2)) {
  const flag = argValue(argv, 'workspace') ?? argValue(argv, 'w')
  const registry = loadRegistry()

  let slug = null
  let dir = null

  if (flag) {
    if (registry.workspaces[flag]) {
      slug = flag
      dir = registry.workspaces[flag].dir
    } else if (isAbsolute(flag) || flag.startsWith('.')) {
      dir = resolve(flag)
      slug = dir.split(/[\\/]/).filter(Boolean).pop()
    } else {
      const known = Object.keys(registry.workspaces)
      fail(
        `Unknown workspace "${flag}".` +
          (known.length ? ` Registered: ${known.join(', ')}` : ' None registered yet — run init.mjs first.')
      )
    }
  } else if (process.env.SLACK_WATERLINE_DIR) {
    dir = resolve(process.env.SLACK_WATERLINE_DIR)
    slug = dir.split(/[\\/]/).filter(Boolean).pop()
  } else if (registry.default && registry.workspaces[registry.default]) {
    slug = registry.default
    dir = registry.workspaces[registry.default].dir
  } else {
    fail(
      'No workspace selected and none registered.\n' +
        'Run:  node init.mjs --workspace <slug> --dir <path>\n' +
        'Or pass --workspace <slug|path> to this command.'
    )
  }

  if (!existsSync(dir)) {
    fail(`Workspace directory does not exist: ${dir}\nRun init.mjs to create it.`)
  }

  return { slug, dataDir: dir, config: loadWorkspaceConfig(dir) }
}

// ---------------------------------------------------------------- argv helpers

/**
 * `indexOf` returns -1 when a flag is absent, and `argv[-1 + 1]` is `argv[0]` —
 * which silently picks up the FIRST ARGUMENT as the value of a flag nobody
 * passed. Guard the -1 explicitly, every time.
 */
export function argValue(argv, name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) return fallback
  return v
}

export function hasFlag(argv, name) {
  return argv.includes(`--${name}`)
}

/** Positional arguments — everything that is not a flag or a flag's value. */
export function positionals(argv, flagsWithValues = []) {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      if (flagsWithValues.includes(a.slice(2))) i++
      continue
    }
    out.push(a)
  }
  return out
}

/** `7d`, `36h`, `2w`, or a raw Slack ts. Returns a ts string. */
export function parseSince(value) {
  if (!value) return null
  const m = String(value).match(/^(\d+(?:\.\d+)?)([dhw])$/i)
  if (m) {
    const n = Number(m[1])
    const mult = { d: 86400, h: 3600, w: 604800 }[m[2].toLowerCase()]
    return (Date.now() / 1000 - n * mult).toFixed(6)
  }
  if (/^\d+(\.\d+)?$/.test(value)) return String(value)
  fail(`--since must be like 7d, 36h, 2w, or a raw Slack ts. Got: ${value}`)
}
