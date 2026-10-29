import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '#app/cli.ts'
import { commit } from '#app/cli-support.ts'
import { hydraDir } from '#app/home-migration.ts'
import { decidePush } from '#tasks/push.ts'
import { listFolders } from './folders.ts'

const AT = '2026-10-29T10:00:00Z'

const workIn = ({
  key,
  cwd,
}: {
  key: string
  cwd: string
}) => commit({
  hydraId: 'default',
  meta: {
    actor: 'test',
    at: AT,
  },
  intent: {
    type: 'card.pushed',
    card: key,
  },
  decide: ({
    state,
    meta,
  }) => decidePush({
    state,
    key,
    input: {
      agent: {
        provider: 'claude',
        sessionId: `${key}-session`,
        cwd,
      },
    },
    meta,
  }),
})

test(
  "folders agents worked in leave out Hydra's own agent folders",
  async () => {
    const home = realpathSync(mkdtempSync(join(
      tmpdir(),
      'pnyx-folders-',
    )))
    process.env.PNYX_HOME = join(
      home,
      'pnyx',
    )
    const project = join(
      home,
      'billing',
    )
    mkdirSync(project)
    commands.hydra([
      'create',
      'default',
    ])
    const agentFolder = join(
      hydraDir({ hydraId: 'default' }),
      'agent',
    )
    mkdirSync(
      agentFolder,
      { recursive: true },
    )
    workIn({
      key: 'hydra-turn',
      cwd: agentFolder,
    })
    workIn({
      key: 'billing-fix',
      cwd: project,
    })

    const { recent } = await listFolders({
      path: '',
      home,
    })

    assert.deepEqual(
      recent.map(folder => folder.path),
      [project],
    )
  },
)
