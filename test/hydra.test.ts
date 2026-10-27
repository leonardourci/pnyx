import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { HydraState, HydraEvent } from '../src/core/model.ts'
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
