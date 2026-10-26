import { sendReply } from '../src/cli/reply.ts'
import { startTask } from '../src/cli/start.ts'
import { dispatchCommands } from '../src/dispatch/cli.ts'
import { startServer } from '../src/server/server.ts'
import { fakeCodex } from './codex-fixture.ts'
import { fakeDispatch } from './dispatch-fixture.ts'
import { hydraSdk } from './hydra-host-fixture.ts'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { commands } from '../src/cli/commands.ts'
import { emptyHydra, replay } from '../src/core/reducer.ts'
import { hydraConfig, hydraEvent } from '../src/core/hydra.ts'
import { loadHydra, readEvents, withWriter } from '../src/store/hydra-store.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileBlock } from '../src/attachments/files.ts'
import { reference } from '../src/mentions/mentions.ts'
import { readSkillReference, resolveSkillReferences, skillReference } from '../src/thread/skill-reference.ts'
import { draftView, CHIP_SPACE, WORD_JOINER, ICON_SPACE, removeChip, replaceDisplay } from '../web/src/hydra/draft.ts'

const project = {
  command: '$deploy',
  description: 'Deploy the app',
  source: 'Project · Sample',
  file: '/demo/Sample/.agents/skills/deploy/SKILL.md',
  project: 'Sample',
  projectPath: '/demo/Sample',
}

test(
  'skill selections remain inline, keep full names and remove as one chip',
  () => {
    const name = 'review-cross-platform-accessibility-and-release-readiness'
    const token = skillReference({
      item: {
        ...project,
        command: `$${name}`,
      },
    })
    const text = `Please run ${token} then report.`
    const view = draftView({ text })
    assert.equal(
      view.display.replaceAll(
        WORD_JOINER,
        '',
      ),
      `Please run ${CHIP_SPACE}${ICON_SPACE}\u00A0Sample\u00A0/${name}\u00A0${ICON_SPACE}${CHIP_SPACE} then report.`,
    )
    assert.equal(
      view.chips.length,
      1,
    )
    assert.equal(
      view.chips[0]?.kind,
      'skill',
    )
    assert.equal(
      removeChip({
        text,
        chip: view.chips[0]!,
      }).text,
      'Please run then report.',
    )
    const inserted = replaceDisplay({
      text: 'Please run /depTAIL',
      from: 11,
      to: 15,
      insert: `${token} `,
    })
    assert.equal(
      draftView({ text: inserted.text }).display.replaceAll(
        WORD_JOINER,
        '',
      ),
      `Please run ${CHIP_SPACE}${ICON_SPACE}\u00A0Sample\u00A0/${name}\u00A0${ICON_SPACE}${CHIP_SPACE} TAIL`,
    )
  },
)

test(
  'native skill syntax follows the receiving harness at send time',
  () => {
    const token = skillReference({
      item: {
        command: '$review',
        description: 'Review',
        source: 'Global',
      },
    })
    assert.equal(
      resolveSkillReferences({
        text: token,
        provider: 'claude-code',
      }),
      '/review',
    )
    assert.equal(
      resolveSkillReferences({
        text: token,
        provider: 'codex',
      }),
      '$review',
    )
    const command = skillReference({
      item: {
        command: '/prompts:draft',
        kind: 'command',
        description: 'Draft',
        source: 'Prompts',
      },
    })
    assert.equal(
      resolveSkillReferences({
        text: command,
        provider: 'codex',
      }),
      '/prompts:draft',
    )
  },
)

test(
  'same-named attached-project skills resolve to their own file without installation',
  () => {
    const one = skillReference({ item: project })
    const two = skillReference({
      item: {
        ...project,
        project: 'Docs',
        projectPath: '/demo/Docs',
        file: '/demo/Docs/.claude/skills/deploy/SKILL.md',
      },
    })
    const result = resolveSkillReferences({
      text: `${one} and ${two}`,
      provider: 'codex',
    })
    assert.match(
      result,
      /Read and follow the skill "deploy" at "\/demo\/Sample\/\.agents\/skills\/deploy\/SKILL.md"/,
    )
    assert.match(
      result,
      /"\/demo\/Docs\/\.claude\/skills\/deploy\/SKILL.md"/,
    )
    assert.equal(
      result.includes('pnyx-skill:'),
      false,
    )
    assert.equal(
      resolveSkillReferences({
        text: one,
        provider: 'claude',
      }),
      resolveSkillReferences({
        text: one,
        provider: 'codex',
      }),
    )
  },
)

