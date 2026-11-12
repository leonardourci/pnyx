import assert from 'node:assert/strict'
import { test } from 'node:test'
import { syncBuiltinESMExports } from 'node:module'
import workerThreads, { Worker, setEnvironmentData } from 'node:worker_threads'
import { startServer } from './server-daemon.ts'
import { SOURCE_CONDITIONS } from './source-conditions.ts'
import { snapshotInBackground } from './snapshot-background.ts'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { heldHydra, loadHydra } from './store.ts'
import { withWriter, saveSnapshot } from './writer.ts'
import { readSnapshot } from './snapshot.ts'
import { repairHydra } from './repair.ts'
import { settle } from '#test-harness/child-fixture.ts'

test(
  'snapshots keep their timer, recover failures, serialize Hydras and flush at shutdown',
  async t => {
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-snapshot-shutdown-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = home
    const server = await startServer({
      port: 0,
      homes: [],
    })
    let serverClosed = false
    const live = heldHydra({ hydraId: 'default' })!
    const OriginalWorker = Worker
    type Gate = {
      buffer: SharedArrayBuffer
      ready: string
      beforePublish: boolean
    }
    const plans: {
      gate?: Gate
      holdExit?: boolean
    }[] = []
    const gates: Gate[] = []
    const starts: string[] = []
    const directories = new Set([live.dir])
    let active = 0
    let maximum = 0
    let releaseExit = () => {}
    let exited = false

    const releaseGate = ({ buffer }: Gate) => {
      Atomics.store(
        new Int32Array(buffer),
        0,
        1,
      )
      Atomics.notify(
        new Int32Array(buffer),
        0,
      )
    }

    const gate = ({
      key,
      beforePublish = false,
    }: {
      key: string
      beforePublish?: boolean
    }): Gate => {
      const held = {
        beforePublish,
        buffer: new SharedArrayBuffer(4),
        ready: join(
          home,
          key,
        ),
      }
      gates.push(held)

      return held
    }

    class ObservedWorker extends OriginalWorker {
      holdExit = false

      // eslint-disable-next-line pnyx/object-params -- Node owns the Worker constructor signature.
      constructor(...parameters: ConstructorParameters<typeof Worker>) {
        const [
          filename,
          options,
        ] = parameters
        const snapshot = typeof options?.workerData === 'string' && directories.has(options.workerData)
        const plan = snapshot ? plans.shift() : undefined
        let workerOptions = options

        if (snapshot) {
          setEnvironmentData(
            'snapshot-test-gate',
            plan?.gate,
          )
          workerOptions = {
            ...options,
            execArgv: [
              ...SOURCE_CONDITIONS,
              '--import',
              new URL(
                './fixtures/snapshot-gate.ts',
                import.meta.url,
              ).href,
            ],
          }
        }

        super(
          filename,
          workerOptions,
        )
        this.holdExit = plan?.holdExit === true

        if (snapshot) {
          setEnvironmentData(
            'snapshot-test-gate',
            undefined,
          )
          starts.push(options?.workerData)
          active += 1
          maximum = Math.max(
            maximum,
            active,
          )
          this.on(
            'exit',
            () => {
              active -= 1
            },
          )
        }
      }

      // eslint-disable-next-line pnyx/object-params -- Node owns EventEmitter's listener signature.
      override once(...parameters: Parameters<Worker['once']>): this {
        const [
          event,
          listener,
        ] = parameters

        if (event === 'exit' && this.holdExit) {
          return super.once(
            event,
            (...args: unknown[]) => {
              releaseExit = () => {
                listener(...args)
                releaseExit = () => {}
              }

              exited = true
            },
          )
        }

        return super.once(
          event,
          listener,
        )
      }
    }

    workerThreads.Worker = ObservedWorker
    syncBuiltinESMExports()
    t.after(async () => {
      gates.forEach(releaseGate)
      releaseExit()
      t.mock.timers.reset()

      try {
        if (!serverClosed) {
          await server.close()
        }

        await saveSnapshot({ live })
      } finally {
        workerThreads.Worker = OriginalWorker
        syncBuiltinESMExports()

        if (previous === undefined) {
          delete process.env.PNYX_HOME
        } else {
          process.env.PNYX_HOME = previous
        }

        rmSync(
          home,
          {
            recursive: true,
            force: true,
          },
        )
      }
    })
    const append = ({ id }: { id: string }) => withWriter({
      hydraId: 'default',
      fn: ({ writer }) => writer.append({
        event: {
          v: 1,
          seq: writer.state.seq + 1,
          id,
          cardId: id,
          type: 'task.created',
          actor: 'fixture',
          at: '2026-11-12T00:00:00Z',
          data: {
            key: id,
            title: id,
          },
        },
      }),
    })
    await saveSnapshot({ live })
    t.mock.timers.enable({ apis: ['setTimeout'] })
    append({ id: 'first' })
    t.mock.timers.tick(59_999)
    assert.equal(
      readSnapshot({ dir: live.dir })?.state.cards.first,
      undefined,
    )
    append({ id: 'second' })
    t.mock.timers.tick(1)
    await settle({
      what: 'the timed snapshot',
      check: () => readSnapshot({ dir: live.dir })?.state.cards.second,
    })
    t.mock.timers.reset()
    await saveSnapshot({ live })
    const cache = join(
      live.dir,
      'snapshot.json',
    )
    rmSync(cache)
    mkdirSync(cache)
    await assert.rejects(saveSnapshot({ live }))
    assert.ok(loadHydra({ hydraId: 'default' }).state.cards.second)
    rmSync(
      cache,
      { recursive: true },
    )
    await saveSnapshot({ live })
    const startedAt = starts.length
    append({ id: 'before' })
    const other = join(
      home,
      'other-hydra',
    )
    directories.add(other)
    cpSync(
      live.dir,
      other,
      { recursive: true },
    )
    const firstGate = gate({ key: 'first-ready' })
    plans.push({ gate: firstGate })
    const first = saveSnapshot({ live })
    await settle({
      what: 'first snapshot before its write',
      check: () => existsSync(firstGate.ready),
    })
    const otherSave = snapshotInBackground({ dir: other })
    const second = saveSnapshot({ live })
    releaseGate(firstGate)
    await Promise.all([
      first,
      otherSave,
      second,
    ])
    assert.equal(
      maximum,
      1,
      'large Hydras cannot load simultaneously in snapshot workers',
    )
    assert.deepEqual(
      starts.slice(startedAt),
      [
        live.dir,
        other,
        live.dir,
      ],
    )
    assert.deepEqual(
      readSnapshot({ dir: live.dir })?.state,
      live.state,
    )

    const repairGate = gate({
      key: 'repair-ready',
      beforePublish: true,
    })
    plans.push({ gate: repairGate })
    const overlapping = saveSnapshot({ live })
    await settle({
      what: 'the worker snapshot staging file before publication',
      check: () => existsSync(repairGate.ready),
    })
    repairHydra({ hydraId: 'default' })
    releaseGate(repairGate)
    await overlapping
    assert.deepEqual(
      readSnapshot({ dir: live.dir })?.state,
      live.state,
    )

    plans.push({ holdExit: true })
    t.mock.timers.enable({ apis: ['setTimeout'] })
    append({ id: 'in-flight' })
    t.mock.timers.tick(60_000)
    await settle({
      what: 'the timed snapshot worker to exit',
      check: () => exited,
    })
    assert.ok(readSnapshot({ dir: live.dir })?.state.cards['in-flight'])
    append({ id: 'shutdown-final' })
    t.mock.timers.reset()
    const finalGate = gate({ key: 'final-ready' })
    plans.push({ gate: finalGate })

    const close = async () => {
      await server.close()
      serverClosed = true
      assert.ok(readSnapshot({ dir: live.dir })?.state.cards['shutdown-final'])
      assert.deepEqual(
        readSnapshot({ dir: live.dir })?.state,
        loadHydra({ hydraId: 'default' }).state,
      )
    }

    const finish = async () => {
      releaseExit()
      await settle({
        what: 'shutdown snapshot before its write',
        check: () => existsSync(finalGate.ready),
      })
      releaseGate(finalGate)
    }

    await Promise.all([
      close(),
      finish(),
    ])
  },
)
