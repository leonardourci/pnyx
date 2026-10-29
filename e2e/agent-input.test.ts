import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localToken } from '#app/server-state.ts'
import { withWriter } from '#app/writer.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { recordCompaction } from '#workers/compaction/record.ts'
import { openPage, until } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

const IMAGE_BYTES = Buffer.from('synthetic image bytes')

async function upload({ hydraId }: { hydraId: string }): Promise<{
  path: string
  line: string
}> {
  const response = await fetch(
    `http://127.0.0.1:${pnyx.port()}/hydra/${hydraId}/attachments`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${localToken()}`,
        'content-type': 'image/png',
      },
      body: IMAGE_BYTES,
    },
  )
  assert.equal(
    response.status,
    200,
  )

  return response.json()
}

test(
  'an uploaded image reaches the Claude native prompt through the real Hydra CLI and server',
  async () => {
    const s = await pnyx.scenario()
    const image = await upload({ hydraId: s.hydraId })
    const agent = await s.chat({ text: `Describe ${image.line}` })
    assert.deepEqual(
      agent.images,
      [
        [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: IMAGE_BYTES.toString('base64'),
            },
          },
        ],
      ],
    )
  },
)

test(
  'an uploaded image reaches Codex as an explicit local image through the real Hydra CLI and server',
  async t => {
    const s = await pnyx.scenario()
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    t.after(() => page.close())
    await page.command({
      name: 'hydra-agent',
      args: [JSON.stringify({ harness: 'codex' })],
    })
    const image = await upload({ hydraId: s.hydraId })
    const agent = await s.chat({ text: `Describe ${image.line}` })
    assert.deepEqual(
      agent.images,
      [
        [
          {
            type: 'localImage',
            path: image.path,
          },
        ],
      ],
    )
  },
)

test(
  'a saved compaction input keeps its original image selection through server recovery',
  async () => {
    const s = await pnyx.scenario()
    await s.chat({ text: 'Ready for images' })
    await until({
      what: 'Hydra to finish',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    const image = await upload({ hydraId: s.hydraId })
    const contextImage = await upload({ hydraId: s.hydraId })
    const original = `Describe this held image ${image.line}`
    withWriter({
      hydraId: s.hydraId,
      fn: ({ writer }) => recordCompaction({
        writer,
        card: HYDRA_CARD,
        at: new Date().toISOString(),
        change: {
          kind: 'held',
          input: {
            id: 'held-image',
            text: `${contextImage.line}\n${original}`,
            original,
            route: 'hydra',
            actor: 'cli',
            accepted: true,
            at: new Date().toISOString(),
          },
        },
      }),
    })
    await pnyx.restart()
    const resumed = await until({
      what: 'the held image to reach the resumed native session',
      check: () => pnyx.claude.sessions.findLast(agent => agent.env.PNYX_HYDRA === s.hydraId && agent.resumed && agent.received.some(text => text.includes('Describe this held image'))),
    })
    assert.deepEqual(
      resumed.images?.[0],
      [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: IMAGE_BYTES.toString('base64'),
          },
        },
      ],
    )
  },
)
