import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readAction, recordCalls } from '../src/thread/calls.ts'
import { latestMessage, recordEntries } from '../src/thread/read.ts'

const claudeCall = ({
  id,
  name,
  input,
  at = '2026-10-22T10:00:00.000Z',
}: {
  id: string
  name: string
  input: Record<string, unknown>
  at?: string
}) => ({
  type: 'assistant',
  timestamp: at,
  message: {
    content: [
      {
        type: 'tool_use',
        id,
        name,
        input,
      },
    ],
  },
})

const claudeResult = ({ id }: { id: string }) => ({
  type: 'user',
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        content: 'done',
      },
    ],
  },
})

// Codex's code mode: one exec call runs a short script of tool calls.
const codexScript = ({
  id,
  script,
}: {
  id: string
  script: string
}) => ({
  type: 'response_item',
  timestamp: '2026-10-22T10:00:00.000Z',
  payload: {
    type: 'custom_tool_call',
    status: 'completed',
    call_id: id,
    name: 'exec',
    input: script,
  },
})

const lines = ({ records }: { records: unknown[] }) => records.map(record => JSON.stringify(record))

test(
  'A Claude call keeps its command and the agent\'s own description',
  () => {
    assert.deepEqual(
      recordCalls({
        record: claudeCall({
          id: 'toolu_1',
          name: 'Bash',
          input: {
            command: 'git status',
            description: 'Show working tree status\nsecond line',
          },
        }),
      }),
      {
        calls: [
          {
            id: 'toolu_1',
            tool: 'Bash',
            command: 'git status',
            description: 'Show working tree status',
          },
        ],
        results: [],
        at: '2026-10-22T10:00:00.000Z',
      },
    )
    assert.deepEqual(
      recordCalls({
        record: claudeCall({
          id: 'toolu_2',
          name: 'Read',
          input: { file_path: '/repo/web/src/app.tsx' },
        }),
      }).calls,
      [
        {
          id: 'toolu_2',
          tool: 'Read',
          file: '/repo/web/src/app.tsx',
        },
      ],
    )
  },
)

test(
  'Codex\'s code-mode script gives one call per tool it runs, with its command or file',
  () => {
    const script = [
      'const results = await Promise.allSettled([',
      'tools.exec_command({cmd:"gh pr view 4728","max_output_tokens":1000}),',
      'tools.exec_command({"cmd":"rg -n \\"postLine\\" src","workdir":"/repo"}),',
      '])',
      'await tools.apply_patch(`*** Begin Patch\n*** Update File: web/src/app.tsx\n@@\n-a\n+b\n*** End Patch`)',
      'await tools.view_image({path:"/tmp/shot.png"})',
    ].join('\n')

    assert.deepEqual(
      recordCalls({
        record: codexScript({
          id: 'call_1',
          script,
        }),
      }).calls,
      [
        {
          id: 'call_1',
          tool: 'exec_command',
          command: 'gh pr view 4728',
        },
        {
          id: 'call_1',
          tool: 'exec_command',
          command: 'rg -n "postLine" src',
        },
        {
          id: 'call_1',
          tool: 'apply_patch',
          file: 'web/src/app.tsx',
        },
        {
          id: 'call_1',
          tool: 'view_image',
          file: '/tmp/shot.png',
        },
      ],
    )
  },
)

test(
  'Codex function calls read their JSON arguments, and every agent\'s results name their call',
  () => {
    const call = ({ args }: { args: unknown }) => recordCalls({
      record: {
        type: 'response_item',
        payload: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_2',
          name: 'shell',
          arguments: JSON.stringify(args),
        },
      },
    }).calls[0]?.command

    assert.equal(
      call({ args: { cmd: 'pnpm test' } }),
      'pnpm test',
    )
    assert.equal(
      call({
        args: {
          command: [
            'bash',
            '-lc',
            'pnpm lint',
          ],
        },
      }),
      'pnpm lint',
    )
    assert.deepEqual(
      [
        claudeResult({ id: 'toolu_1' }),
        {
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call_2',
            output: 'ok',
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'call_1',
            output: 'ok',
          },
        },
      ].map(record => recordCalls({ record }).results),
      [
        ['toolu_1'],
        ['call_2'],
        ['call_1'],
      ],
    )
  },
)

