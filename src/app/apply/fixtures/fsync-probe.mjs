import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const prefix = process.env.PNYX_SYNC_PROBE
const mode = process.env.PNYX_SYNC_MODE
const gateTimeoutMs = 20000
const pollMs = 10
const descriptors = new Map()
const open = fs.openSync
const close = fs.closeSync
const sync = fs.fsyncSync

// eslint-disable-next-line pnyx/object-params -- preserves the fs API signature.
fs.openSync = (...args) => {
  const path = String(args[0])

  if (path.endsWith('/writer.lock') && args[1] === 'wx') {
    fs.writeFileSync(
      `${prefix}.lock-attempt`,
      '',
    )
  }

  const descriptor = open(...args)
  descriptors.set(
    descriptor,
    path,
  )

  return descriptor
}

// eslint-disable-next-line pnyx/object-params -- preserves the fs API signature.
fs.closeSync = descriptor => {
  close(descriptor)
  descriptors.delete(descriptor)
}

// eslint-disable-next-line pnyx/object-params -- preserves the fs API signature.
fs.fsyncSync = descriptor => {
  if (descriptors.get(descriptor)?.endsWith('/events.jsonl')) {
    fs.writeFileSync(
      `${prefix}.entered`,
      '',
    )

    if (mode === 'kill') {
      process.kill(
        process.pid,
        'SIGKILL',
      )
    }

    if (mode === 'gate') {
      const deadline = Date.now() + gateTimeoutMs
      const wait = new Int32Array(new SharedArrayBuffer(4))

      while (!fs.existsSync(`${prefix}.release`)) {
        if (Date.now() >= deadline) {
          throw new Error('fsync probe gate timed out')
        }

        Atomics.wait(
          wait,
          0,
          0,
          pollMs,
        )
      }
    }

    sync(descriptor)
    fs.writeFileSync(
      `${prefix}.completed`,
      '',
    )

    return
  }

  sync(descriptor)
}

syncBuiltinESMExports()
