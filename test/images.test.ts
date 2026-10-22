import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { attachedImages, imageLine } from '../src/attachments/images.ts'
import { claudeProvider, type QueryFn } from '../src/server/claude.ts'

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

test(
  'Claude receives an attached image as a base64 block after the text',
  async () => {
    process.env.PNYX_HOME = mkdtempSync(join(
      tmpdir(),
      'pnyx-images-',
    ))
    const folder = join(
      process.env.PNYX_HOME,
      'hydras',
      'lab',
      'attachments',
    )
    mkdirSync(
      folder,
      { recursive: true },
    )
    writeFileSync(
      join(
        folder,
        NAME,
      ),
      Buffer.from(
        '89504e47',
        'hex',
      ),
    )
    const text = `What broke?\n\n${imageLine({
      path: join(
        folder,
        NAME,
      ),
    })}\n\n${imageLine({
      path: join(
        folder,
        NAME.replace(
          '1.png',
          '2.png',
        ),
      ),
    })}`
    const sent: unknown[] = []
    type Prompt = AsyncIterable<{ message: { content: unknown } }>
    const query = (({ prompt }: { prompt: Prompt }) => (async function* () {
      for await (const message of prompt) {
        sent.push(message.message.content)
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
        }
      }
    })()) as unknown as QueryFn
    const signal = new AbortController().signal
    const open = {
      cwd: folder,
      settings: {},
      env: {},
      signal,
    }
    const session = await claudeProvider({ query }).open(open)
    const turns = session.run({
      input: (async function* () {
        yield text
        yield 'No image here'
      })(),
      permission: async () => ({ behavior: 'allow' }),
    })

    const events = []

    for await (const event of turns) {
      events.push(event)
    }

    assert.ok(events.includes('finished'))

    assert.deepEqual(
      sent,
      [
        [
          {
            type: 'text',
            text,
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
        'No image here',
      ],
    )
  },
)