test(
  'A call\'s command is scrubbed of secrets, and a subagent\'s own calls stay out',
  () => {
    assert.equal(
      recordCalls({
        record: claudeCall({
          id: 'toolu_3',
          name: 'Bash',
          input: { command: 'curl -H "Authorization: Bearer sk-abcdefghijklmnop123456789" https://example.com' },
        }),
      }).calls[0]?.command?.includes('sk-abcdefghijklmnop123456789'),
      false,
    )
    assert.deepEqual(
      recordCalls({
        record: {
          ...claudeCall({
            id: 'toolu_4',
            name: 'Bash',
            input: { command: 'ls' },
          }),
          isSidechain: true,
        },
      }).calls,
      [],
    )
  },
)

test(
  'The latest run of calls made together is the action, done once every result is back',
  () => {
    const parallel = [
      claudeCall({
        id: 'a',
        name: 'Read',
        input: { file_path: 'a.ts' },
      }),
      claudeCall({
        id: 'b',
        name: 'Read',
        input: { file_path: 'b.ts' },
      }),
    ]
    const open = readAction({ lines: lines({ records: parallel }) }).action

    assert.deepEqual(
      open?.calls.map(call => call.id),
      [
        'a',
        'b',
      ],
    )
    assert.equal(
      open?.done,
      false,
    )
    assert.equal(
      readAction({
        lines: lines({
          records: [
            ...parallel,
            claudeResult({ id: 'a' }),
            claudeResult({ id: 'b' }),
            {
              type: 'assistant',
              message: {
                content: [
                  {
                    type: 'text',
                    text: 'Both read.',
                  },
                ],
              },
            },
          ],
        }),
      }).action?.done,
      true,
    )
    // An earlier call answered before the latest one does not join it.
    assert.deepEqual(
      readAction({
        lines: lines({
          records: [
            claudeCall({
              id: 'old',
              name: 'Bash',
              input: { command: 'ls' },
            }),
            claudeResult({ id: 'old' }),
            claudeCall({
              id: 'new',
              name: 'Bash',
              input: { command: 'pnpm test' },
            }),
          ],
        }),
      }).action?.calls.map(call => call.id),
      ['new'],
    )
  },
)

test(
  'Reading a growing transcript keeps the action, marks it done when its result lands, and moves to the next call',
  () => {
    const path = join(
      mkdtempSync(join(
        tmpdir(),
        'pnyx-calls-',
      )),
      'session.jsonl',
    )
    const append = ({ records }: { records: unknown[] }) => appendFileSync(
      path,
      `${lines({ records }).join('\n')}\n`,
    )
    writeFileSync(
      path,
      '',
    )
    append({
      records: [
        codexScript({
          id: 'call_1',
          script: 'text(await tools.exec_command({cmd:"pnpm test"}))',
        }),
      ],
    })
    const first = latestMessage({ path })

    assert.equal(
      first.action?.calls[0]?.command,
      'pnpm test',
    )
    assert.equal(
      first.action?.done,
      false,
    )
    append({
      records: [
        {
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'call_1',
            output: 'ok',
          },
        },
      ],
    })
    const second = latestMessage({
      path,
      prev: first,
    })

    assert.equal(
      second.action?.done,
      true,
    )
    assert.equal(
      second.action?.calls[0]?.command,
      'pnpm test',
    )
    append({
      records: [
        codexScript({
          id: 'call_2',
          script: 'text(await tools.exec_command({cmd:"git push"}))',
        }),
      ],
    })

    assert.deepEqual(
      latestMessage({
        path,
        prev: second,
      }).action,
      {
        calls: [
          {
            id: 'call_2',
            tool: 'exec_command',
            command: 'git push',
          },
        ],
        at: '2026-10-22T10:00:00.000Z',
        done: false,
      },
    )
  },
)

test(
  'Codex\'s code-mode calls and their output show in the thread like other tool calls',
  () => {
    const entries = recordEntries({
      record: codexScript({
        id: 'call_1',
        script: 'text(await tools.exec_command({cmd:"git status"}))',
      }),
      offset: 0,
    })

    assert.deepEqual(
      entries.map(entry => [
        entry.kind,
        entry.role,
        entry.call,
      ]),
      [
        [
          'tool',
          'exec',
          'call_1',
        ],
      ],
    )
    assert.equal(
      recordEntries({
        record: {
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'call_1',
            output: 'clean',
          },
        },
        offset: 1,
      })[0]?.call,
      'call_1',
    )
  },
)

