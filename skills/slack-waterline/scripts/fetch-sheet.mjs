#!/usr/bin/env node
// Read a Google Sheet — EVERY tab — with no credentials.
//
//   node fetch-sheet.mjs 'https://docs.google.com/spreadsheets/d/…/edit#gid=123'
//   node fetch-sheet.mjs '<url>' --tab 'Run Sheet'
//   node fetch-sheet.mjs '<url>' --json --max-rows 500
//
// No auth, by design: a link-viewable sheet serves over the plain CSV export
// endpoint, and requiring a service account would put a credential in front of
// the most common case.
//
// ─────────────────────────────────────────────────────────────────────────────
// A GID IN THE LINK IS NOT A SCOPE.
//
// The `#gid=` fragment records which tab somebody's browser happened to be
// showing when they copied the URL. It is not an instruction to read that tab
// alone. Treating it as one is why a run sheet can look like a single Speakers
// table for weeks while six other tabs — the agenda, the checklist, the
// marketing plan — go unread by everybody.
//
// So: every tab is read, and the linked one is merely sorted first. Narrow
// deliberately with --tab, never by accident.
// ─────────────────────────────────────────────────────────────────────────────

import { fail, note, refuse, runMain } from './lib/slack.mjs'
import { argValue, positionals } from './lib/config.mjs'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const argv = process.argv.slice(2)
const url = positionals(argv, ['tab', 'max-rows', 'workspace', 'w'])[0]
if (!url) {
  fail("Usage: node fetch-sheet.mjs '<google sheets url>' [--tab NAME] [--json] [--max-rows N]")
}

const wantTab = argValue(argv, 'tab')
const asJson = argv.includes('--json')
const maxRows = Number(argValue(argv, 'max-rows', 200))

await runMain(async () => {
  const parsed = parseSheetUrl(url)
  if (!parsed) refuse(`Not a Google Sheets/Drive URL: ${url}`)

  const tabs = await listTabs(parsed.id, parsed.gid)
  note(`${tabs.length} tab(s): ${tabs.map((t) => t.name).join(' · ')}`)

  const selected = wantTab
    ? tabs.filter((t) => t.name.toLowerCase().includes(wantTab.toLowerCase()))
    : tabs
  if (wantTab && !selected.length) {
    refuse(`No tab matching "${wantTab}". Tabs are: ${tabs.map((t) => t.name).join(', ')}`)
  }

  const out = []
  for (const tab of selected) {
    const rows = await readTab(parsed.id, tab.gid)
    out.push({ name: tab.name, gid: tab.gid, rows: rows.length, cells: rows.slice(0, maxRows) })
  }

  if (asJson) {
    process.stdout.write(JSON.stringify({ id: parsed.id, tabs: out }, null, 2) + '\n')
    return
  }

  for (const tab of out) {
    console.log(`\n${'='.repeat(70)}`)
    console.log(`## ${tab.name}   (gid ${tab.gid}, ${tab.rows} rows)`)
    console.log('='.repeat(70))
    if (!tab.cells.length) {
      console.log('  (empty)')
      continue
    }
    // Cell-per-line rather than a fixed-width table: run-sheet bios and briefs
    // run to hundreds of characters, and a table that wide is unreadable in a
    // terminal and mangled in a transcript.
    for (const row of tab.cells) {
      const cells = row.filter((c) => c !== '')
      if (!cells.length) continue
      console.log(`· ${cells.join(' | ')}`)
    }
    if (tab.rows > tab.cells.length) {
      console.log(`  … ${tab.rows - tab.cells.length} more rows (--max-rows to raise the cap)`)
    }
  }
})

// ================================================================== parsing

export function parseSheetUrl(u) {
  const id =
    u.match(/\/spreadsheets\/d\/(?:e\/)?([a-zA-Z0-9_-]{20,})/)?.[1] ??
    u.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{20,})/)?.[1] ??
    u.match(/[?&]id=([a-zA-Z0-9_-]{20,})/)?.[1]
  if (!id) return null
  // The fragment wins: `#gid=` is where the browser actually was, `?gid=` is
  // often a leftover from however the link was generated.
  const gid = u.match(/#gid=(\d+)/)?.[1] ?? u.match(/[?&]gid=(\d+)/)?.[1]
  return gid ? { id, gid } : { id }
}

