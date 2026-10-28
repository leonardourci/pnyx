// Inline answers to an agent's own question, permission or plan prompt: which
// requests the Hydra can answer and the keys each harness's prompt expects.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { answerPrompt, answerText, checkAnswer, type Answer, type Prompt } from '../src/core/answer.ts'
import type { Card } from '../src/tasks/model.ts'
import type { Attention } from '../src/workers/model.ts'
import { KEY, answerKeys } from '../src/integrations/hooks/answer.ts'
import { attend, observe, type HookEnvelope } from '../src/integrations/hooks/observe.ts'

const ROOT = join(
  import.meta.dirname,
  '..',
)
const TTY = '/dev/ttys042'

const fixture = ({ name }: { name: string }) => JSON.parse(readFileSync(
  join(
    ROOT,
    'src',
    'integrations',
    'hooks',
    'fixtures',
    `${name}.json`,
  ),
  'utf8',
))

const opened = ({
  harness,
  event,
  name,
}: {
  harness: 'claude' | 'codex'
  event: string
  name: string
}): Attention => {
  const envelope: HookEnvelope = {
    v: 1,
    id: 'hook-1',
    at: '2026-10-14T17:00:00Z',
    harness,
    event,
    payload: fixture({ name }),
  }

  return attend({
    current: [],
    change: observe({ envelope }).at(-1)!.attend!,
  })[0]!
}

const card = ({
  provider,
  attention,
}: {
  provider: string
  attention: Attention[]
}): Card => ({
  id: 'c1',
  key: 'k',
  title: 'k',
  workspace: 'unassigned',
  tags: [],
  attention,
  links: [],
  sourceRefs: [],
  column: 'needs_you',
  revision: 1,
  createdSeq: 1,
  updatedSeq: 1,
  updatedAt: '2026-10-14T00:00:00Z',
  agent: {
    provider,
    sessionId: 's',
  },
  terminal: {
    tty: TTY,
    pid: '4242',
    program: 'tmux',
    tmux: '/tmp/tmux-1/default',
    tmuxPane: '%3',
  },
})

const multi = opened({
  harness: 'claude',
  event: 'PermissionRequest',
  name: 'claude-permission-request-ask-multi',
})
const single = opened({
  harness: 'claude',
  event: 'PreToolUse',
  name: 'claude-pre-tool-ask',
})
const permission = opened({
  harness: 'claude',
  event: 'PermissionRequest',
  name: 'claude-permission-request',
})
const plan = opened({
  harness: 'claude',
  event: 'PermissionRequest',
  name: 'claude-permission-request-plan',
})
const codex = opened({
  harness: 'codex',
  event: 'PermissionRequest',
  name: 'codex-permission-request',
})
const elicitation = opened({
  harness: 'claude',
  event: 'Elicitation',
  name: 'claude-elicitation-form',
})

const prompt = ({
  provider,
  request,
}: {
  provider: string
  request: Attention
}): Prompt =>
  answerPrompt({
    card: card({
      provider,
      attention: [request],
    }),
    request,
  })!

type Asked = {
  provider: string
  request: Attention
  value: unknown
}

const checked = ({
  provider,
  request,
  value,
}: Asked): Answer => {
  const result = checkAnswer({
    prompt: prompt({
      provider,
      request,
    }),
    request,
    value,
  })
  assert.ok(
    'answer' in result,
    JSON.stringify(result),
  )

  return result.answer
}

const keys = ({
  provider,
  request,
  value,
}: Asked) =>
  answerKeys({
    provider,
    request,
    answer: checked({
      provider,
      request,
      value,
    }),
  })
    .map(step => step.keys)