test(
  'When only one of two calls made together is answered, the action is still running',
  () => {
    assert.equal(
      readAction({
        lines: lines({
          records: [
            claudeCall({
              id: 'a',
              name: 'Bash',
              input: { command: 'pnpm test' },
            }),
            claudeCall({
              id: 'b',
              name: 'Bash',
              input: { command: 'pnpm lint' },
            }),
            claudeResult({ id: 'a' }),
          ],
        }),
      }).action?.done,
      false,
    )
  },
)

test(
  'Calls and results split across reads of a growing transcript still make one action, done once both answered',
  () => {
    const path = join(
      mkdtempSync(join(
        tmpdir(),
        'pnyx-calls-split-',
      )),
      'session.jsonl',
    )
    const append = ({ records }: { records: unknown[] }) => appendFileSync(
      path,
      `${lines({ records }).join('\n')}\n`,
    )
    writeFileSync(
      path,
      '',
    )
    append({
      records: [
        claudeCall({
          id: 'a',
          name: 'Read',
          input: { file_path: 'a.ts' },
        }),
      ],
    })
    let read = latestMessage({ path })
    append({
      records: [
        claudeCall({
          id: 'b',
          name: 'Read',
          input: { file_path: 'b.ts' },
        }),
      ],
    })
    read = latestMessage({
      path,
      prev: read,
    })

    assert.deepEqual(
      read.action?.calls.map(call => call.id),
      [
        'a',
        'b',
      ],
    )

    for (const id of [
      'a',
      'b',
    ]) {
      assert.equal(
        read.action?.done,
        false,
      )
      append({ records: [claudeResult({ id })] })
      read = latestMessage({
        path,
        prev: read,
      })
    }

    assert.equal(
      read.action?.done,
      true,
    )
  },
)

test(
  'A Codex custom tool outside a script names the file its patch touches',
  () => {
    assert.deepEqual(
      recordCalls({
        record: {
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            call_id: 'call_9',
            name: 'apply_patch',
            input: '*** Begin Patch\n*** Add File: src/x.ts\n+export {}\n*** End Patch',
          },
        },
      }).calls,
      [
        {
          id: 'call_9',
          tool: 'apply_patch',
          file: 'src/x.ts',
        },
      ],
    )
  },
)

test(
  'An action keeps at most its last eight calls, and long commands and descriptions are cut',
  () => {
    const calls = Array.from(
      { length: 10 },
      (
        _,
        index,
      ) => claudeCall({
        id: `c${index}`,
        name: 'Read',
        input: { file_path: `${index}.ts` },
      }),
    )

    assert.deepEqual(
      readAction({ lines: lines({ records: calls }) }).action?.calls.map(call => call.id),
      [
        'c2',
        'c3',
        'c4',
        'c5',
        'c6',
        'c7',
        'c8',
        'c9',
      ],
    )

    const [call] = recordCalls({
      record: claudeCall({
        id: 'long',
        name: 'Bash',
        input: {
          command: 'x'.repeat(1000),
          description: 'y'.repeat(1000),
        },
      }),
    }).calls

    assert.equal(
      call?.command?.length,
      400,
    )
    assert.equal(
      call?.description?.length,
      120,
    )
  },
)

test(
  'Broken or partial records give no calls instead of failing the read',
  () => {
    assert.deepEqual(
      recordCalls({
        record: {
          ...claudeCall({
            id: 'meta',
            name: 'Bash',
            input: { command: 'ls' },
          }),
          isMeta: true,
        },
      }).calls,
      [],
    )
    assert.deepEqual(
      recordCalls({
        record: {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Bash',
                input: { command: 'ls' },
              },
            ],
          },
        },
      }).calls,
      [],
    )
    assert.deepEqual(
      recordCalls({
        record: {
          type: 'response_item',
          payload: {
            type: 'function_call',
            call_id: 'call_bad',
            name: 'shell',
            arguments: '{not json',
          },
        },
      }).calls,
      [
        {
          id: 'call_bad',
          tool: 'shell',
        },
      ],
    )
    assert.deepEqual(
      readAction({
        lines: [
          '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","na',
          ...lines({
            records: [
              claudeCall({
                id: 't2',
                name: 'Bash',
                input: { command: 'pnpm test' },
              }),
            ],
          }),
        ],
      }).action?.calls.map(call => call.id),
      ['t2'],
    )
    assert.deepEqual(
      recordEntries({
        record: codexScript({
          id: 'call_1',
          script: 'text(await tools.exec_command({cmd:"git status"}))',
        }),
        offset: 0,
        tools: false,
      }),
      [],
    )
  },
)