/**
 * Enumerate tabs.
 *
 * There is no markup to parse — the tab switcher is built at runtime — so this
 * scrapes the literal `items.push({name: "…", … gid: "…"})` calls out of the
 * htmlview page's own bootstrap script.
 */
async function listTabs(id, linkedGid) {
  const url = `https://docs.google.com/spreadsheets/d/${id}/htmlview`
  let html = ''
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    html = await res.text()
  } catch (e) {
    refuse(`Could not reach the sheet: ${e.message}`)
  }

  // The htmlview page IS html, so this checks for an html *error* page: the tab
  // switcher script is absent from every one of them.
  if (!/items\.push\(\{/.test(html)) {
    const reason = htmlFailureReason(html)
    if (reason) refuse(`This sheet is ${reason}\n  DO NOT GUESS AT ITS CONTENTS.`)
  }

  const found = []
  const seen = new Set()
  for (const m of html.matchAll(/items\.push\(\{\s*name:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,400}?gid:\s*"(\d+)"/g)) {
    if (seen.has(m[2])) continue
    seen.add(m[2])
    found.push({ name: unescapeJs(m[1]), gid: m[2] })
  }

  if (!found.length) {
    for (const m of html.matchAll(/[?&#]gid=(\d+)/g)) {
      if (seen.has(m[1])) continue
      seen.add(m[1])
      found.push({ name: `gid ${m[1]}`, gid: m[1] })
    }
  }

  if (!found.length) found.push({ gid: '0', name: 'first tab' })

  // The linked tab first — it is a hint about where to start reading, and
  // nothing more than that.
  if (linkedGid) {
    found.sort((a, b) => (a.gid === linkedGid ? -1 : b.gid === linkedGid ? 1 : 0))
  }
  return found
}

/**
 * Why did Google give us a web page instead of data?
 *
 * The CSV export endpoint returns CSV or it returns an HTML error page — with
 * HTTP 200 either way. Checking only for a sign-in page is not enough: a deleted
 * or moved sheet renders a completely different page, and without this the HTML
 * parsed cleanly as a single-cell CSV row and got printed as if it were the
 * spreadsheet's contents.
 *
 * ANY html here is a failure. Name the cause when it is recognisable, and refuse
 * either way — a wrong answer that looks like an answer is the worst outcome.
 */
function htmlFailureReason(body) {
  const isHtml = /^\s*<!DOCTYPE html|^\s*<html[\s>]/i.test(body)
  if (!isHtml) return null
  if (/accounts\.google\.com\/(v3\/)?signin|Request access|You need access/i.test(body)) {
    return (
      'not link-viewable — Google returned a sign-in or request-access page.\n' +
      "  Ask whoever shared it to set link sharing to 'Anyone with the link — Viewer',\n" +
      '  or to export the tab and send the file.'
    )
  }
  if (/has been deleted|file that you.{0,3}ve requested/i.test(body)) {
    return 'deleted — Google says the file no longer exists.'
  }
  if (/Page not found|<title>Error/i.test(body)) {
    return 'not found — wrong id, or the sheet was moved.'
  }
  return 'not readable — Google returned an HTML page instead of data.'
}

/** A tab really can be called `Website \x26 Humanitix page`. */
function unescapeJs(s) {
  return s
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(.)/g, '$1')
}

async function readTab(id, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  const text = await res.text()
  // Checked per tab, not only once up front: the htmlview page can succeed while
  // an individual tab's CSV export fails.
  const reason = htmlFailureReason(text)
  if (reason) refuse(`Tab gid=${gid} is ${reason}`)
  return parseCsv(text)
}

/** Minimal RFC-4180: quoted fields, embedded commas and newlines, doubled quotes. */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
      continue
    }
    if (ch === '"') inQuotes = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') field += ch
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.map((r) => r.map((c) => c.trim()))
}
