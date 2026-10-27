import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { attachedImages, imageLine } from '../src/attachments/images.ts'
import { claudeProvider, type QueryFn } from '../src/server/claude.ts'
import { codexProvider } from '../src/server/codex.ts'
import { fakeCodex } from './codex-fixture.ts'

const NAME = '0199f00d-1111-7000-8000-000000000001.png'

test(
  'only images stored in a Hydra attachments folder are attached, wherever the owner placed them, once each',
  () => {
    const hydras = '/home/pnyx/hydras'
    const stored = `${hydras}/lab/attachments/${NAME}`
    const inline = `${hydras}/lab/attachments/${NAME.replace(
      '1.png',
      '2.png',
    )}`
    const text = [
      'Look at these',
      imageLine({ path: stored }),
      imageLine({ path: `${hydras}/../lab/attachments/${NAME}` }),
      imageLine({ path: `${hydras}/lab/copies/${NAME}` }),
      imageLine({ path: `${hydras}/lab/attachments/notes.png` }),
      imageLine({ path: '/etc/passwd' }),
      `In ${imageLine({ path: inline })}, the first one ${imageLine({ path: stored })} again`,
    ].join('\n\n')
    assert.deepEqual(
      attachedImages({
        text,
        hydras,
      }),
      [
        stored,
        inline,
      ],
    )
  },
)

const contextAndMessage = () => {
  const home = mkdtempSync(join(
    tmpdir(),
    'pnyx-images-',
  ))
  process.env.PNYX_HOME = home
  const folder = join(
    home,
    'hydras',
    'lab',
    'attachments',
  )
  mkdirSync(
    folder,
    { recursive: true },
  )
  const said = join(
    folder,
    NAME,
  )
  const named = join(
    folder,
    NAME.replace(
      '1.png',
      '3.png',
    ),
  )
  writeFileSync(
    said,
    Buffer.from(
      '89504e47',
      'hex',
    ),
  )
  writeFileSync(
    named,
    Buffer.from(
      '89504e4700',
      'hex',
    ),
  )

  return {
    home,
    said,
    named,
    context: () => `<pnyx-digest>Open task: Fix ${imageLine({ path: named })}</pnyx-digest>`,
    message: `Look at ${imageLine({ path: said })} please`,
  }
}

test(
  'hosted Claude Code receives the message’s images, never one named only in the context before it',
  async () => {
    const {
      home,
      context,
      message,
    } = contextAndMessage()
    const sent: unknown[] = []
    type Prompt = AsyncIterable<{ message: { content: unknown } }>
    const query = (({ prompt }: { prompt: Prompt }) => (async function* () {
      for await (const turn of prompt) {
        sent.push(turn.message.content)
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
        }
      }
    })()) as unknown as QueryFn
    const session = await claudeProvider({ query }).open({
      cwd: home,
      settings: {},
      env: {},
      signal: new AbortController().signal,
      context,
    })

    for await (const event of session.run({
      input: (async function* () {
        yield message
      })(),
      permission: async () => ({ behavior: 'allow' }),
    })) {
      if (event === 'finished') {
        break
      }
    }

    assert.deepEqual(
      sent,
      [
        [
          {
            type: 'text',
            text: `${context()}\n\n${message}`,
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'iVBORw==',
            },
          },
        ],
      ],
    )
  },
)

test(
  'hosted Codex receives the message’s images, never one named only in the context before it',
  async () => {
    const {
      home,
      said,
      context,
      message,
    } = contextAndMessage()
    const fixture = fakeCodex({ root: home })
    const session = await codexProvider({ spawnCodex: fixture.spawnCodex }).open({
      cwd: home,
      env: {},
      settings: {},
      signal: new AbortController().signal,
      context,
    })

    try {
      for await (const event of session.run({
        input: (async function* () {
          yield message
        })(),
        permission: async () => ({
          behavior: 'deny',
          message: 'unused',
        }),
      })) {
        if (event === 'finished') {
          break
        }
      }

      assert.deepEqual(
        fixture.messages().find(entry => entry.method === 'turn/start')?.params?.input,
        [
          {
            type: 'text',
            text: `${context()}\n\n${message}`,
            text_elements: [],
          },
          {
            type: 'localImage',
            path: said,
          },
        ],
      )
    } finally {
      session.close()
    }
  },
)
