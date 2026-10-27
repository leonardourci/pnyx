import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { HydraState, HydraEvent } from '../src/app/model.ts'
import { liveTask } from '../src/core/tasks.ts'
import { hydraName } from '../src/cli/commands.ts'

const bin = join(
  import.meta.dirname,
  '../dist/cli/pnyx-axi.js',
)

function fixture({ hydraId = 'default' }: { hydraId?: string } = {}) {
  const root = mkdtempSync(join(
    tmpdir(),
    'pnyx-hydra-',
  ))
  const env = {
    ...process.env,
    PNYX_HOME: root,
    PNYX_SEMANTIC: 'off',
  }

  const run = ({ args }: { args: string[] }): string => {
    const out = execFileSync(
      process.execPath,
      [
        bin,
        ...args,
        '--hydra',
        hydraId,
      ],
      {
        env,
        encoding: 'utf8',
      },
    )
    const token = /^token: ([a-f0-9]+)$/m.exec(out)?.[1]

    return token ? run({
      args: [
        ...args,
        '--confirm',
        token,
      ],
    }) : out
  }

  const state = ({ id = hydraId }: { id?: string } = {}): HydraState => JSON.parse(readFileSync(
    join(
      root,
      'hydras',
      id,
      'snapshot.json',
    ),
    'utf8',
  )).state
  const events = (): HydraEvent[] => readFileSync(
    join(
      root,
      'hydras',
      hydraId,
      'events.jsonl',
    ),
    'utf8',
  ).trim()
    .split('\n')
    .map(line => JSON.parse(line))

  const push = ({
    key,
    input,
  }: {
    key: string
    input: object
  }) => {
    const path = join(
      root,
      'input.json',
    )
    writeFileSync(
      path,
      JSON.stringify(input),
    )

    return run({
      args: [
        'push',
        '--key',
        key,
        '--file',
        path,
      ],
    })
  }

  return {
    root,
    run,
    state,
    events,
    push,
  }
}

