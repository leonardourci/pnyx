import { randomUUID, timingSafeEqual } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hydraImageFile } from '#hydra/image-files.ts'
import { IMAGE_TYPES, MAX_IMAGE_BYTES, imageExtension, imageLine } from '#hydra/images.ts'
import { listFolders } from '#projects/folders.ts'
import { privateDir } from '#store/storage.ts'
import { waitingReminders } from '#tasks/reminders.ts'
import type { HydraState } from './model.ts'
import { buildId, readBytes, reply, serveStatic } from './server-http.ts'
import type { HydraRequest } from './server-transport.ts'

// The HTTP routes of one mounted Hydra: image uploads and reads, folders, reminders, health and its page.
export function createServerRoutes({
  hydraId,
  dir,
  url,
  token,
  identity,
  state,
}: {
  hydraId: string
  dir: string
  url: string
  token: Buffer
  identity: string
  state(): HydraState
}) {
  const authorized = ({ given }: { given: string | null }) => {
    const bytes = Buffer.from(given ?? '')

    return token.length > 0 && bytes.length === token.length && timingSafeEqual(
      bytes,
      token,
    )
  }

  // The server has already checked Host and Origin.
  const request = ({
    req,
    res,
    path,
    search,
  }: HydraRequest) => {
    // The CLI asks here to start or message an agent this server runs. A page cannot
    // send this header cross-origin without a preflight, which this server never answers.
    // An image dropped or pasted into a composer; the message then carries its path.
    if (req.method === 'POST' && path === '/attachments') {
      if (!authorized({
        given: req.headers.authorization?.replace(
          /^Bearer /,
          '',
        ) ?? null,
      })) {
        return reply({
          res,
          status: 401,
          body: {
            error: 'missing or wrong token',
            code: 'UNAUTHORIZED',
          },
        })
      }

      const extension = imageExtension({ type: req.headers['content-type'] ?? '' })

      if (!extension) {
        return reply({
          res,
          status: 415,
          body: {
            error: `images only: ${Object.values(IMAGE_TYPES).join(', ')}`,
            code: 'VALIDATION_ERROR',
          },
        })
      }

      return readBytes({
        req,
        limit: MAX_IMAGE_BYTES,
      }).then(
        bytes => {
          const folder = join(
              dir,
              'attachments',
            ), file = join(
              folder,
              `${randomUUID()}${extension}`,
            )

          try {
            privateDir({ dir: folder })
            writeFileSync(
              file,
              bytes,
              { mode: 0o600 },
            )
          } catch (error) {
            return reply({
              res,
              status: 500,
              body: {
                error: `could not store the image: ${(error as Error).message}`,
                code: 'UNKNOWN',
              },
            })
          }

          reply({
            res,
            status: 200,
            body: {
              path: file,
              line: imageLine({ path: file }),
            },
          })
        },
        (error: Error) => reply({
          res,
          status: 413,
          body: {
            error: error.message,
            code: 'VALIDATION_ERROR',
          },
        }),
      )
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return reply({
        res,
        status: 405,
        body: {
          error: 'method not allowed',
          code: 'METHOD_NOT_ALLOWED',
        },
      })
    }

    const image = /^\/((?:attachments|copies)\/.+)$/.exec(path)?.[1]

    // An <img> cannot send a header, so the page passes its token in the query, as for the WebSocket.
    if (image !== undefined) {
      if (!authorized({
        given: new URL(
          req.url ?? '/',
          'http://localhost',
        ).searchParams.get('token'),
      })) {
        return reply({
          res,
          status: 401,
          body: {
            error: 'missing or wrong token',
            code: 'UNAUTHORIZED',
          },
        })
      }

      const served = hydraImageFile({
        dir,
        route: image,
      })

      if (!served) {
        return reply({
          res,
          status: 404,
          body: {
            error: 'image not found',
            code: 'NOT_FOUND',
          },
        })
      }

      return void res.writeHead(
        200,
        {
          'content-type': served.type,
          'x-content-type-options': 'nosniff',
          // A task copy's bytes come from its repository, so they never run as a page.
          'content-security-policy': "default-src 'none'; sandbox",
          // A stored attachment never changes; an image in a task copy can.
          'cache-control': served.stored ? 'private, max-age=31536000, immutable' : 'private, no-cache',
        },
      )
        .end(served.body)
    }

    if (path === '/folders') {
      const query = new URL(
        req.url ?? '/',
        'http://localhost',
      ).searchParams

      return listFolders({
        path: query.get('path') ?? '',
        repository: query.get('repository') ?? '',
      }).then(
        body => reply({
          res,
          status: 200,
          body,
        }),
        (error: Error) => reply({
          res,
          status: 400,
          body: {
            error: error.message,
            code: 'FOLDER_UNAVAILABLE',
          },
        }),
      )
    }

    if (path === '/reminders') {
      const reminders = waitingReminders({ state: state() })

      return reply({
        res,
        status: 200,
        body: {
          count: reminders.length,
          reminders,
        },
      })
    }

    if (path === '/health') {
      return reply({
        res,
        status: 200,
        body: {
          hydraId,
          pid: process.pid,
          build: buildId(),
        },
      })
    }

    const page = {
      token: token.toString(),
      identity,
      base: new URL(url).pathname,
    }
    serveStatic({
      res,
      path,
      home: `${page.base}${search}`,
      page,
    })
  }

  return request
}
