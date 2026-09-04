#!/usr/bin/env node
// Extract plain text from a .docx, with no dependencies.
//
//   node extract-docx.mjs bio.docx
//
// A .docx is a ZIP holding `word/document.xml`. Node ships inflate, so the whole
// thing is a short ZIP walk — which is why this does not pull in `mammoth`.
//
// Not robust against embedded tables, footnotes or tracked changes. It gets the
// prose out of the bios, briefs and one-pagers people attach to Slack messages,
// which is what it is for. If the output looks wrong, open the file.

import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

import { fail } from './lib/slack.mjs'

const path = process.argv[2]
if (!path) fail('Usage: node extract-docx.mjs <file.docx>')

const buf = readFileSync(path)
const xml = findEntry(buf, 'word/document.xml')
if (!xml) {
  fail(
    `No word/document.xml inside ${path}.\n` +
      '  Is it really a .docx? A .doc (pre-2007) is a completely different format.'
  )
}

process.stdout.write(toText(xml) + '\n')

/** Walk local file headers looking for one entry by name. */
function findEntry(buf, want) {
  const SIG = 0x04034b50
  let i = 0
  while (i < buf.length - 30) {
    if (buf.readUInt32LE(i) !== SIG) {
      i++
      continue
    }
    const method = buf.readUInt16LE(i + 8)
    const compressedSize = buf.readUInt32LE(i + 18)
    const nameLen = buf.readUInt16LE(i + 26)
    const extraLen = buf.readUInt16LE(i + 28)
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8')
    const dataStart = i + 30 + nameLen + extraLen

    if (name === want) {
      const data = buf.subarray(dataStart, dataStart + compressedSize)
      try {
        return method === 0 ? data.toString('utf8') : inflateRawSync(data).toString('utf8')
      } catch (e) {
        fail(`Could not inflate ${want}: ${e.message}`)
      }
    }
    // A streamed entry writes 0 here and puts the real size in a trailing data
    // descriptor. Rather than parse that, fall back to scanning byte by byte.
    i = compressedSize > 0 ? dataStart + compressedSize : i + 1
  }
  return null
}

function toText(xml) {
  return xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
