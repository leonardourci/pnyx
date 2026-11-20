import { beforeAll, expect, onTestFinished, test } from 'vitest'
import { git } from './setup/upgrade.ts'
import { startPnyx, until, type Pnyx } from './setup/pnyx.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx()
})

test(
  'a card send starts one worker directly and retries preserve its receipt',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'quick-worker' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'quick',
        '--title',
        'Quick fix',
        '--folder',
        folder,
      ],
    })
    const args = [
      'task',
      'send',
      'quick',
      '--text',
      'Fix the missing export',
      '--harness',
      'claude',
      '--event-id',
      'direct-start',
    ]
    expect(await hydra.owner({ args })).toMatchObject({ state: 'queued' })
    const worker = await hydra.agent({ cwd: folder })
    await until({
      what: 'direct start reaches the worker',
      check: () => worker.answered === 1,
    })
    expect(worker.received[0]).toContain('Fix the missing export')
    expect(pnyx.claude.sessions.filter(session => session.cwd === folder)).toHaveLength(1)
    expect(await hydra.owner({ args })).toMatchObject({ state: 'delivered' })
    expect(worker.received).toHaveLength(1)
    const page = await hydra.page()

    try {
      expect(await page.send({
        name: 'thread',
        args: ['quick'],
      })).toMatchObject({
        type: 'receipt',
        thread: { card: (await hydra.task({ key: 'quick' })).id },
      })
    } finally {
      page.close()
    }

    const { thread } = await hydra.owner({
      args: [
        'task',
        'chat',
        'quick',
      ],
    })
    expect(thread.entries).toContainEqual(expect.objectContaining({
      text: 'Fix the missing export',
      receipt: 'delivered',
    }))
    expect((await hydra.owner({
      args: [
        'hydra',
        'messages',
      ],
    })).messages).toBe('none: no messages after seq 0')
  },
)

test(
  'a harness switch waits for the live turn and carries its recorded conversation',
  async () => {
    const hydra = await pnyx.hydra()
    const {
      folder,
      worker,
    } = await hydra.startTask({ key: 'switch' })
    const held = pnyx.claude.plan({
      hydra: hydra.id,
      hold: true,
      partial: 'Finishing the current change',
      reply: 'The parser now rejects an empty input',
    })
    onTestFinished(() => held.release())
    await hydra.owner({
      args: [
        'task',
        'send',
        'switch',
        '--harness',
        'claude',
        '--text',
        'Finish the current change',
      ],
    })
    await until({
      what: 'the current turn is held',
      check: () => worker.received.length === 2,
    })
    const task = await hydra.task({ key: 'switch' })
    const args = [
      'task',
      'send',
      'switch',
      '--text',
      'Continue with the regression fix',
      '--harness',
      'codex',
      '--event-id',
      'switch-next',
    ]
    await hydra.owner({ args })
    const queued = await hydra.owner({
      args: [
        'task',
        'chat',
        'switch',
      ],
    })
    expect(queued.thread.entries).toContainEqual(expect.objectContaining({
      text: 'Continue with the regression fix',
      receipt: 'queued',
      waiting: 'Queued · codex',
    }))
    expect(worker.closed).toBe(false)
    expect(pnyx.codex.sessions.filter(session => session.cwd === folder)).toHaveLength(0)
    held.release()
    await until({
      what: 'the next harness starts after the current turn',
      check: () => pnyx.codex.sessions.some(session =>
        session.cwd === folder && session.answered === 1),
    })
    const next = pnyx.codex.sessions.find(session => session.cwd === folder)!
    expect(next.received[0]).toContain(`task chat ${task.id} --session claude-code:${worker.id}`)
    expect(next.received[0]).toContain('Continue with the regression fix')
    const currentThread = await hydra.owner({
      args: [
        'task',
        'chat',
        'switch',
      ],
    })
    expect(currentThread.thread.entries).toContainEqual(expect.objectContaining({
      text: 'The parser now rejects an empty input',
    }))

    const selected = await hydra.owner({
      args: [
        'task',
        'chat',
        'switch',
        '--session',
        `codex:${next.id}`,
      ],
    })
    expect(selected.thread.entries).not.toContainEqual(expect.objectContaining({
      text: 'The parser now rejects an empty input',
    }))
    expect(next.cwd).toBe(folder)
    expect(worker.closed).toBe(true)
    expect(next.id).not.toBe(worker.id)
    expect((await hydra.as({ session: worker }).refused({
      args: [
        'task',
        'inbox',
        'read',
        task.id,
      ],
    })).code).toBe('STALE_CLAIM')
    expect((await hydra.as({ session: next }).run({
      args: [
        'task',
        'inbox',
        'read',
        task.id,
      ],
    })).pending).toBe(0)
    expect(await hydra.owner({ args })).toMatchObject({ state: 'delivered' })
    expect(pnyx.codex.sessions.filter(session => session.cwd === folder)).toHaveLength(1)
  },
)

