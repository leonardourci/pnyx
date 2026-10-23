import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { openPage, scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()

function initializeProject({ folder }: { folder: string }): void {
  execFileSync(
    'git',
    [
      '-C',
      folder,
      'init',
      '-q',
      '-b',
      'main',
    ],
  )
  const tree = execFileSync(
    'git',
    [
      '-C',
      folder,
      'write-tree',
    ],
    { encoding: 'utf8' },
  ).trim()
  const commit = execFileSync(
    'git',
    [
      '-C',
      folder,
      'hash-object',
      '-t',
      'commit',
      '-w',
      '--stdin',
    ],
    {
      encoding: 'utf8',
      input: `tree ${tree}\nauthor Fixture <fixture@example.test> 0 +0000\ncommitter Fixture <fixture@example.test> 0 +0000\n\nFixture project\n`,
    },
  ).trim()
  execFileSync(
    'git',
    [
      '-C',
      folder,
      'update-ref',
      'HEAD',
      commit,
    ],
  )
}

test(
  'new workers receive full standing notes in order, only for their project, and the page receives Pnyx edit notices',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'app' })
    initializeProject({ folder })
    await s.owner({
      args: [
        'project',
        'add',
        folder,
      ],
    })
    const hydraNotes = 'Keep complete links.\nReport the outcome.'
    const projectNotes = `Upload media to pr-media.\n${'Keep synthetic media private.\n'.repeat(25)}`.trim()
    await s.owner({
      args: [
        'hydra',
        'worker-notes',
        'set',
        '--text',
        hydraNotes,
        '--reason',
        'Owner preference',
      ],
    })
    await s.owner({
      args: [
        'project',
        'worker-notes',
        'set',
        '--project',
        folder,
        '--text',
        projectNotes,
        '--reason',
        'Repeated media questions',
      ],
    })
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })

    try {
      const notices = await page.shows({
        what: 'both worker instruction edits in the chat',
        check: ({ state }) => state.hydraMessages?.length === 2 && state.hydraMessages,
      })
      assert.deepEqual(
        notices.map(message => message.actor),
        [
          'pnyx',
          'pnyx',
        ],
      )
      assert.match(
        notices[1]!.text,
        /Standing worker instructions for app changed: Repeated media questions/,
      )
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          'media',
          '--title',
          'Upload screenshots',
          '--project',
          folder,
        ],
      })
      await s.owner({
        args: [
          'task',
          'start',
          'media',
          '--in-place',
        ],
      })
      await until({
        what: 'the project worker to finish its opening turn',
        check: () => s.task({ key: 'media' }).sessionActivity === 'finished',
      })
      const prompt = s.received({ cwd: folder })[0]!
      const task = s.task({ key: 'media' })
      assert.ok(prompt.startsWith(`<pnyx-worker task="${task.id}"`))
      assert.ok(prompt.indexOf('Authority:') < prompt.indexOf(hydraNotes))
      assert.ok(prompt.includes(`${hydraNotes}\n${projectNotes}\n</pnyx-worker>`))
      assert.equal(
        prompt.split(projectNotes).length,
        2,
      )
      const unrelated = s.folder({ name: 'other-project' })
      initializeProject({ folder: unrelated })
      await s.owner({
        args: [
          'project',
          'add',
          unrelated,
        ],
      })
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          'other',
          '--title',
          'Other work',
          '--project',
          unrelated,
        ],
      })
      await s.owner({
        args: [
          'task',
          'start',
          'other',
          '--in-place',
        ],
      })
      await until({
        what: 'the unrelated worker to finish its opening turn',
        check: () => s.task({ key: 'other' }).sessionActivity === 'finished',
      })
      const otherPrompt = s.received({ cwd: unrelated })[0]!
      assert.ok(otherPrompt.includes(hydraNotes))
      assert.ok(!otherPrompt.includes(projectNotes))
    } finally {
      page.close()
    }
  },
)
