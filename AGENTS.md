# Agent notes

You are probably here to use the skill, not to change it. Read
`skills/slack-waterline/SKILL.md` and follow it.

## If you are changing the skill

Read `skills/slack-waterline/references/read-state.md` first. Every rule in
`scripts/lib/state.mjs` is a message that went unread until the rule existed,
and `scripts/lib/state.test.mjs` names which. If a test starts failing, a message
is about to go missing — do not adjust the expectation to match the code.

```bash
node --test skills/slack-waterline/scripts/lib/state.test.mjs
```

## Invariants — do not break these

1. **A read receipt may only describe what was DELIVERED, never what exists.**
   Fetching is not reading.
2. **`record.mjs` is the only writer of `watermarkTs` and `readAt`.** If you add
   a writer, it moves `scannedTs` **or** it delivers content to a reader. Never
   both, never neither.
3. **The signal gate decides priority, never whether something is read.**
4. **Stdout is the payload; diagnostics go to `console.error`.** `fetch.mjs`
   writes JSON to stdout and callers redirect it.
5. **No dependencies.** Plain `fetch`, `node:*` only. The skill must run against
   any repo without an npm install landing in it.
6. **No `process.exit()` after network I/O.** It trips a libuv assertion on
   Windows that replaces the exit code with 127 — which matters, because the
   gates deliberately exit with a finding count. Use `finish()` / `runMain()`
   from `lib/slack.mjs`.
7. **Atomic writes.** Temp file, then rename.
8. **Never commit workspace data or a token.** CI greps for `xox*-` patterns.

## House style

- Comments explain *why*, and name the failure that motivated the rule.
- Refuse ambiguity rather than guessing — reading or messaging the wrong person
  is not recoverable.
- Prose arguments go through files (`--digest-file`, `--reason-file`,
  `--batch`): PowerShell doubles a quote where bash does not.