test(
  'same-harness model changes wait for the next turn and keep the session',
  async () => {
    const hydra = await pnyx.hydra()
    const {
      folder,
      worker,
    } = await hydra.startTask({ key: 'model' })
    const held = pnyx.claude.plan({
      hydra: hydra.id,
      hold: true,
    })
    onTestFinished(() => held.release())
    await hydra.owner({
      args: [
        'task',
        'send',
        'model',
        '--harness',
        'claude',
        '--text',
        'Finish the current change',
      ],
    })
    await until({
      what: 'the current turn is held',
      check: () => worker.received.length === 2,
    })
    const before = worker.model
    await hydra.owner({
      args: [
        'task',
        'send',
        'model',
        '--text',
        'Check the new model',
        '--harness',
        'claude',
        '--model',
        'sonnet',
        '--effort',
        'high',
        '--event-id',
        'model-next',
      ],
    })
    expect(worker.model).toBe(before)
    expect(worker.received).toHaveLength(2)
    held.release()
    await until({
      what: 'the same session receives its next turn',
      check: () => worker.answered === 3,
    })
    expect(worker.model).toBe('sonnet')
    expect(worker.received[2]).toContain('Check the new model')
    expect(pnyx.claude.sessions.filter(session => session.cwd === folder)).toHaveLength(1)
  },
)

test(
  'creating and sending a project task makes its normal repository copy once',
  async () => {
    const hydra = await pnyx.hydra()
    const repository = hydra.folder({ name: 'direct-project' })
    git({
      cwd: repository,
      args: [
        'init',
        '-q',
        '-b',
        'main',
      ],
    })
    git({
      cwd: repository,
      args: [
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'Initial project',
      ],
    })
    await hydra.owner({
      args: [
        'project',
        'add',
        repository,
      ],
    })
    const args = [
      'task',
      'create',
      '--key',
      'direct-project',
      '--title',
      'Inspect the parser',
      '--project',
      repository,
      '--ask',
      'Find the parser failure',
      '--start',
      '--harness',
      'claude',
      '--event-id',
      'create-and-send',
    ]
    const created = await hydra.owner({ args })
    const worker = await until({
      what: 'the task has its own worker',
      check: () => pnyx.claude.sessions.find(session =>
        session.env.PNYX_ACTOR === `worker:${created.card.id}`
        && session.answered === 1),
    })
    const { task: current } = await hydra.owner({
      args: [
        'task',
        'show',
        'direct-project',
        '--full',
      ],
    })
    expect(worker).toBeDefined()
    expect(worker!.cwd).not.toBe(repository)
    expect(worker!.received[0]).toContain('Find the parser failure')
    const repeated = await hydra.owner({ args })
    expect(repeated.card.id).toBe(created.card.id)
    expect(current.project).toBe(repository)
    expect(pnyx.claude.sessions.filter(session => session.cwd === worker!.cwd)).toHaveLength(1)
  },
)