test(
  'invalid tokens and skill references inside attached file contents stay literal',
  () => {
    const invalid = reference({
      kind: 'skill',
      value: JSON.stringify({
        name: 'deploy',
        file: '../SKILL.md',
      }),
      label: '/deploy',
    })
    assert.equal(
      readSkillReference({ value: '{bad' }),
      undefined,
    )
    assert.equal(
      resolveSkillReferences({
        text: invalid,
        provider: 'codex',
      }),
      invalid,
    )
    const attachment = fileBlock({
      name: 'sample.md',
      text: skillReference({ item: project }),
    })
    assert.equal(
      resolveSkillReferences({
        text: attachment,
        provider: 'codex',
      }),
      attachment,
    )
  },
)

test(
  'Hydra delivery resolves the same saved badge for the currently selected harness',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-skill-send-',
    ))
    process.env.PNYX_HOME = root
    process.env.PNYX_SEMANTIC = 'off'
    t.after(() => rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    ))
    await commands.hydra([
      'create',
      'default',
    ])
    const select = ({ harness }: { harness: 'claude' | 'codex' }) => withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        const config = hydraConfig({ state: writer.state })
        const decision = hydraEvent({
          state: writer.state,
          cardId: '$board',
          meta: {
            actor: 'test',
            at: new Date().toISOString(),
          },
          change: {
            type: 'board.configured',
            data: {
              ...config,
              hydra: {
                ...config.hydra,
                agent: { harness },
              },
            },
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    const token = skillReference({
      item: {
        command: '$review',
        description: 'Review',
        source: 'Global',
      },
    })
    select({ harness: 'codex' })
    await commands.hydra([
      'send',
      '--text',
      token,
    ])
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.hydraMessages?.at(-1)?.text,
      '$review',
    )
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.hydraMessages?.at(-1)?.enteredText,
      token,
    )
    select({ harness: 'claude' })
    await commands.hydra([
      'send',
      '--text',
      token,
    ])
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.hydraMessages?.at(-1)?.text,
      '/review',
    )
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.hydraMessages?.at(-1)?.enteredText,
      token,
    )
    await commands.hydra([
      'send',
      '--text',
      skillReference({ item: project }),
    ])
    assert.match(
      loadHydra({ hydraId: 'default' }).state.hydraMessages?.at(-1)?.text ?? '',
      /Read and follow.*Sample.*SKILL.md/,
    )
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.hydraMessages?.at(-1)?.enteredText,
      skillReference({ item: project }),
    )
    await commands.hydra([
      'send',
      '--text',
      'Keep the release safe.',
    ])
    const messages = loadHydra({ hydraId: 'default' }).state.hydraMessages
    assert.equal(
      messages?.at(-1)?.text,
      'Keep the release safe.',
    )
    assert.equal(
      Object.hasOwn(
        messages!.at(-1)!,
        'enteredText',
      ),
      false,
    )
    assert.deepEqual(
      replay({
        state: emptyHydra(),
        events: readEvents({ hydraId: 'default' }),
      }).hydraMessages,
      messages,
    )
  },
)

