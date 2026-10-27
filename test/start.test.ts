import {
  ORCHESTRATE_SKILL,
  MANAGE_WORKERS_SKILL,
  INSCRIBE_SKILL,
} from '../src/integrations/skills/names.ts'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commandCapture } from './command-capture.ts'

import type { PaseoClient } from '@getpaseo/client'
import { project } from '../src/projects/cli.ts'
import { HYDRA_CARD } from '../src/core/hydra.ts'
import { ingestSpool } from '../src/integrations/hooks/ingest.ts'
import { commands } from '../src/cli/commands.ts'
import { dispatchCommands } from '../src/dispatch/cli.ts'
import { fakeDispatch } from './dispatch-fixture.ts'
import { integrations } from '../src/cli/integrations.ts'
import { HYDRA_SKILL, setupHydra, startHydra, startTask, workerHeader } from '../src/cli/start.ts'
import { loadHydra } from '../src/store/hydra-store.ts'

const at = '2026-10-15T00:00:00Z'
const meta = {
  at,
  actor: 'test',
}
const ROOT = join(
  import.meta.dirname,
  '..',
)

function lab() {
  const root = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-start-',
  )))
  process.env.PNYX_HOME = join(
    root,
    'pnyx',
  )
  fakeDispatch({ root })
  const folder = join(
    root,
    'work',
  )
  mkdirSync(folder)
  const run = ({ args }: { args: string[] }) => commands[args[0] as keyof typeof commands]([
    ...args.slice(1),
    '--hydra',
    'lab',
  ])
  run({
    args: [
      'hydra',
      'create',
      'lab',
    ],
  })

  return {
    root,
    folder,
    run,
    state: () => loadHydra({ hydraId: 'lab' }).state,
  }
}

async function written({
  path,
  captures,
}: {
  path: string
  captures: ReturnType<typeof commandCapture>
}): Promise<string> {
  await captures.completed()

  return readFileSync(
    path,
    'utf8',
  )
}

// The installed hook as a session started with the given environment would run it.
function hook({
  env,
  session,
  event,
}: {
  env: Record<string, string>
  session: string
  event: string
}) {
  const payload = JSON.stringify({
    session_id: session,
    hook_event_name: event,
    cwd: env.PNYX_FOLDER,
    prompt: 'go',
  })
  const ran = spawnSync(
    '/bin/sh',
    [
      join(
        ROOT,
        'setup',
        'hooks',
        'pnyx-hook.sh',
      ),
      'claude',
      event,
    ],
    {
      input: payload,
      env: {
        PATH: process.env.PATH,
        ...env,
      },
    },
  )
  assert.equal(
    ran.status,
    0,
  )
}

const environment = ({ text }: { text: string }): Record<string, string> => JSON.parse(text)

const captureEnvironment = ({ path }: { path: string }) => {
  const script = `const fs = require('node:fs'); const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PNYX_'))); fs.writeFileSync(${JSON.stringify(path + '.tmp')}, JSON.stringify(env)); fs.renameSync(${JSON.stringify(path + '.tmp')}, ${JSON.stringify(path)});`

  return `node -e '${script.replaceAll(
    "'",
    "'\\''",
  )}'`
}

