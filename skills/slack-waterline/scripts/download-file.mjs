#!/usr/bin/env node
// Download a Slack attachment.
//
//   node download-file.mjs '<url_private>' out/deck.pdf
//   node download-file.mjs F0ABC123 out/deck.pdf      # by file id
//
// Prints {"path","bytes","mimetype"} to stdout.

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { Slack, fail, note, refuse, runMain } from './lib/slack.mjs'
import { resolveWorkspace, positionals } from './lib/config.mjs'

const argv = process.argv.slice(2)
const [source, target] = positionals(argv, ['workspace', 'w'])
if (!source || !target) {
  fail("Usage: node download-file.mjs '<url_private|file id>' <target path>")
}

const { dataDir } = resolveWorkspace(argv)
const slack = new Slack(dataDir)

await runMain(async () => {
  let url = source
  if (/^F[A-Z0-9]{6,}$/.test(source)) {
    const info = await slack.call('files.info', { file: source })
    url = info.file?.url_private_download ?? info.file?.url_private
    if (!url) refuse(`files.info returned no download URL for ${source}`)
  }

  const res = await fetch(url, { headers: { Authorization: `Bearer ${slack.token}` } })
  const mimetype = res.headers.get('content-type') ?? 'application/octet-stream'

  // THE GUARD THAT MATTERS.
  //
  // Slack serves files from a CDN host, not the Web API, so an auth failure does
  // not come back as `missing_scope` or even as an error status — it comes back as
  // HTTP 200 carrying a login page. Without this check the download "succeeds" and
  // writes an HTML document to disk under a .pdf name, and the failure only
  // surfaces much later, somewhere unrelated.
  if (mimetype.startsWith('text/html')) {
    refuse(
      'Slack returned HTML instead of the file.\n' +
        '  The token likely lacks `files:read`, or the file is restricted, or the\n' +
        '  URL expired. Note this arrives as HTTP 200 — it is not an error status.\n' +
        `  Status was ${res.status}.`
    )
  }
  if (!res.ok) refuse(`Download failed: HTTP ${res.status}`)

  const buf = Buffer.from(await res.arrayBuffer())
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, buf)

  note(`${buf.length} bytes, ${mimetype}`)
  process.stdout.write(JSON.stringify({ path: target, bytes: buf.length, mimetype }) + '\n')
})