test(
  'a Claude Code AskUserQuestion request keeps every question with its options',
  () => {
    assert.deepEqual(
      multi.questions,
      [
        {
          question: 'Pick a color',
          header: 'Color',
          options: [
            {
              label: 'Red',
              description: 'Red',
            },
            {
              label: 'Blue',
              description: 'Blue',
            },
            {
              label: 'Green',
              description: 'Green',
            },
          ],
        },
        {
          question: 'Pick sizes',
          header: 'Size',
          options: [
            {
              label: 'Small',
              description: 'Small',
            },
            {
              label: 'Medium',
              description: 'Medium',
            },
            {
              label: 'Large',
              description: 'Large',
            },
          ],
          multiSelect: true,
        },
      ],
    )
    const broken = {
      ...fixture({ name: 'claude-pre-tool-ask' }),
      tool_input: {
        questions: [
          {
            question: 'Which?',
            options: [],
          },
        ],
      },
    }
    const envelope: HookEnvelope = {
      v: 1,
      id: 'hook-2',
      at: '2026-10-14T17:00:00Z',
      harness: 'claude',
      event: 'PreToolUse',
      payload: broken,
    }
    const request = attend({
      current: [],
      change: observe({ envelope })[0]!.attend!,
    })[0]!
    assert.equal(
      request.text,
      'Which?',
    )
    assert.equal(
      request.questions,
      undefined,
    )
    assert.equal(
      answerPrompt({
        card: card({
          provider: 'claude-code',
          attention: [request],
        }),
        request,
      }),
      undefined,
    )
  },
)

test(
  'answers are checked against the prompt before anything is typed',
  () => {
    const error = ({
      request,
      value,
    }: {
      request: Attention
      value: unknown
    }) => {
      const result = checkAnswer({
        prompt: prompt({
          provider: 'claude-code',
          request,
        }),
        request,
        value,
      })

      return 'error' in result ? result.error : undefined
    }

    assert.match(
      error({
        request: multi,
        value: { answers: [{ pick: [1] }] },
      })!,
      /one answer for each of the 2 questions/,
    )
    assert.match(
      error({
        request: multi,
        value: {
          answers: [
            {
              pick: [
                1,
                2,
              ],
            },
            { pick: [1] },
          ],
        },
      })!,
      /takes one option/,
    )
    assert.match(
      error({
        request: multi,
        value: {
          answers: [
            { pick: [4] },
            { pick: [1] },
          ],
        },
      })!,
      /from 1 to 3/,
    )
    assert.match(
      error({
        request: multi,
        value: {
          answers: [
            { pick: [1] },
            {
              pick: [
                2,
                2,
              ],
            },
          ],
        },
      })!,
      /each once/,
    )
    assert.match(
      error({
        request: multi,
        value: {
          answers: [
            { pick: [1] },
            { text: 'Huge' },
          ],
        },
      })!,
      /takes several options/,
    )
    assert.match(
      error({
        request: permission,
        value: { choice: 'approve' },
      })!,
      /one of allow, deny/,
    )
    assert.match(
      error({
        request: permission,
        value: {
          choice: 'allow',
          text: 'and more',
        },
      })!,
      /takes no text/,
    )
    assert.match(
      error({
        request: plan,
        value: { choice: 'revise' },
      })!,
      /needs text/,
    )
    assert.deepEqual(
      checked({
        provider: 'claude-code',
        request: multi,
        value: {
          answers: [
            { text: '  Teal\nplease ' },
            {
              pick: [
                3,
                1,
              ],
            },
          ],
        },
      }).answers,
      [
        { text: 'Teal please' },
        {
          pick: [
            1,
            3,
          ],
        },
      ],
    )
  },
)