test(
  'task start --via command runs the Hydra command once and its session joins the task',
  async t => {
    const captures = commandCapture({ t })
    const {
      root,
      folder,
      run,
      state,
    } = lab()
    const out = join(
      root,
      'env.txt',
    )
    run({
      args: [
        'hydra',
        'set',
        '--command',
        captureEnvironment({ path: out }),
      ],
    })
    run({
      args: [
        'task',
        'create',
        '--title',
        'Write the docs',
        '--folder',
        folder,
      ],
    })
    const task = Object.values(state().cards).find(c => c.title === 'Write the docs')!.id

    await run({
      args: [
        'task',
        'brief',
        task,
        '--brief',
        'Draft it',
      ],
    })
    const started = await startTask({
      hydraId: 'lab',
      task,
      via: 'command',
      meta: {
        ...meta,
        id: 's1',
      },
    })
    assert.equal(
      started.via,
      'command',
    )
    assert.equal(
      state().cards[task]?.launch?.via,
      'command',
    )
    assert.equal(
      state().cards[task]?.launch?.pid,
      started.pid,
    )
    assert.equal(
      state().cards[task]?.launch?.folder,
      folder,
    )
    assert.equal(
      state().cards[task]?.status?.state,
      'working',
    )
    assert.equal(
      state().cards[task]?.column,
      state().config?.columns.find(c => c.role === 'in_progress')?.id,
    )
    const env = environment({
      text: await written({
        path: out,
        captures,
      }),
    })
    assert.equal(
      env.PNYX_TASK,
      task,
    )
    assert.equal(
      env.PNYX_HYDRA,
      'lab',
    )
    assert.equal(
      env.PNYX_HOME,
      process.env.PNYX_HOME,
    )
    assert.equal(
      env.PNYX_ROLE,
      'worker',
    )
    assert.match(
      env.PNYX_PROMPT!,
      /^<pnyx-worker [^>]*>[\s\S]*<\/pnyx-worker>\n\nDraft it\n\nYou are the Pnyx worker/,
    )
    assert.equal(
      env.PNYX_FOLDER,
      folder,
    )
    assert.equal(
      state().cards[task]!.notes?.at(-1)?.source,
      'pnyx:start',
    )

    writeFileSync(
      out,
      '',
    )
    assert.equal(
      (await startTask({
        hydraId: 'lab',
        task,
        via: 'command',
        meta: {
          ...meta,
          id: 's1',
        },
      })).event,
      'none: duplicate',
    )
    assert.equal(
      captures.count(),
      1,
    )
    assert.equal(
      readFileSync(
        out,
        'utf8',
      ),
      '',
    )

    hook({
      env,
      session: 'cmd-1',
      event: 'SessionStart',
    })
    ingestSpool({ hydraId: 'lab' })
    assert.deepEqual(
      state().cards[task]!.sessionIds,
      ['claude-code:cmd-1'],
    )
    assert.equal(
      state().sessions?.['claude-code:cmd-1']?.launch?.via,
      'command',
    )
    assert.equal(
      state().sessions?.['claude-code:cmd-1']?.launch?.pid,
      started.pid,
    )
    hook({
      env,
      session: 'cmd-2',
      event: 'SessionStart',
    })
    ingestSpool({ hydraId: 'lab' })
    assert.deepEqual(
      state().cards[task]!.sessionIds,
      ['claude-code:cmd-1'],
    )

    run({
      args: [
        'hydra',
        'set',
        '--command',
        '',
      ],
    })
    await assert.rejects(
      startTask({
        hydraId: 'lab',
        task,
        via: 'command',
        meta,
      }),
      /no start command/,
    )
  },
)

test(
  'hydra start --via command makes its first session the Hydra, never a worker',
  async t => {
    const captures = commandCapture({ t })
    const {
      root,
      folder,
      run,
      state,
    } = lab()
    const out = join(
      root,
      'env.txt',
    )
    run({
      args: [
        'hydra',
        'set',
        '--command',
        captureEnvironment({ path: out }),
      ],
    })
    run({
      args: [
        'task',
        'create',
        '--title',
        'Same folder',
        '--folder',
        folder,
      ],
    })

    await startHydra({
      hydraId: 'lab',
      via: 'command',
      folder,
      meta: {
        ...meta,
        id: 'h1',
      },
    })
    const env = environment({
      text: await written({
        path: out,
        captures,
      }),
    })
    assert.equal(
      env.PNYX_TASK,
      HYDRA_CARD,
    )
    assert.equal(
      env.PNYX_ROLE,
      'hydra',
    )
    assert.match(
      env.PNYX_PROMPT!,
      new RegExp(String.raw`${ORCHESTRATE_SKILL}`),
    )

    hook({
      env,
      session: 'hydra-1',
      event: 'SessionStart',
    })
    ingestSpool({ hydraId: 'lab' })
    assert.equal(
      state().config?.hydra.session,
      'claude-code:hydra-1',
    )
    assert.deepEqual(
      Object.values(state().cards).find(c => c.title === 'Same folder')!.sessionIds,
      [],
    )
  },
)

test(
  'integrations show what is ready and how to set up the rest',
  async () => {
    lab()
    const out = await integrations({
      hydraId: 'lab',
      url: 'ws://127.0.0.1:1/ws',
    }) as {
      integrations: {
        name: string
        status: string
        setup: string
      }[]
    }
    const row = ({ name }: { name: string }) => out.integrations.find(i => i.name === name)!
    assert.equal(
      row({ name: 'hooks' }).status,
      'hook script missing',
    )
    assert.match(
      row({ name: 'paseo' }).status,
      /^not running: Paseo is not running/,
    )
    assert.equal(
      row({ name: 'command' }).status,
      'not set',
    )
    assert.match(
      row({ name: 'firstmate' }).setup,
      /setup hydra --home/,
    )
  },
)