test(
  'Hydras keep one Hydra each, independent task lists, and durable history after switching',
  () => {
    const f = fixture()

    try {
      f.run({
        args: [
          'hydra',
          'create',
          'default',
          '--identity',
          'first',
        ],
      })
      f.run({
        args: [
          'task',
          'create',
          '--key',
          'work',
          '--title',
          'Ship search',
        ],
      })
      f.run({
        args: [
          'hydra',
          'send',
          '--text',
          'What is left in the Hydra?',
        ],
      })
      const question = f.state().hydraMessages?.at(-1)
      assert.equal(
        question?.text,
        'What is left in the Hydra?',
      )
      assert.equal(
        question?.task,
        undefined,
      )
      assert.doesNotMatch(
        f.run({
          args: [
            'task',
            'history',
            'work',
          ],
        }),
        /What is left in the Hydra/,
      )
      f.run({
        args: [
          'hydra',
          'create',
          'other',
          '--identity',
          'second',
        ],
      })
      assert.equal(
        f.state({ id: 'other' }).config?.hydra.id,
        'second',
      )
      assert.equal(
        Object.values(f.state({ id: 'other' }).cards).filter(card => liveTask({ card })).length,
        0,
      )
      f.run({
        args: [
          'hydra',
          'set',
          '--identity',
          'replacement',
        ],
      })
      assert.equal(
        f.state().config?.hydra.id,
        'replacement',
      )
      assert.equal(
        f.state().hydraMessages?.[0]?.hydra,
        'first',
      )
    } finally {
      rmSync(
        f.root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'an unnamed Hydra takes its name from the first message line of text and keeps any name it has',
  () => {
    const f = fixture()
    const send = ({ text }: { text: string }) => f.run({
      args: [
        'hydra',
        'send',
        '--text',
        text,
      ],
    })

    try {
      f.run({
        args: [
          'hydra',
          'create',
          'default',
          '--name',
          '',
        ],
      })
      send({ text: '[image: /tmp/hydras/default/attachments/a.png]' })
      f.run({
        args: [
          'hydra',
          'send',
          '--text',
          'Worker report: tests pass',
          '--actor',
          'worker:task-1',
        ],
      })
      assert.equal(
        f.state().config?.name,
        '',
      )
      send({ text: 'File: notes.txt\n\n```\nfirst file line\n```\n\n[image: /tmp/a.png]\n\n  Ask [@pnyx](pnyx-project:%2Fwork%2Fpnyx) about updates to the UI, please and thanks\nsecond line' })
      assert.equal(
        f.state().config?.name,
        'Ask pnyx about updates to the UI, please…',
      )
      send({ text: 'Rename yourself' })
      f.run({
        args: [
          'hydra',
          'set',
          '--name',
          'Manual',
        ],
      })
      send({ text: 'Another message' })
      assert.equal(
        f.state().config?.name,
        'Manual',
      )
      assert.deepEqual(
        f.events().filter(event => event.type === 'board.configured')
          .map(event => event.type === 'board.configured' && event.data.name),
        [
          '',
          'Ask pnyx about updates to the UI, please…',
          'Manual',
        ],
      )
    } finally {
      rmSync(
        f.root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'a Hydra name keeps whole words near 40 characters, never splits a character and needs real text',
  () => {
    assert.equal(
      hydraName({ text: '[image: /tmp/a.png]' }),
      undefined,
    )
    assert.equal(
      hydraName({ text: 'Short title\nmore' }),
      'Short title',
    )
    assert.equal(
      hydraName({ text: 'I supercalifragilisticexpialidocious-and-more-words-here' }),
      'I supercalifragilisticexpialidocious-and…',
    )
    assert.equal(
      hydraName({ text: `${'a'.repeat(39)}😀 more words` }),
      `${'a'.repeat(39)}…`,
    )
    assert.equal(
      hydraName({ text: '!'.repeat(50) }),
      undefined,
    )
    assert.equal(
      hydraName({ text: '[image: /h/a.png]\nIn [image: /h/b.png], it is big' }),
      'In Image 2, it is big',
    )
  },
)

test(
  'rules place explicit phases and ended workers, manual moves last until a new phase, and column deletion is undoable',
  () => {
    const f = fixture()

    try {
      f.run({
        args: [
          'hydra',
          'create',
          'default',
        ],
      })
      f.run({
        args: [
          'task',
          'create',
          '--title',
          'Root',
          '--key',
          'root',
        ],
      })
      f.run({
        args: [
          'task',
          'create',
          '--title',
          'Child',
          '--key',
          'child',
          '--parent',
          'root',
        ],
      })
      assert.throws(() => f.run({
        args: [
          'task',
          'create',
          '--title',
          'Too deep',
          '--parent',
          'child',
        ],
      }))
      const root = f.state().keys.root!
      const child = f.state().keys.child!
      const column = ({ role }: { role: string }) =>
        f.state().config?.columns.find(c => c.role === role)?.id
      const placed = () => f.state().cards[root]?.column
      f.run({
        args: [
          'task',
          'status',
          'root',
          'working',
          '--note',
          'Building it',
        ],
      })
      assert.equal(
        placed(),
        column({ role: 'in_progress' }),
      )
      f.push({
        key: 'session',
        input: {
          agent: {
            provider: 'claude-code',
            sessionId: 'worker',
          },
          terminal: {
            tty: '/dev/ttys123',
            pid: '123',
          },
          source: {
            adapter: 'hooks',
            objectId: 'worker',
          },
        },
      })
      f.run({
        args: [
          'task',
          'attach',
          'root',
          '--session',
          'claude-code:worker',
        ],
      })
      const hook = ({ input }: { input: object }) => f.push({
        key: 'root',
        input: {
          ...input,
          source: {
            adapter: 'hooks',
            objectId: 'worker',
          },
        },
      })
      hook({ input: { activity: 'finished' } })
      hook({ input: { activity: 'ended' } })
      assert.equal(
        placed(),
        column({ role: 'parked' }),
      )
      f.run({
        args: [
          'move',
          'root',
          column({ role: 'queued' })!,
        ],
      })
      hook({ input: { activity: 'working' } })
      f.run({
        args: [
          'task',
          'status',
          'root',
          'working',
          '--note',
          'Still building',
        ],
      })
      assert.equal(
        placed(),
        column({ role: 'in_progress' }),
      )
      hook({
        input: {
          attention: [
            {
              kind: 'question',
              key: 'hook:tool:AskUserQuestion',
              blocking: true,
              text: 'Pick a schema',
            },
          ],
        },
      })
      assert.equal(
        placed(),
        column({ role: 'needs_you' }),
      )
      hook({ input: { attention: [] } })
      assert.equal(
        placed(),
        column({ role: 'in_progress' }),
      )

      for (const [
        state,
        role,
      ] of [
          [
            'blocked',
            'in_progress',
          ],
          [
            'working',
            'in_progress',
          ],
        ] as const) {
        f.run({
          args: [
            'task',
            'status',
            'root',
            state,
            '--note',
            `Now ${state}`,
          ],
        })
        assert.equal(
          placed(),
          column({ role }),
        )
      }

      f.run({
        args: [
          'task',
          'status',
          'root',
          'needs-you',
          '--note',
          'Choose a schema',
        ],
      })
      f.run({
        args: [
          'task',
          'status',
          'root',
          'paused',
          '--note',
          'Waiting on CI',
        ],
      })
      assert.equal(
        placed(),
        column({ role: 'parked' }),
      )
      f.run({
        args: [
          'task',
          'status',
          'root',
          'done',
          '--note',
          'Finished',
        ],
      })
      assert.equal(
        placed(),
        column({ role: 'done' }),
      )
      assert.deepEqual(
        f.events().filter(e => e.type === 'card.moved' && e.actor === 'pnyx')
          .map(e => [
            e.type === 'card.moved' && e.data.after,
            e.reason,
          ]),
        [
          [
            column({ role: 'in_progress' }),
            'Declared working',
          ],
          [
            column({ role: 'parked' }),
            'Worker ended with unfinished work',
          ],
          [
            column({ role: 'in_progress' }),
            'Declared working',
          ],
          [
            column({ role: 'needs_you' }),
            'Waiting for the owner',
          ],
          [
            column({ role: 'in_progress' }),
            'Answered',
          ],
          [
            column({ role: 'parked' }),
            'Declared paused',
          ],
          [
            column({ role: 'done' }),
            'Declared done',
          ],
        ],
      )
      f.run({
        args: [
          'column',
          'create',
          '--title',
          'Research',
          '--id',
          'custom:research',
        ],
      })
      f.run({
        args: [
          'move',
          'root',
          'custom:research',
        ],
      })
      f.run({
        args: [
          'task',
          'status',
          'root',
          'needs-you',
          '--note',
          'Review the research',
        ],
      })
      assert.equal(
        placed(),
        column({ role: 'in_progress' }),
      )
      f.run({
        args: [
          'move',
          'root',
          'custom:research',
        ],
      })
      f.run({
        args: [
          'column',
          'delete',
          'custom:research',
          '--to',
          'parked',
        ],
      })
      assert.equal(
        f.state().cards[root]?.column,
        f.state().config?.columns.find(c => c.role === 'parked')?.id,
      )
      f.run({
        args: [
          'undo',
          f.events().at(-1)!.id,
        ],
      })
      assert.equal(
        f.state().cards[root]?.column,
        'custom:research',
      )
      f.run({
        args: [
          'task',
          'status',
          'child',
          'paused',
          '--note',
          'Waiting for review',
        ],
      })
      const history = f.events()
      assert.ok(history.every(e => e.boardId === 'default' && e.commandId))
      assert.ok(history.some(e => e.subtaskId === child && e.taskId === root))
    } finally {
      rmSync(
        f.root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'ad-hoc sessions never become tasks, the Hydra session never joins one, and the last column stays',
  () => {
    const f = fixture()

    try {
      f.run({
        args: [
          'hydra',
          'create',
          'default',
        ],
      })
      f.push({
        key: 'ad-hoc',
        input: {
          title: 'Unassigned interactive session',
          agent: {
            provider: 'codex',
            sessionId: 's',
          },
          terminal: { tty: '/dev/ttys123' },
        },
      })
      assert.equal(
        Object.values(f.state().cards).filter(card => liveTask({ card })).length,
        0,
      )
      f.run({
        args: [
          'hydra',
          'set',
          '--identity',
          'codex:s',
          '--session',
          'codex:s',
        ],
      })
      f.run({
        args: [
          'task',
          'create',
          '--key',
          'work',
          '--title',
          'Work',
        ],
      })
      assert.throws(() => f.run({
        args: [
          'task',
          'attach',
          'work',
          '--session',
          'codex:s',
        ],
      }))

      for (const id of [
        'queued',
        'needs_you',
        'in_progress',
        'done',
      ]) {
        f.run({
          args: [
            'column',
            'delete',
            id,
          ],
        })
      }

      assert.throws(() => f.run({
        args: [
          'column',
          'delete',
          'parked',
        ],
      }))
      assert.equal(
        f.state().config?.columns.length,
        1,
      )
    } finally {
      rmSync(
        f.root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'task messages remain in chat after the worker transcript is removed',
  () => {
    const f = fixture()

    try {
      f.run({
        args: [
          'hydra',
          'create',
          'default',
        ],
      })
      f.run({
        args: [
          'task',
          'create',
          '--title',
          'Keep the context',
          '--key',
          'context',
        ],
      })
      const transcript = join(
        f.root,
        'worker.jsonl',
      )
      writeFileSync(
        transcript,
        `${JSON.stringify({
          type: 'assistant',
          timestamp: '2026-10-14T19:00:00Z',
          message: { content: 'The rollout stopped at the canary gate. Key sk-live0123456789abcdefXYZ' },
        })}\n`,
      )
      f.push({
        key: 'worker',
        input: {
          agent: {
            provider: 'claude-code',
            sessionId: 'context-worker',
            transcriptPath: transcript,
          },
          terminal: {
            tty: '/dev/ttys123',
            pid: '123',
          },
        },
      })
      f.run({
        args: [
          'task',
          'attach',
          'context',
          '--session',
          'claude-code:context-worker',
        ],
      })
      const saved = f.events().filter(e => e.type === 'chat.message')
      assert.equal(
        saved.length,
        1,
      )
      assert.ok(saved[0]?.messageId && saved[0]?.sessionId)
      assert.doesNotMatch(
        readFileSync(
          join(
            f.root,
            'hydras',
            'default',
            'events.jsonl',
          ),
          'utf8',
        ),
        /sk-live0123456789abcdefXYZ/,
      )
      assert.match(
        JSON.stringify(saved[0]?.data),
        /canary gate\. Key \[redacted\]/,
      )
      f.run({ args: ['harvest'] })
      assert.equal(
        f.events().filter(e => e.type === 'chat.message').length,
        1,
      )
      rmSync(transcript)
      assert.match(
        f.run({
          args: [
            'task',
            'chat',
            'context',
          ],
        }),
        /rollout stopped at the canary gate/,
      )
      f.run({
        args: [
          'task',
          'detach',
          'context',
        ],
      })
      assert.match(
        f.run({
          args: [
            'task',
            'chat',
            'context',
            '--session',
            'claude-code:context-worker',
          ],
        }),
        /canary gate/,
      )
    } finally {
      rmSync(
        f.root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  "Hydra's own open prompt shows on its card, so its chat can answer it",
  () => {
    const f = fixture()

    try {
      f.run({
        args: [
          'hydra',
          'create',
          'default',
        ],
      })
      const session = {
        agent: {
          provider: 'claude-code',
          sessionId: 'hydra-q',
        },
        terminal: {
          tty: '/dev/ttys123',
          pid: '123',
          program: 'tmux',
          tmux: '/tmp/tmux-1/default',
          tmuxPane: '%1',
        },
        source: {
          adapter: 'hooks',
          instanceId: 'claude',
          objectId: 'hydra-q',
        },
      }
      f.push({
        key: 'claude:hydra-q',
        input: session,
      })
      f.run({
        args: [
          'hydra',
          'set',
          '--session',
          'claude-code:hydra-q',
        ],
      })
      const ask = {
        kind: 'permission',
        key: 'hook:tool:Bash',
        blocking: true,
        text: 'Allow Bash: ls',
      }
      f.push({
        key: 'claude:hydra-q',
        input: {
          ...session,
          attention: [ask],
        },
      })
      assert.match(
        f.run({
          args: [
            'card',
            '$hydra',
          ],
        }),
        /reply \$hydra --answer hook:tool:Bash/,
      )
      f.push({
        key: 'claude:hydra-q',
        input: {
          ...session,
          attention: [],
        },
      })
      assert.doesNotMatch(
        f.run({
          args: [
            'card',
            '$hydra',
          ],
        }),
        /--answer/,
      )
    } finally {
      rmSync(
        f.root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'Hydra’s chat drained from turn-end hooks stays in history after its transcript is removed',
  () => {
    const f = fixture()

    try {
      const transcript = join(
        f.root,
        'hydra.jsonl',
      )
      writeFileSync(
        transcript,
        '',
      )
      f.run({
        args: [
          'hydra',
          'create',
          'default',
        ],
      })
      f.push({
        key: 'claude:hydra-s',
        input: {
          agent: {
            provider: 'claude-code',
            sessionId: 'hydra-s',
            transcriptPath: transcript,
          },
          terminal: {
            tty: '/dev/ttys123',
            pid: '123',
          },
          source: {
            adapter: 'hooks',
            instanceId: 'claude',
            objectId: 'hydra-s',
          },
        },
      })
      f.run({
        args: [
          'hydra',
          'set',
          '--session',
          'claude-code:hydra-s',
        ],
      })
      writeFileSync(
        transcript,
        `${JSON.stringify({
          type: 'assistant',
          timestamp: '2026-10-14T19:00:00Z',
          message: { content: 'Hydra queued the migration audit.' },
        })}\n`,
      )
      const spool = join(
        f.root,
        'hydras',
        'default',
        'spool',
      )
      mkdirSync(
        spool,
        { recursive: true },
      )
      writeFileSync(
        join(
          spool,
          '000000000000001-1-a.json',
        ),
        JSON.stringify({
          v: 1,
          id: 'hook-1-1',
          at: '2026-10-14T19:00:01Z',
          harness: 'claude',
          event: 'Stop',
          payload: {
            session_id: 'hydra-s',
            transcript_path: transcript,
            cwd: '/work/repo',
          },
        }),
      )
      f.push({
        key: 'probe',
        input: {},
      })
      const chat = f.events().filter(e => e.type === 'chat.message')
      assert.equal(
        chat.length,
        1,
      )
      assert.equal(
        chat[0]?.cardId,
        '$hydra',
      )
      rmSync(transcript)
      assert.match(
        f.run({
          args: [
            'history',
            '--kind',
            'chat.message',
            '--full',
          ],
        }),
        /migration audit/,
      )
    } finally {
      rmSync(
        f.root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'writes naming an unknown Hydra are refused instead of creating it',
  () => {
    const f = fixture({ hydraId: 'typo-hydra' })
    assert.throws(
      () => f.run({
        args: [
          'task',
          'create',
          '--title',
          'Lost',
        ],
      }),
      (error: { stdout: string }) => /unknown Hydra: typo-hydra/.test(error.stdout),
    )
    assert.throws(
      () => f.run({
        args: [
          'account',
          'set',
          'claude:lost',
          '--provider',
          'claude',
          '--folder',
          f.root,
        ],
      }),
      (error: { stdout: string }) => /unknown Hydra/.test(error.stdout),
    )
    assert.equal(
      existsSync(join(
        f.root,
        'hydras',
        'typo-hydra',
      )),
      false,
    )
    f.run({
      args: [
        'hydra',
        'create',
        'typo-hydra',
      ],
    })
    f.run({
      args: [
        'task',
        'create',
        '--title',
        'Found',
      ],
    })
    assert.equal(
      Object.values(f.state().cards).some(c => c.title === 'Found'),
      true,
    )
  },
)

test(
  'a column edit before creation keeps the Hydra unconfigured; a role column declares status and outcome undo restores it',
  () => {
    const f = fixture({ hydraId: 'work' })
    mkdirSync(
      join(
        f.root,
        'hydras',
        'work',
      ),
      { recursive: true },
    )
    writeFileSync(
      join(
        f.root,
        'hydras',
        'work',
        'events.jsonl',
      ),
      '',
    )

    try {
      f.run({
        args: [
          'column',
          'rename',
          'needs_you',
          '--title',
          'Your turn',
        ],
      })
      assert.equal(
        f.state().config?.id,
        'work',
      )
      assert.equal(
        f.state().configured,
        undefined,
      )
      f.run({
        args: [
          'hydra',
          'create',
          'work',
        ],
      })
      assert.equal(
        f.state().config?.columns.find(c => c.role === 'needs_you')?.title,
        'Your turn',
      )
      f.run({
        args: [
          'task',
          'create',
          '--title',
          'Ask',
          '--key',
          'ask',
          '--column',
          'needs_you',
        ],
      })
      const ask = f.state().keys.ask!
      assert.equal(
        f.state().cards[ask]?.column,
        f.state().config?.columns.find(c => c.role === 'needs_you')?.id,
      )
      assert.equal(
        f.state().cards[ask]?.status?.state,
        'needs_you',
      )
      f.run({
        args: [
          'task',
          'status',
          'ask',
          'working',
          '--note',
          'On it',
        ],
      })
      f.run({
        args: [
          'outcome',
          'ask',
          'done',
        ],
      })
      assert.equal(
        f.state().cards[ask]?.column,
        f.state().config?.columns.find(c => c.role === 'done')?.id,
      )
      f.run({
        args: [
          'undo',
          f.events().findLast(e => e.type === 'card.outcome')!.id,
        ],
      })
      assert.equal(
        f.state().cards[ask]?.status?.state,
        'working',
      )
      assert.equal(
        f.state().cards[ask]?.column,
        f.state().config?.columns.find(c => c.role === 'in_progress')?.id,
      )
      f.push({
        key: 'pushed',
        input: {
          title: 'Pushed',
          activity: 'waiting',
        },
      })
      f.run({
        args: [
          'link',
          'pushed',
          '--url',
          'https://github.com/example/app/pull/2',
          '--state',
          'open',
        ],
      })
      const pushed = f.state().cards[f.state().keys.pushed!]!
      assert.equal(
        pushed.tracking,
        'declared',
      )
      assert.ok(f.state().config?.columns.some(c => c.id === pushed.column))
    } finally {
      rmSync(
        f.root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'a session moved between tasks keeps each retained message once',
  () => {
    const f = fixture()

    try {
      f.run({
        args: [
          'hydra',
          'create',
          'default',
        ],
      })
      f.run({
        args: [
          'task',
          'create',
          '--title',
          'First home',
          '--key',
          'first',
        ],
      })
      f.run({
        args: [
          'task',
          'create',
          '--title',
          'Second home',
          '--key',
          'second',
        ],
      })
      const transcript = join(
        f.root,
        'mover.jsonl',
      )
      writeFileSync(
        transcript,
        `${JSON.stringify({
          type: 'assistant',
          timestamp: '2026-10-14T19:00:00Z',
          message: { content: 'The migration paused at the backfill step.' },
        })}\n`,
      )
      const lonely = join(
        f.root,
        'lonely.jsonl',
      )
      writeFileSync(
        lonely,
        `${JSON.stringify({
          type: 'assistant',
          timestamp: '2026-10-14T19:00:00Z',
          message: { content: 'An unattached backfill note.' },
        })}\n`,
      )
      f.push({
        key: 'lonely',
        input: {
          agent: {
            provider: 'claude-code',
            sessionId: 'lonely',
            transcriptPath: lonely,
          },
          terminal: {
            tty: '/dev/ttys127',
            pid: '127',
          },
        },
      })
      f.push({
        key: 'mover',
        input: {
          agent: {
            provider: 'claude-code',
            sessionId: 'mover',
            transcriptPath: transcript,
          },
          terminal: {
            tty: '/dev/ttys124',
            pid: '124',
          },
        },
      })

      const once = () => {
        const found = f.run({
          args: [
            'oracle',
            'backfill',
            '--kind',
            'transcript',
          ],
        })
        assert.equal(
          found.split('[backfill] step').length - 1,
          1,
          found,
        )
        assert.match(
          found,
          /unattached \[backfill\] note/,
        )
      }

      f.run({
        args: [
          'task',
          'attach',
          'first',
          '--session',
          'claude-code:mover',
        ],
      })
      once()
      f.run({
        args: [
          'task',
          'detach',
          'first',
        ],
      })
      f.run({
        args: [
          'task',
          'attach',
          'second',
          '--session',
          'claude-code:mover',
        ],
      })
      assert.equal(
        f.events().filter(e => e.type === 'chat.message').length,
        1,
      )
      rmSync(transcript)
      assert.equal(
        f.run({
          args: [
            'task',
            'chat',
            'second',
          ],
        }).split('backfill step').length - 1,
        1,
      )
      f.run({
        args: [
          'oracle',
          'rebuild',
        ],
      })
      once()
    } finally {
      rmSync(
        f.root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'detach harvests the transcript tail, column ids are strict and task outputs are compact',
  () => {
    const f = fixture()

    try {
      f.run({
        args: [
          'hydra',
          'create',
          'default',
        ],
      })
      assert.match(
        f.run({
          args: [
            'task',
            'list',
          ],
        }),
        /none: no tasks on this Hydra/,
      )
      assert.match(
        f.run({
          args: [
            'hydra',
            'messages',
          ],
        }),
        /none: no messages after seq 0/,
      )
      f.run({
        args: [
          'task',
          'create',
          '--title',
          'Ship it',
          '--key',
          'ship',
        ],
      })
      const transcript = join(
        f.root,
        'detach.jsonl',
      )
      writeFileSync(
        transcript,
        `${JSON.stringify({
          type: 'assistant',
          timestamp: '2026-10-14T19:00:00Z',
          message: {
            model: 'claude-opus-5-5',
            content: 'Starting.',
          },
        })}\n`,
      )
      f.push({
        key: 'detacher',
        input: {
          agent: {
            provider: 'claude-code',
            sessionId: 'detacher',
            transcriptPath: transcript,
          },
          terminal: {
            tty: '/dev/ttys125',
            pid: '125',
          },
        },
      })
      f.run({
        args: [
          'task',
          'attach',
          'ship',
          '--session',
          'claude-code:detacher',
        ],
      })
      appendFileSync(
        transcript,
        `${JSON.stringify({
          type: 'assistant',
          timestamp: '2026-10-14T19:01:00Z',
          message: {
            model: 'claude-sonnet-5-5',
            content: 'Switched model.',
          },
        })}\n`,
      )
      const ship = f.state().keys.ship!
      f.run({
        args: [
          'task',
          'detach',
          'ship',
        ],
      })
      assert.equal(
        f.state().cards[ship]?.sessionIds?.length,
        0,
      )
      const harvested = f.events().filter(e => e.actor === 'harvest' && e.cardId === ship)
      assert.ok(harvested.some(e => e.type === 'card.pushed' && e.seq > f.events().find(x => x.type === 'task.session' && x.data.after === ship)!.seq))
      assert.throws(() => f.run({
        args: [
          'move',
          'ship',
          'review',
        ],
      }))
      assert.throws(() => f.run({
        args: [
          'column',
          'create',
          '--title',
          'Mixed',
          '--id',
          'custom:Review2',
        ],
      }))
      f.run({
        args: [
          'task',
          'status',
          'ship',
          'working',
          '--note',
          'Rolling out',
        ],
      })
      const compact = f.run({
        args: [
          'task',
          'show',
          'ship',
        ],
      })
      assert.match(
        compact,
        /status: "?working: Rolling out"?/,
      )
      assert.doesNotMatch(
        compact,
        /statusLog/,
      )
      assert.match(
        f.run({
          args: [
            'task',
            'show',
            'ship',
            '--full',
          ],
        }),
        /statusLog/,
      )
      const history = f.run({
        args: [
          'task',
          'history',
          'ship',
        ],
      })
      assert.match(
        history,
        /claude-code:detacher/,
      )
      assert.doesNotMatch(
        history,
        /data:/,
      )
      assert.match(
        f.run({
          args: [
            'task',
            'history',
            'ship',
            '--full',
          ],
        }),
        /data/,
      )
    } finally {
      rmSync(
        f.root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'Hydra folders and the files holding copied chat stay private to the owner',
  () => {
    const f = fixture()

    try {
      const dir = join(
        f.root,
        'hydras',
        'default',
      )
      const mode = ({ path }: { path: string }) => statSync(path).mode & 0o777
      f.run({
        args: [
          'hydra',
          'create',
          'default',
        ],
      })
      assert.equal(
        mode({ path: dir }),
        0o700,
      )
      assert.equal(
        mode({
          path: join(
            dir,
            'events.jsonl',
          ),
        }),
        0o600,
      )
      assert.equal(
        mode({
          path: join(
            dir,
            'snapshot.json',
          ),
        }),
        0o600,
      )
      chmodSync(
        dir,
        0o755,
      )
      chmodSync(
        join(
          dir,
          'events.jsonl',
        ),
        0o644,
      )
      chmodSync(
        join(
          dir,
          'snapshot.json',
        ),
        0o644,
      )
      f.run({
        args: [
          'task',
          'create',
          '--title',
          'Private',
        ],
      })
      assert.equal(
        mode({ path: dir }),
        0o700,
      )
      assert.equal(
        mode({
          path: join(
            dir,
            'events.jsonl',
          ),
        }),
        0o600,
      )
      assert.equal(
        mode({
          path: join(
            dir,
            'snapshot.json',
          ),
        }),
        0o600,
      )
    } finally {
      rmSync(
        f.root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'search keeps one copy of each archived native line, long or repeated',
  () => {
    const f = fixture()

    try {
      f.run({
        args: [
          'hydra',
          'create',
          'default',
        ],
      })
      f.run({
        args: [
          'task',
          'create',
          '--title',
          'Long task',
          '--key',
          'long',
        ],
      })
      const transcript = join(
        f.root,
        'long.jsonl',
      )
      const line = ({ text }: { text: string }) => `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-14T19:00:00Z',
        message: { content: text },
      })}\n`
      writeFileSync(
        transcript,
        line({ text: `${'Padding words about the rollout. '.repeat(40)}The zebrafinch flag closed the loop.` }) + line({ text: 'Please verify the koala gate.' }),
      )
      f.push({
        key: 'long-session',
        input: {
          agent: {
            provider: 'claude-code',
            sessionId: 'long',
            transcriptPath: transcript,
          },
          terminal: {
            tty: '/dev/ttys128',
            pid: '128',
          },
        },
      })
      const hits = ({ word }: { word: string }) => Number(/results\[(\d+)\]/.exec(f.run({
        args: [
          'oracle',
          word,
          '--kind',
          'transcript',
        ],
      }))?.[1] ?? 0)
      f.run({
        args: [
          'oracle',
          'rebuild',
        ],
      })
      f.run({
        args: [
          'task',
          'attach',
          'long',
          '--session',
          'claude-code:long',
        ],
      })
      assert.ok(f.events().filter(e => e.type === 'chat.message').length > 2)
      assert.equal(
        hits({ word: 'zebrafinch' }),
        1,
      )
      assert.equal(
        hits({ word: 'koala' }),
        1,
      )
      f.run({
        args: [
          'task',
          'detach',
          'long',
        ],
      })
      appendFileSync(
        transcript,
        line({ text: 'Please verify the koala gate.' }),
      )
      assert.equal(
        hits({ word: 'koala' }),
        2,
      )
      rmSync(transcript)
      f.run({
        args: [
          'oracle',
          'rebuild',
        ],
      })
      assert.equal(
        hits({ word: 'zebrafinch' }),
        1,
      )
      assert.equal(
        hits({ word: 'koala' }),
        1,
      )
    } finally {
      rmSync(
        f.root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

test(
  'saving view preferences keeps cards in Hydra columns',
  () => {
    const f = fixture()

    try {
      f.run({
        args: [
          'column',
          'create',
          '--id',
          'custom:research',
          '--title',
          'Research',
        ],
      })
      f.run({
        args: [
          'task',
          'create',
          '--key',
          'research',
          '--title',
          'Check context',
          '--column',
          'custom:research',
        ],
      })
      const id = f.state().keys.research!
      const before = f.state().cards[id]!
      f.run({
        args: [
          'view',
          'set',
          '--json',
          JSON.stringify({
            fontSize: 16,
            theme: 'light',
            columnWidths: { 'custom:research': 400 },
          }),
        ],
      })
      f.run({
        args: [
          'view',
          'set',
          '--json',
          JSON.stringify({ customColumns: [] }),
        ],
      })
      assert.equal(
        f.state().view?.columnWidths['custom:research'],
        400,
      )
      assert.equal(
        f.state().cards[id]!.column,
        'custom:research',
      )
      assert.equal(
        f.state().cards[id]!.revision,
        before.revision,
      )
    } finally {
      rmSync(
        f.root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)