for (const harness of [
  'claude',
  'codex',
] as const) {
  test(
    `task replies deliver native and exact project skill references to ${harness}`,
    async t => {
      const root = mkdtempSync(join(
        tmpdir(),
        'pnyx-task-skills-',
      ))
      process.env.PNYX_HOME = join(
        root,
        'pnyx',
      )
      process.env.PNYX_SEMANTIC = 'off'
      process.env.CLAUDE_CONFIG_DIR = join(
        root,
        'claude',
      )
      process.env.CODEX_HOME = join(
        root,
        'codex',
      )
      fakeDispatch({ root })
      await commands.hydra([
        'create',
        'lab',
        '--hydra',
        'lab',
      ])
      await commands.task([
        'create',
        '--title',
        'Review',
        '--key',
        'review',
        '--folder',
        root,
        '--hydra',
        'lab',
      ])
      await commands.task([
        'brief',
        'review',
        '--brief',
        'Start the review.',
        '--hydra',
        'lab',
      ])
      await dispatchCommands.rule([
        'set',
        'default',
        '--harness',
        harness,
        '--model',
        '',
        '--hydra',
        'lab',
      ])
      const sdk = hydraSdk()
      const codex = fakeCodex({ root })
      const server = await startServer({
        hydraId: 'lab',
        port: 0,
        homes: [],
        query: sdk.query,
        spawnCodex: codex.spawnCodex,
      })
      t.after(async () => {
        await server.close()

        for (const child of codex.children) {
          child.kill()
        }

        rmSync(
          root,
          {
            recursive: true,
            force: true,
          },
        )
      })

      const task = () => {
        const state = loadHydra({ hydraId: 'lab' }).state

        return state.cards[state.keys.review!]!
      }

      const until = async ({ check }: { check(): boolean }) => {
        const deadline = Date.now() + 5000

        while (!check()) {
          assert.ok(
            Date.now() < deadline,
            'task did not receive its skill reply',
          )
          await new Promise(resolve => setTimeout(
            resolve,
            10,
          ))
        }
      }

      await startTask({
        hydraId: 'lab',
        task: 'review',
        meta: {
          actor: 'test',
          at: new Date().toISOString(),
          id: 'start-review',
        },
      })
      await until({ check: () => task().sessionActivity === 'finished' })
      const native = skillReference({
        item: {
          command: '$review',
          description: 'Review',
          source: 'Global',
        },
      })
      const projectToken = skillReference({ item: project })
      const expected = `${harness === 'codex' ? '$review' : '/review'} then Read and follow the skill "deploy" at "/demo/Sample/.agents/skills/deploy/SKILL.md".`
      assert.equal(
        (await sendReply({
          hydraId: 'lab',
          request: {
            card: 'review',
            text: `${native} then ${projectToken}`,
            homes: [],
            actor: 'test',
          },
        })).state,
        'delivered',
      )
      const received = () => harness === 'claude'
        ? sdk.calls.flatMap(call => call.messages)
        : readFileSync(
          codex.transcript,
          'utf8',
        ).trim()
          .split('\n')
          .map(line => JSON.parse(line) as {
            type: string
            payload?: {
              role?: string
              content?: { text?: string }[]
            }
          })
          .filter(entry => entry.type === 'response_item' && entry.payload?.role === 'user')
          .flatMap(entry => {
            const content = entry.payload?.content ?? []

            return content.flatMap(item => item.text ? [item.text] : [])
          })
      await until({ check: () => received().length >= 2 })
      assert.equal(
        received().at(-1),
        expected,
      )
      assert.equal(
        received().at(-1)
          ?.includes('pnyx-skill:'),
        false,
      )
    },
  )
}

test(
  'Hydra skill delivery uses the default Codex dispatch before an explicit harness is selected',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-default-skill-',
    ))
    process.env.PNYX_HOME = join(
      root,
      'pnyx',
    )
    process.env.PNYX_SEMANTIC = 'off'
    fakeDispatch({ root })
    t.after(() => rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    ))
    await commands.hydra([
      'create',
      'lab',
      '--hydra',
      'lab',
    ])
    await dispatchCommands.rule([
      'set',
      'default',
      '--harness',
      'codex',
      '--model',
      '',
      '--hydra',
      'lab',
    ])
    assert.equal(
      hydraConfig({ state: loadHydra({ hydraId: 'lab' }).state }).hydra.agent?.harness,
      undefined,
    )
    await commands.hydra([
      'send',
      '--hydra',
      'lab',
      '--text',
      skillReference({
        item: {
          command: '/review',
          source: 'Global',
          description: 'Review',
        },
      }),
    ])
    assert.equal(
      loadHydra({ hydraId: 'lab' }).state.hydraMessages?.at(-1)?.text,
      '$review',
    )
  },
)