test(
  'each harness gets the keys its own prompt expects',
  () => {
    const claude = ({
      request,
      value,
    }: {
      request: Attention
      value: unknown
    }) => keys({
      provider: 'claude-code',
      request,
      value,
    })
    // A number picks a single-choice option and moves on; a multiple-choice question
    // toggles numbers and moves on with Right; several questions end on the review's Submit.
    assert.deepEqual(
      claude({
        request: multi,
        value: {
          answers: [
            { pick: [2] },
            {
              pick: [
                1,
                3,
              ],
            },
          ],
        },
      }),
      [
        '2',
        '1',
        '3',
        KEY.right,
        '1',
      ],
    )
    assert.deepEqual(
      claude({
        request: single,
        value: { answers: [{ pick: [2] }] },
      }),
      ['2'],
    )
    assert.deepEqual(
      claude({
        request: single,
        value: { answers: [{ text: 'Purple' }] },
      }),
      [
        '3',
        'Purple',
        KEY.enter,
      ],
    )
    assert.deepEqual(
      claude({
        request: permission,
        value: { choice: 'allow' },
      }),
      ['1'],
    )
    assert.deepEqual(
      claude({
        request: permission,
        value: { choice: 'deny' },
      }),
      [KEY.escape],
    )
    assert.deepEqual(
      claude({
        request: permission,
        value: {
          choice: 'deny',
          text: 'not that',
        },
      }),
      [
        KEY.up,
        KEY.tab,
        'not that',
        KEY.enter,
      ],
    )
    assert.deepEqual(
      claude({
        request: plan,
        value: { choice: 'approve' },
      }),
      ['2'],
    )
    assert.deepEqual(
      claude({
        request: plan,
        value: {
          choice: 'revise',
          text: 'smaller',
        },
      }),
      [
        '3',
        'smaller',
        KEY.enter,
      ],
    )
    assert.deepEqual(
      keys({
        provider: 'codex',
        request: codex,
        value: { choice: 'allow' },
      }),
      ['y'],
    )
    assert.deepEqual(
      keys({
        provider: 'codex',
        request: codex,
        value: { choice: 'deny' },
      }),
      [KEY.escape],
    )
    assert.deepEqual(
      keys({
        provider: 'codex',
        request: codex,
        value: {
          choice: 'deny',
          text: 'skip it',
        },
      }),
      [
        KEY.escape,
        'skip it',
        KEY.enter,
      ],
    )
    const settles = ({ text }: { text: string }) => answerKeys({
      provider: 'codex',
      request: codex,
      answer: {
        choice: 'deny',
        text,
      },
    })
      .map(step => step.settleMs)
    assert.deepEqual(
      settles({ text: '/review' }),
      [
        1200,
        1500,
        400,
      ],
      'a leading / waits out the completion popup',
    )
    assert.deepEqual(
      settles({ text: 'skip it' }),
      [
        1200,
        400,
        400,
      ],
    )
  },
)

