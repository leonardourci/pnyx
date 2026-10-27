import assert from 'node:assert/strict'
import processes, { type ChildProcess } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { setTimeout, clearTimeout } from 'node:timers'
import type { TestContext } from 'node:test'

export function commandCapture({ t }: { t: TestContext }) {
  const spawn = processes.spawn
  const children: {
    child: ChildProcess
    closed: Promise<void>
  }[] = []
  t.mock.method(
    processes,
    'spawn',
    // eslint-disable-next-line pnyx/object-params -- Node owns spawn's signature.
    (...args: Parameters<typeof processes.spawn>) => {
      const child = spawn(...args)

      if (args[0] === '/bin/sh' && args[2]?.detached) {
        const closed = new Promise<void>((
          resolve,
          reject,
        ) => {
          const timer = setTimeout(
            () => {
              child.kill()
              reject(new Error(`command ${child.pid} did not close`))
            },
            30_000,
          )
          child.once(
            'error',
            error => {
              clearTimeout(timer); reject(error)
            },
          )
          child.once(
            'close',
            (
              code,
              signal,
            ) => {
              clearTimeout(timer)

              try {
                assert.equal(
                  code,
                  0,
                  `command ${child.pid} exited with ${code}, ${signal}`,
                )
                resolve()
              } catch (error) {
                reject(error)
              }
            },
          )
        })
        void closed.catch(() => {})
        children.push({
          child,
          closed,
        })
      }

      return child
    },
  )
  syncBuiltinESMExports()
  t.after(async () => {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
      }
    }

    await Promise.allSettled(children.map(({ closed }) => closed))
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })

  return {
    count: () => children.length,
    async completed() {
      assert.ok(
        children.length > 0,
        'a command child was started',
      )
      await Promise.all(children.map(({ closed }) => closed))
    },
  }
}
