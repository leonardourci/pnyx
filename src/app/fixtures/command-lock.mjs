import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

const GATE_TIMEOUT_MS = 30_000
const GATE_POLL_MS = 25

if (process.argv[1]?.endsWith('command-process.ts') || process.argv[1]?.endsWith('command-process.js')) {
  const args = process.argv.slice(2)
  const hydra = args[args.indexOf('--hydra') + 1]
  const dir = join(
    process.env.PNYX_HOME,
    'hydras',
    hydra,
  )
  const lock = join(
    dir,
    'writer.lock',
  )
  const remove = fs.rmSync
  const marker = process.env.PNYX_HANDOFF_MARKER
  const event = args[args.indexOf('--event-id') + 1]

  // eslint-disable-next-line pnyx/object-params -- fs.rmSync owns this signature.
  fs.rmSync = function(
    path,
    options,
  ) {
    remove(
      path,
      options,
    )

    // Another live writer takes over after the action commits, before task-lease cleanup.
    if (path === lock && !process.env.PNYX_COMMAND_GATE && !fs.existsSync(marker)
      && fs.readFileSync(
        join(
          dir,
          'events.jsonl',
        ),
        'utf8',
      ).includes(event)) {
      fs.writeFileSync(
        lock,
        process.env.PNYX_LOCK_OWNER,
      )
      fs.writeFileSync(
        marker,
        String(process.pid),
      )
    }
  }

  syncBuiltinESMExports()

  const gate = process.env.PNYX_COMMAND_GATE

  if (gate) {
    fs.writeFileSync(
      marker,
      String(process.pid),
    )
    const deadline = Date.now() + GATE_TIMEOUT_MS

    while (!fs.existsSync(gate) && Date.now() < deadline) {
      await setTimeout(GATE_POLL_MS)
    }

    if (!fs.existsSync(gate)) {
      throw new Error('The test did not release the command worker')
    }
  }
}