test(
  'Stop cancels a queued switch and the next Send changes harness immediately',
  async () => {
    const hydra = await pnyx.hydra()
    const {
      folder,
      worker,
    } = await hydra.startTask({ key: 'stop-switch' })
    const held = pnyx.claude.plan({
      hydra: hydra.id,
      hold: true,
    })
    onTestFinished(() => held.release())
    await hydra.owner({
      args: [
        'task',
        'send',
        'stop-switch',
        '--harness',
        'claude',
        '--text',
        'Keep working until stopped',
      ],
    })
    await until({
      what: 'a live turn before Stop',
      check: () => worker.received.length === 2,
    })
    await hydra.owner({
      args: [
        'task',
        'send',
        'stop-switch',
        '--text',
        'Wait for this switch',
        '--harness',
        'codex',
        '--event-id',
        'cancel-switch',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'stop',
        'stop-switch',
      ],
    })
    const stopped = await hydra.owner({
      args: [
        'task',
        'chat',
        'stop-switch',
      ],
    })
    expect(stopped.thread.entries).toContainEqual(expect.objectContaining({
      text: 'Wait for this switch',
      receipt: 'failed',
      waiting: 'stopped',
    }))
    expect(pnyx.codex.sessions.filter(session => session.cwd === folder)).toHaveLength(0)
    await hydra.owner({
      args: [
        'task',
        'send',
        'stop-switch',
        '--text',
        'Start the new harness now',
        '--harness',
        'codex',
        '--event-id',
        'after-stop',
      ],
    })
    await until({
      what: 'the next Send starts the chosen harness',
      check: () => pnyx.codex.sessions.some(session =>
        session.cwd === folder && session.answered === 1),
    })
  },
)

test(
  'a refused direct start retries once after its account is configured',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'retry-start' })
    const login = hydra.folder({ name: 'later-login' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'retry',
        '--title',
        'Retry direct start',
        '--folder',
        folder,
      ],
    })
    const args = [
      'task',
      'send',
      'retry',
      '--text',
      'Start when this login is configured',
      '--harness',
      'claude',
      '--account',
      'claude:later',
      '--event-id',
      'retry-start',
    ]
    await hydra.owner({ args })
    await until({
      what: 'the missing account refuses the start',
      check: async () => (await hydra.owner({
        args: [
          'task',
          'chat',
          'retry',
        ],
      })).thread.entries.some((entry: { receipt?: string }) => entry.receipt === 'failed'),
    })
    expect(pnyx.claude.sessions.filter(session => session.cwd === folder)).toHaveLength(0)
    await hydra.owner({
      args: [
        'account',
        'set',
        'claude:later',
        '--provider',
        'claude',
        '--folder',
        login,
      ],
    })
    await hydra.owner({ args })
    const worker = await hydra.agent({ cwd: folder })
    await until({
      what: 'the same message starts after the account is configured',
      check: () => worker.answered === 1,
    })
    expect(worker.received[0]).toContain('Start when this login is configured')
    expect(await hydra.owner({ args })).toMatchObject({ state: 'delivered' })
    expect(pnyx.claude.sessions.filter(session => session.cwd === folder)).toHaveLength(1)
  },
)

test(
  'a queued harness switch survives a Pnyx restart without a second launch',
  async () => {
    const hydra = await pnyx.hydra()
    const {
      folder,
      worker,
    } = await hydra.startTask({ key: 'restart-switch' })
    const held = pnyx.claude.plan({
      hydra: hydra.id,
      hold: true,
    })
    onTestFinished(() => held.release())
    await hydra.owner({
      args: [
        'task',
        'send',
        'restart-switch',
        '--harness',
        'claude',
        '--text',
        'Finish this turn before switching',
      ],
    })
    await until({
      what: 'a live turn before restart',
      check: () => worker.received.length === 2,
    })
    const args = [
      'task',
      'send',
      'restart-switch',
      '--text',
      'Continue on Codex after restart',
      '--harness',
      'codex',
      '--event-id',
      'restart-switch',
    ]
    await hydra.owner({ args })
    await pnyx.restart({ whileStopped: () => held.release() })
    await until({
      what: 'the saved switch reaches the new harness',
      check: () => pnyx.codex.sessions.some(session =>
        session.cwd === folder && session.answered === 1),
    })
    expect(await hydra.owner({ args })).toMatchObject({ state: 'delivered' })
    expect(pnyx.codex.sessions.filter(session => session.cwd === folder)).toHaveLength(1)
  },
)
