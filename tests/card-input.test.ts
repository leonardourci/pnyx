import { beforeAll, expect, onTestFinished, test } from 'vitest'
import { loadTitan } from '#app/store.ts'
import { git } from './setup/upgrade.ts'
import { startOthrys, until, type Othrys } from './setup/othrys.ts'

const MODEL_SEND = '5f8d0a42-7c6e-4a3d-9b94-8e0f2a3c4d56'

let othrys: Othrys

beforeAll(async () => {
  othrys = await startOthrys()
})

test(
  'a card send starts one worker directly and retries preserve its receipt',
  async () => {
    const titan = await othrys.titan()
    const folder = titan.folder({ name: 'quick-worker' })
    await titan.owner({
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
    await titan.owner({
      args: [
        'task',
        'hide',
        'quick',
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
    const sent = await titan.owner({ args })
    expect(sent).toMatchObject({ state: 'queued' })
    expect(sent.notices).toContainEqual(expect.objectContaining({
      task: (await titan.task({ key: 'quick' })).id,
      reason: expect.stringContaining('hidden'),
    }))
    const worker = await titan.agent({ cwd: folder })
    await until({
      what: 'direct start reaches the worker',
      check: () => worker.answered === 1,
    })
    expect(worker.received[0]).toContain('Fix the missing export')
    expect(othrys.claude.sessions.filter(session => session.cwd === folder)).toHaveLength(1)
    expect(await titan.owner({ args })).toMatchObject({ state: 'delivered' })
    expect(worker.received).toHaveLength(1)
    const page = await titan.page()

    try {
      expect(await page.send({
        name: 'thread',
        args: ['quick'],
      })).toMatchObject({
        type: 'receipt',
        thread: { card: (await titan.task({ key: 'quick' })).id },
      })
    } finally {
      page.close()
    }

    const { thread } = await titan.owner({
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
    expect((await titan.owner({
      args: [
        'titan',
        'messages',
      ],
    })).messages).toBe('none: no messages after seq 0')
  },
)

test(
  'a harness switch interrupts the live turn and carries its recorded conversation',
  async () => {
    const titan = await othrys.titan()
    const {
      folder,
      worker,
    } = await titan.startTask({ key: 'switch' })
    const held = othrys.claude.plan({
      titan: titan.id,
      hold: true,
      partial: 'Finishing the current change',
      reply: 'The parser now rejects an empty input',
    })
    onTestFinished(() => held.release())
    await titan.owner({
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
    const task = await titan.task({ key: 'switch' })
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
    await titan.owner({ args })
    await until({
      what: 'the next harness starts without releasing the old turn',
      check: () => othrys.codex.sessions.some(session =>
        session.cwd === folder && session.answered === 1),
    })
    const next = othrys.codex.sessions.find(session => session.cwd === folder)!
    const previous = loadTitan({ titanId: titan.id }).state.sessions?.[`claude-code:${worker.id}`]
    expect(next.received[0]).toContain(`Read the previous session "claude-code:${worker.id}" completely before continuing.`)
    expect(previous?.agent.transcriptPath).toEqual(expect.any(String))
    expect(next.received[0]).toContain(`Its recorded transcript is ${JSON.stringify(previous?.agent.transcriptPath)}.`)
    expect(next.received[0]).toContain('task.log')
    expect(next.received[0]).not.toContain('othrys task chat')
    expect(next.received[0]).toContain('Continue with the regression fix')
    const currentThread = await titan.owner({
      args: [
        'task',
        'chat',
        'switch',
      ],
    })
    expect(currentThread.thread.entries).toContainEqual(expect.objectContaining({
      text: 'Recorded reply.',
    }))

    const selected = await titan.owner({
      args: [
        'task',
        'chat',
        'switch',
        '--session',
        `codex:${next.id}`,
      ],
    })
    expect(selected.thread.entries).not.toContainEqual(expect.objectContaining({
      text: 'Recorded reply.',
      session: `claude-code:${worker.id}`,
    }))
    expect(selected.thread.entries).toContainEqual(expect.objectContaining({
      text: 'Recorded reply.',
      session: `codex:${next.id}`,
    }))
    expect(next.cwd).toBe(folder)
    expect(worker.closed).toBe(true)
    expect(next.id).not.toBe(worker.id)
    expect((await titan.as({ session: worker }).refused({
      args: [
        'task',
        'inbox',
        'read',
        task.id,
      ],
    })).code).toBe('STALE_CLAIM')
    expect((await titan.as({ session: next }).run({
      args: [
        'task',
        'inbox',
        'read',
        task.id,
      ],
    })).pending).toBe(0)
    expect(await titan.owner({ args })).toMatchObject({ state: 'delivered' })
    expect(othrys.codex.sessions.filter(session => session.cwd === folder)).toHaveLength(1)
    await titan.owner({
      args: [
        'task',
        'send',
        'switch',
        '--harness',
        'codex',
        '--model',
        'gpt-6-luna',
        '--text',
        'Continue from the idle session',
      ],
    })
    await until({
      what: 'the idle Codex session to take its next input',
      check: () => next.answered === 2,
    })
    expect(next.received[1]).toContain('Continue from the idle session')
    expect(othrys.codex.sessions.filter(session => session.cwd === folder)).toHaveLength(1)
  },
)

test(
  'same-harness model changes interrupt the turn and keep the session, and the card send reaches it under the owner\'s id',
  async () => {
    const titan = await othrys.titan()
    const {
      folder,
      worker,
    } = await titan.startTask({ key: 'model' })
    const held = othrys.claude.plan({
      titan: titan.id,
      hold: true,
    })
    onTestFinished(() => held.release())
    await titan.owner({
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
    await titan.owner({
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
        MODEL_SEND,
      ],
    })
    await until({
      what: 'the same session receives its next turn',
      check: () => worker.answered === 3,
    })
    expect(worker.model).toBe('sonnet')
    expect(worker.received[2]).toContain('Check the new model')
    expect(worker.uuids[2]).toBe(MODEL_SEND)
    expect(othrys.claude.sessions.filter(session => session.cwd === folder)).toHaveLength(1)
    await titan.owner({
      args: [
        'task',
        'send',
        'model',
        '--text',
        'Change the idle model',
        '--harness',
        'claude',
        '--model',
        'opus',
      ],
    })
    await until({
      what: 'the idle session to take its new model',
      check: () => worker.answered === 4,
    })
    expect(worker.model).toBe('opus')
    expect(othrys.claude.sessions.filter(session => session.cwd === folder)).toHaveLength(1)
  },
)

test(
  'creating and sending a project task makes its normal repository copy once',
  async () => {
    const titan = await othrys.titan()
    const repository = titan.folder({ name: 'direct-project' })
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
    await titan.owner({
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
    const created = await titan.owner({ args })
    const worker = await until({
      what: 'the task has its own worker',
      check: () => othrys.claude.sessions.find(session =>
        session.env.OTHRYS_ACTOR === `worker:${created.card.id}`
        && session.answered === 1),
    })
    const { task: current } = await titan.owner({
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
    const repeated = await titan.owner({ args })
    expect(repeated.card.id).toBe(created.card.id)
    expect(current.project).toBe(repository)
    expect(othrys.claude.sessions.filter(session => session.cwd === worker!.cwd)).toHaveLength(1)
  },
)

test(
  'a Send after Stop changes harness immediately',
  async () => {
    const titan = await othrys.titan()
    const {
      folder,
      worker,
    } = await titan.startTask({ key: 'stop-switch' })
    const held = othrys.claude.plan({
      titan: titan.id,
      hold: true,
    })
    onTestFinished(() => held.release())
    await titan.owner({
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
    await titan.owner({
      args: [
        'task',
        'stop',
        'stop-switch',
      ],
    })
    expect(othrys.codex.sessions.filter(session => session.cwd === folder)).toHaveLength(0)
    await titan.owner({
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
      check: () => othrys.codex.sessions.some(session =>
        session.cwd === folder && session.answered === 1),
    })
  },
)

test(
  'a refused direct start retries once after its account is configured',
  async () => {
    const titan = await othrys.titan()
    const folder = titan.folder({ name: 'retry-start' })
    const login = titan.folder({ name: 'later-login' })
    await titan.owner({
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
    await titan.owner({ args })
    await until({
      what: 'the missing account refuses the start',
      check: async () => (await titan.owner({
        args: [
          'task',
          'chat',
          'retry',
        ],
      })).thread.entries.some((entry: { receipt?: string }) => entry.receipt === 'failed'),
    })
    expect(othrys.claude.sessions.filter(session => session.cwd === folder)).toHaveLength(0)
    await titan.owner({
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
    await titan.owner({ args })
    const worker = await titan.agent({ cwd: folder })
    await until({
      what: 'the same message starts after the account is configured',
      check: () => worker.answered === 1,
    })
    expect(worker.received[0]).toContain('Start when this login is configured')
    expect(await titan.owner({ args })).toMatchObject({ state: 'delivered' })
    expect(othrys.claude.sessions.filter(session => session.cwd === folder)).toHaveLength(1)
  },
)

test(
  'a delivered harness switch survives an Othrys restart without a second launch',
  async () => {
    const titan = await othrys.titan()
    const {
      folder,
      worker,
    } = await titan.startTask({ key: 'restart-switch' })
    const held = othrys.claude.plan({
      titan: titan.id,
      hold: true,
    })
    onTestFinished(() => held.release())
    await titan.owner({
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
    await titan.owner({ args })
    await until({
      what: 'the switch to finish before restart',
      check: () => othrys.codex.sessions.some(session =>
        session.cwd === folder && session.answered === 1),
    })
    await othrys.restart({ whileStopped: () => held.release() })
    await until({
      what: 'the saved switch reaches the new harness',
      check: () => othrys.codex.sessions.some(session =>
        session.cwd === folder && session.answered === 1),
    })
    expect(await titan.owner({ args })).toMatchObject({ state: 'delivered' })
    expect(othrys.codex.sessions.filter(session => session.cwd === folder)).toHaveLength(1)
  },
)
