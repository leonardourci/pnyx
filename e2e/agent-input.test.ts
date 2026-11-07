import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { basename } from 'node:path'
import { test } from 'node:test'
import { localToken } from '#app/server-state.ts'
import { withWriter } from '#app/writer.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { MAX_IMAGE_BYTES } from '#hydra/images.ts'
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
  'an uploaded image reaches both native providers and keeps its selection through recovery',
  async t => {
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
    await until({
      what: 'Hydra to finish',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
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
    await until({
      what: 'the recovered Hydra turn to finish before changing providers',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    t.after(() => page.close())
    await page.command({
      name: 'hydra-agent',
      args: [JSON.stringify({ harness: 'codex' })],
    })
    const text = `Describe this image with Codex ${image.line}`
    await s.owner({
      args: [
        'hydra',
        'send',
        '--text',
        text,
      ],
    })
    const change = await until({
      what: 'the image message to wait for provider compaction',
      check: () => s.state().hydraAgentChange,
    })
    await page.command({
      name: 'hydra-agent-change',
      args: [
        change.id,
        'compact',
      ],
    })
    const codex = await until({
      what: 'the selected Codex provider to receive the image',
      check: () => pnyx.codex.sessions.findLast(agent => agent.env.PNYX_HYDRA === s.hydraId
        && agent.received.some(message => message.includes(text))),
    })
    assert.deepEqual(
      codex.images,
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
  'the attachment and folder routes refuse what they cannot take and serve a stored image with its own headers',
  async () => {
    const s = await pnyx.scenario()
    const base = `http://127.0.0.1:${pnyx.port()}/hydra/${s.hydraId}`
    const post = ({
      token,
      type,
      body,
    }: {
      token: string
      type: string
      body: typeof IMAGE_BYTES
    }) => fetch(
      `${base}/attachments`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': type,
        },
        body,
      },
    )
    const answer = async ({ response }: { response: Response }) => [
      response.status,
      await response.json(),
    ]
    const image = await upload({ hydraId: s.hydraId })
    const stored = await fetch(`${base}/attachments/${basename(image.path)}?token=${localToken()}`)
    assert.deepEqual(
      [
        stored.status,
        stored.headers.get('content-type'),
        stored.headers.get('x-content-type-options'),
        Buffer.from(await stored.arrayBuffer()),
      ],
      [
        200,
        'image/png',
        'nosniff',
        IMAGE_BYTES,
      ],
    )

    const folder = s.folder({ name: 'empty-folder' })
    const listed = await fetch(`${base}/folders?path=${encodeURIComponent(folder)}`)
    assert.deepEqual(
      [
        listed.status,
        (await listed.json() as { selected: unknown }).selected,
      ],
      [
        200,
        {
          name: 'empty-folder',
          path: realpathSync(folder),
          empty: true,
        },
      ],
    )

    assert.deepEqual(
      [
        await answer({
          response: await post({
            token: 'wrong',
            type: 'image/png',
            body: IMAGE_BYTES,
          }),
        }),
        await answer({
          response: await post({
            token: localToken(),
            type: 'text/plain',
            body: IMAGE_BYTES,
          }),
        }),
        await answer({
          response: await post({
            token: localToken(),
            type: 'image/png',
            body: Buffer.alloc(MAX_IMAGE_BYTES + 1),
          }),
        }),
        await answer({
          response: await fetch(
            `${base}/health`,
            { method: 'PUT' },
          ),
        }),
        await answer({ response: await fetch(`${base}/attachments/${basename(image.path)}`) }),
        await answer({ response: await fetch(`${base}/attachments/00000000-0000-0000-0000-000000000000.png?token=${localToken()}`) }),
        await answer({ response: await fetch(`${base}/folders?path=relative/folder`) }),
      ],
      [
        [
          401,
          {
            error: 'missing or wrong token',
            code: 'UNAUTHORIZED',
          },
        ],
        [
          415,
          {
            error: 'images only: image/png, image/jpeg, image/jpeg, image/gif, image/webp',
            code: 'VALIDATION_ERROR',
          },
        ],
        [
          413,
          {
            error: 'images up to 3.75 MB',
            code: 'VALIDATION_ERROR',
          },
        ],
        [
          405,
          {
            error: 'method not allowed',
            code: 'METHOD_NOT_ALLOWED',
          },
        ],
        [
          401,
          {
            error: 'missing or wrong token',
            code: 'UNAUTHORIZED',
          },
        ],
        [
          404,
          {
            error: 'image not found',
            code: 'NOT_FOUND',
          },
        ],
        [
          400,
          {
            error: 'Enter an absolute laptop folder path, or start with ~/',
            code: 'FOLDER_UNAVAILABLE',
          },
        ],
      ],
    )
  },
)
