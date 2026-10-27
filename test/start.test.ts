import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { fakeDispatch } from './dispatch-fixture.ts'
import { integrations } from '../src/cli/integrations.ts'
import { workerHeader } from '../src/cli/start.ts'
import { loadHydra } from '../src/store/hydra-store.ts'

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