test(
  'Hydra can select its task project’s start command by name',
  async t => {
    const captures = commandCapture({ t })
    const {
      root,
      folder,
      run,
      state,
    } = lab()
    const out = join(
      root,
      'project-command.txt',
    )
    await project([
      'add',
      folder,
      '--hydra',
      'lab',
    ])
    await project([
      'set',
      'work',
      '--command-name',
      'fixture worker',
      '--command',
      captureEnvironment({ path: out }),
      '--brings-own-folder',
      'true',
      '--hydra',
      'lab',
    ])
    run({
      args: [
        'task',
        'create',
        '--title',
        'Project work',
        '--key',
        'ship',
        '--project',
        'work',
      ],
    })
    await run({
      args: [
        'task',
        'start',
        'ship',
        '--via',
        'command',
        '--command',
        'fixture worker',
        '--event-id',
        'project-start',
      ],
    })
    const env = environment({
      text: await written({
        path: out,
        captures,
      }),
    })
    assert.equal(
      env.PNYX_FOLDER,
      folder,
    )
    assert.equal(
      state().cards[state().keys.ship!]!.copy,
      undefined,
    )
    assert.equal(
      env.PNYX_TASK,
      state().keys.ship,
    )
    const task = state().cards[state().keys.ship!]!
    assert.equal(
      task.launch?.command,
      captureEnvironment({ path: out }),
    )
    writeFileSync(
      out,
      '',
    )
    await run({
      args: [
        'task',
        'start',
        'ship',
        '--via',
        'command',
        '--command',
        'fixture worker',
        '--event-id',
        'project-start',
      ],
    })
    assert.equal(
      captures.count(),
      1,
    )
    assert.equal(
      readFileSync(
        out,
        'utf8',
      ),
      '',
    )
    await assert.rejects(
      startTask({
        hydraId: 'lab',
        task: 'ship',
        via: 'command',
        commandName: 'missing',
        meta,
      }),
      /project command not found/,
    )
    await assert.rejects(
      startTask({
        hydraId: 'lab',
        task: 'ship',
        via: 'pnyx',
        commandName: 'fixture worker',
        meta,
      }),
      /--command needs --via command/,
    )
    run({
      args: [
        'task',
        'create',
        '--title',
        'No project',
        '--key',
        'other',
      ],
    })
    await assert.rejects(
      startTask({
        hydraId: 'lab',
        task: 'other',
        via: 'command',
        commandName: 'fixture worker',
        meta,
      }),
      /project command not found/,
    )
  },
)

test(
  'a named command uses the task copy unless it brings its own folder',
  async t => {
    const captures = commandCapture({ t })
    const {
      root,
      folder,
      run,
      state,
    } = lab()
    const copy = join(
        root,
        'worker-copy',
      ), out = join(
        root,
        'copy-env.txt',
      )
    mkdirSync(copy)
    await project([
      'add',
      folder,
      '--hydra',
      'lab',
    ])
    await project([
      'set',
      'work',
      '--copy',
      `echo '${copy}'`,
      '--command-name',
      'fixture',
      '--command',
      captureEnvironment({ path: out }),
      '--hydra',
      'lab',
    ])
    run({
      args: [
        'task',
        'create',
        '--title',
        'Copy work',
        '--key',
        'ship',
        '--project',
        'work',
      ],
    })
    await run({
      args: [
        'task',
        'start',
        'ship',
        '--via',
        'command',
        '--command',
        'fixture',
      ],
    })
    const env = environment({
      text: await written({
        path: out,
        captures,
      }),
    })
    assert.equal(
      env.PNYX_FOLDER,
      copy,
    )
    assert.equal(
      state().cards[state().keys.ship!]!.copy?.path,
      copy,
    )
  },
)

test(
  'worker headers append standing notes verbatim after fixed authority and landing rules',
  () => {
    const base = {
      hydraId: 'lab',
      id: 'task-notes',
      stops: ['Land through a pull request.'],
    }
    const hydraNotes = 'Always attach proof.\nKeep the full URL.'
    const projectNotes = 'Upload media to pr-media.\nDo not stop for this approval.'
    const header = workerHeader({
      ...base,
      hydraNotes,
      projectNotes,
    })
    assert.ok(header.indexOf('Authority:') < header.indexOf(base.stops[0]!))
    assert.ok(header.indexOf(base.stops[0]!) < header.indexOf(hydraNotes))
    assert.ok(header.includes(`${hydraNotes}\n${projectNotes}\n</pnyx-worker>`))
    assert.match(
      header,
      /defer to the scope and authority above/,
    )
    assert.doesNotMatch(
      workerHeader(base),
      /Standing worker instructions/,
    )
    assert.equal(
      workerHeader({
        ...base,
        hydraNotes: '',
        projectNotes: '',
      }),
      workerHeader(base),
    )
  },
)
