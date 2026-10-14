#!/usr/bin/env node
// Fake Firstmate inbox for tests: records its FM_HOME and arguments in
// $FM_HOME/inbox.log, then exits with the status in $FM_HOME/inbox-exit (0 when
// absent). `note --request-id <id> --json -- <text>` keeps the note in
// $FM_HOME/inbox.json and replays it for the same request id.
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const home = process.env.FM_HOME
const args = process.argv.slice(2)
appendFileSync(join(home, 'inbox.log'), `FM_HOME=${home}\n${args.map(a => `arg=${a}\n`).join('')}---\n`)
const file = join(home, 'inbox.json')
const notes = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
const code = existsSync(join(home, 'inbox-exit')) ? Number(readFileSync(join(home, 'inbox-exit'), 'utf8')) : 0

if (args[0] === 'note') {
  if (code === 1) {
    process.stderr.write('fm-inbox: fake note failed\n')
    process.exit(1)
  }

  const requestId = args[args.indexOf('--request-id') + 1]
  const known = notes.find(n => n.request_id === requestId)
  const note = known ?? { id: `n${notes.length + 1}`, request_id: requestId, body: args.slice(args.indexOf('--') + 1).join(' ') }

  if (!known) {
    writeFileSync(file, JSON.stringify([...notes, note]))
  }

  process.stdout.write(`${JSON.stringify({ schema: 'fm-inbox-note.v1', outcome: known ? 'replay' : 'created', id: note.id, request_id: requestId, saved: true, announced: code === 0 })}\n`)
  process.exit(code)
}

process.exit(2)
