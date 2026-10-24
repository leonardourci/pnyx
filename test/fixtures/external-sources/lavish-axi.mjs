#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [
  action,
  page,
  flag,
  text,
] = process.argv.slice(2)
const folder = dirname(page)
const log = join(
  folder,
  'calls.jsonl',
)
appendFileSync(
  log,
  `${JSON.stringify({
    action,
    page,
    flag,
    text,
  })}\n`,
)

if (action === 'reply') {
  if (existsSync(join(
    folder,
    'fail-post',
  ))) {
    console.error('Injected reply failure')
    process.exit(1)
  }

  console.log(`reply:\n  file: ${page}\n  status: sent`)
} else if (action === 'poll') {
  if (existsSync(join(
    folder,
    'fail-poll',
  ))) {
    console.error('Injected poll failure')
    process.exit(1)
  }

  const delivery = join(
    folder,
    'deliver.toon',
  )
  let watcher

  const consume = () => {
    if (!existsSync(delivery)) {
      return
    }

    const body = readFileSync(
      delivery,
      'utf8',
    )
    unlinkSync(delivery)
    watcher.close()
    process.stdout.write(body)
  }

  watcher = watch(
    folder,
    consume,
  )
  writeFileSync(
    join(
      folder,
      'listening',
    ),
    String(process.pid),
  )
  consume()
} else {
  throw new Error('Only reply and poll are allowed in the fixture')
}