test(
  'an MCP form keeps its fields, is checked, and is filled with the keys its prompt expects',
  () => {
    assert.deepEqual(
      elicitation.form,
      [
        {
          name: 'name',
          title: 'Name',
          type: 'string',
          required: true,
        },
        {
          name: 'color',
          title: 'Color',
          type: 'string',
          options: [
            'red',
            'blue',
          ],
        },
        {
          name: 'ok',
          title: 'Agree',
          type: 'boolean',
        },
      ],
    )
    assert.deepEqual(
      prompt({
        provider: 'claude-code',
        request: elicitation,
      }),
      { kind: 'form' },
    )
    const url = {
      ...fixture({ name: 'claude-elicitation-form' }),
      mode: 'url',
      url: 'https://example.com/auth',
    }
    const envelope: HookEnvelope = {
      v: 1,
      id: 'hook-3',
      at: '2026-10-14T17:00:00Z',
      harness: 'claude',
      event: 'Elicitation',
      payload: url,
    }
    assert.equal(
      attend({
        current: [],
        change: observe({ envelope })[0]!.attend!,
      })[0]!.form,
      undefined,
      'a URL elicitation is answered in the session',
    )

    const error = ({ value }: { value: unknown }) => {
      const result = checkAnswer({
        prompt: { kind: 'form' },
        request: elicitation,
        value,
      })

      return 'error' in result ? result.error : undefined
    }

    assert.match(
      error({
        value: {
          choice: 'accept',
          values: {},
        },
      })!,
      /Name is required/,
    )
    assert.match(
      error({
        value: {
          choice: 'accept',
          values: {
            name: 'Ada',
            color: 'green',
          },
        },
      })!,
      /one of red, blue/,
    )
    assert.match(
      error({
        value: {
          choice: 'accept',
          values: {
            name: 'Ada',
            ok: 'yes',
          },
        },
      })!,
      /true or false/,
    )
    assert.match(
      error({
        value: {
          choice: 'accept',
          values: {
            name: 'Ada',
            age: 3,
          },
        },
      })!,
      /no field age/,
    )
    assert.match(
      error({ value: { choice: 'allow' } })!,
      /takes \{"choice":"accept"/,
    )

    const form = ({ value }: { value: unknown }) => keys({
      provider: 'claude-code',
      request: elicitation,
      value,
    })
    assert.deepEqual(
      form({
        value: {
          choice: 'accept',
          values: {
            name: 'Grace Hopper',
            color: 'blue',
            ok: true,
          },
        },
      }),
      [
        'Grace Hopper',
        KEY.down,
        KEY.right,
        KEY.down,
        KEY.space,
        KEY.down,
        KEY.space,
        KEY.down,
        KEY.enter,
      ],
    )
    assert.deepEqual(
      form({
        value: {
          choice: 'accept',
          values: {
            name: 'Ada',
            ok: false,
          },
        },
      }),
      [
        'Ada',
        KEY.down,
        KEY.down,
        KEY.down,
        KEY.enter,
      ],
    )
    assert.deepEqual(
      form({ value: { choice: 'decline' } }),
      [
        KEY.down,
        KEY.down,
        KEY.down,
        KEY.right,
        KEY.enter,
      ],
    )
    const answer = checked({
      provider: 'claude-code',
      request: elicitation,
      value: {
        choice: 'accept',
        values: {
          name: 'Ada',
          ok: true,
        },
      },
    })
    assert.equal(
      answerText({
        prompt: { kind: 'form' },
        request: elicitation,
        answer,
      }),
      'Accept\nName: Ada\nAgree: yes',
    )
  },
)

test(
  'a form field the Hydra cannot fill as the terminal would leaves the whole form to the terminal',
  () => {
    const base = fixture({ name: 'claude-elicitation-form' })

    const formWith = ({ property }: { property: Record<string, unknown> }) => {
      const payload = {
        ...base,
        requested_schema: {
          type: 'object',
          properties: { pick: property },
        },
      }
      const envelope: HookEnvelope = {
        v: 1,
        id: 'hook-4',
        at: '2026-10-14T17:00:00Z',
        harness: 'claude',
        event: 'Elicitation',
        payload,
      }

      return attend({
        current: [],
        change: observe({ envelope })[0]!.attend!,
      })[0]!.form
    }

    assert.deepEqual(
      formWith({
        property: {
          type: 'string',
          title: 'Pick',
          enum: [
            'a',
            'b',
          ],
        },
      }),
      [
        {
          name: 'pick',
          title: 'Pick',
          type: 'string',
          options: [
            'a',
            'b',
          ],
        },
      ],
    )
    assert.equal(
      formWith({
        property: {
          type: 'string',
          default: 'a',
        },
      }),
      undefined,
      'a default prefills the field',
    )
    assert.equal(
      formWith({
        property: {
          type: 'string',
          oneOf: [
            {
              const: 'a',
              title: 'A',
            },
          ],
        },
      }),
      undefined,
    )
    assert.equal(
      formWith({
        property: {
          type: 'integer',
          minimum: 1,
        },
      }),
      undefined,
    )
    assert.equal(
      formWith({
        property: {
          type: 'string',
          enum: 'abcdefghi'.split(''),
        },
      }),
      undefined,
      'a long choice list',
    )
  },
)

test(
  'an answered request no longer holds back a new one',
  () => {
    const answered = {
      ...permission,
      answered: 'r1',
    }
    const note = {
      kind: 'permission',
      key: 'hook:notification',
      blocking: true,
      text: 'Claude needs your permission',
    }
    const change = {
      add: note,
      ifNone: true,
    }
    assert.deepEqual(
      attend({
        current: [answered],
        change,
      }),
      [
        note,
        answered,
      ],
    )
    assert.deepEqual(
      attend({
        current: [permission],
        change,
      }),
      [permission],
    )
  },
)
