import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import type { TestContext } from 'node:test'
import { deferred } from '#agent-host/deferred.ts'
import { connectHost, type HostClient } from '#agent-host/client.ts'
import type { NativeEvent } from '#workers/native-session.ts'
import type { HostedInput } from '#workers/provider.ts'
import type { ToClient } from '#agent-host/protocol.ts'

const WAIT_MS = 5000
export type NativeStats = {
  id: string
  closed: boolean
  input: HostedInput[]
  settings: string[]
  interrupts: number
  answers: number
  valueMatched: boolean
  context: string
}

export async function until({ check }: { check(): boolean | Promise<boolean> }) {
  const deadline = Date.now() + WAIT_MS

  while (!await check()) {
    assert.ok(
      Date.now() < deadline,
      'fixture state did not settle',
    )
    await setImmediate()
  }
}

export async function fixtureHost({
  t,
  pressure = false,
  directory,
  slowControls = false,
  entry,
  boot,
}: {
  t: TestContext
  pressure?: boolean
  directory?: string
  slowControls?: boolean
  entry?: string
  boot?: string | null
}) {
  const root = directory ?? realpathSync(mkdtempSync('/tmp/pnyx-host-'))
  const installation = 'fixture-installation'
  const child = fork(
    entry ?? join(
      import.meta.dirname,
      'process.ts',
    ),
    [
      root,
      installation,
    ],
    {
      execArgv: ['--conditions=source'],
      silent: true,
      env: {
        ...process.env,
        PNYX_HOME: root,
        HOME: root,
        FIXTURE_BOOT: boot === null ? '' : boot,
        FIXTURE_PRESSURE: pressure ? '1' : '0',
        FIXTURE_TIMEOUT: slowControls ? '1' : '0',
      },
    },
  )
  const ready = deferred<{ socket: string }>()
  const exited = deferred<void>()
  const waiting = new Map<string, ReturnType<typeof deferred<unknown>>>()
  let stderr = ''
  child.stderr?.on(
    'data',
    chunk => {
      stderr += chunk
    },
  )
  child.on(
    'message',
    message => {
      const value = message as {
        type?: string
        id?: string
        socket?: string
        code?: string
        error?: string
      }

      if (value.type === 'ready' && value.socket) {
        ready.resolve({ socket: value.socket })
      }

      if (value.type === 'fatal') {
        ready.reject(new Error(value.code))
      }

      if (value.id) {
        waiting.get(value.id)?.resolve(value)
      }
    },
  )
  child.on(
    'error',
    error => ready.reject(error),
  )
  child.once(
    'exit',
    () => {
      exited.resolve()
      ready.reject(new Error(`Fixture exited: ${stderr}`))

      for (const response of waiting.values()) {
        response.reject(new Error(`Fixture exited: ${stderr}`))
      }
    },
  )

  const control = async ({
    kind,
    nativeId,
    event,
    nextEvent,
    expected,
    submit,
    count,
    textBytes,
  }: {
    kind: 'stats' | 'event' | 'ask' | 'release' | 'stop' | 'burst'
    nativeId?: string
    event?: NativeEvent
    nextEvent?: NativeEvent
    expected?: string
    submit?: boolean
    count?: number
    textBytes?: number
  }): Promise<unknown> => {
    const id = randomUUID()
    const response = deferred<unknown>()
    waiting.set(
      id,
      response,
    )
    const timeout = setTimeout(
      () => response.reject(new Error(`Fixture ${kind} timed out: ${stderr}`)),
      WAIT_MS,
    )

    try {
      child.send({
        id,
        kind,
        nativeId,
        event,
        nextEvent,
        expected,
        submit,
        count,
        textBytes,
      })

      return await response.promise
    } finally {
      clearTimeout(timeout); waiting.delete(id)
    }
  }

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await exited.promise
    }

    if (!directory) {
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  })
  const timeout = setTimeout(
    () => ready.reject(new Error(`Fixture startup timed out: ${stderr}`)),
    WAIT_MS,
  )
  let socket: string

  try {
    socket = (await ready.promise).socket
  } finally {
    clearTimeout(timeout)
  }

  const clients: HostClient[] = []
  t.after(() => {
    for (const client of clients) {
      client.detach()
    }
  })

  const connect = async () => {
    const client = await connectHost({
      socket,
      installation,
      token: readFileSync(
        join(
          root,
          'token',
        ),
        'utf8',
      ),
    })
    clients.push(client)

    return client
  }

  return {
    root,
    socket,
    child,
    connect,
    control,
    exited: exited.promise,
    stats: async () => (await control({ kind: 'stats' }) as { states: NativeStats[] }).states,
  }
}

export async function controlledSession({
  host,
  client,
}: {
  host: Awaited<ReturnType<typeof fixtureHost>>
  client: HostClient
}) {
  const claim = await client.call({
    id: randomUUID(),
    operation: {
      kind: 'attach',
      scope: { kind: 'host' },
      expectedRevision: client.ready.hostControllerRevision,
    },
  })
  assert.ok(claim.kind === 'attached')
  const openId = randomUUID()
  const options = {
    provider: 'claude-code' as const,
    cwd: host.root,
    settings: {},
    environment: {},
    context: 'original',
  }
  const opened = await client.call({
    id: openId,
    operation: {
      kind: 'open',
      controller: claim.control.generation,
      options,
    },
  })
  assert.ok(opened.kind === 'opened' && opened.session.nativeId)
  const session = opened.session
  const attached = await client.call({
    id: randomUUID(),
    operation: {
      kind: 'attach',
      scope: {
        kind: 'session',
        ref: session.ref,
      },
      expectedRevision: 0,
    },
  })
  assert.ok(attached.kind === 'attached')

  return {
    ref: session.ref,
    nativeId: opened.session.nativeId,
    token: attached.control.generation,
    hostToken: claim.control.generation,
    openId,
    options,
  }
}

export async function snapshot({
  client,
  ref,
  after,
}: {
  client: HostClient
  ref: {
    id: string
    epoch: string
  }
  after?: number
}) {
  const baseline = deferred<Extract<ToClient, { type: 'snapshot' }>>()
  const unsubscribe = client.subscribe({
    receive: ({ frame }) => {
      if (frame.type === 'snapshot' && frame.ref.id === ref.id) {
        baseline.resolve(frame)
      }
    },
  })
  const timeout = setTimeout(
    () => baseline.reject(new Error('Snapshot timed out')),
    WAIT_MS,
  )

  try {
    client.watch({
      ref,
      after,
    })

    return await baseline.promise
  } finally {
    clearTimeout(timeout); unsubscribe()
  }
}
