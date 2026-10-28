import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, normalize, extname } from 'node:path'
import { MAX_BODY, WEB_ROOT, MIME } from './server-transport.ts'
import { HydraError } from '#store/errors.ts'
import { hydraIdentity } from './server-state.ts'

export function readBytes({
  req,
  limit,
}: {
  req: IncomingMessage
  limit: number
}): Promise<Buffer> {
  return new Promise((
    resolve,
    reject,
  ) => {
    const chunks: Buffer[] = []
    let size = 0
    // Past the limit the rest is read and dropped, so the client still gets the answer.
    req.on(
      'data',
      (chunk: Buffer) => {
        size += chunk.length

        if (size > limit) {
          chunks.length = 0
          reject(new Error(`images up to ${limit / 1024 / 1024} MB`))
        } else {
          chunks.push(chunk)
        }
      },
    )
    req.on(
      'end',
      () => resolve(Buffer.concat(chunks)),
    )
    req.on(
      'error',
      reject,
    )
  })
}

export function readBody({ req }: { req: IncomingMessage }): Promise<unknown> {
  return new Promise((
    resolve,
    reject,
  ) => {
    let text = ''
    req.setEncoding('utf8')
    req.on(
      'data',
      (chunk: string) => {
        text += chunk

        if (text.length > MAX_BODY) {
          reject(new HydraError({
            message: 'request too large',
            code: 'VALIDATION_ERROR',
          }))
          req.destroy()
        }
      },
    )
    req.on(
      'end',
      () => {
        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new HydraError({
            message: 'request must be JSON',
            code: 'VALIDATION_ERROR',
          }))
        }
      },
    )
    req.on(
      'error',
      reject,
    )
  })
}

export type ClientMessage = {
  type?: unknown
  id?: unknown
  name?: unknown
  args?: unknown
  scope?: unknown
  subscription?: unknown
  after?: unknown
}

export function parseMessage({ text }: { text: string }): ClientMessage | undefined {
  try {
    const message = JSON.parse(text) as unknown

    return typeof message === 'object' && message !== null ? (message as ClientMessage) : undefined
  } catch {
    return undefined
  }
}

// Names the built web app: index.html links the content-hashed assets, so its
// hash changes with every rebuild. Empty when nothing is built (the Vite dev server).
const buildOf = ({ html }: { html: string }) => createHash('sha256').update(html)
  .digest('hex')
  .slice(
    0,
    12,
  )

export function buildId(): string {
  try {
    return buildOf({
      html: readFileSync(
        join(
          WEB_ROOT,
          'index.html',
        ),
        'utf8',
      ),
    })
  } catch {
    return ''
  }
}

export function reply({
  res,
  status,
  body,
}: {
  res: ServerResponse
  status: number
  body: unknown
}): void {
  res.writeHead(
    status,
    { 'content-type': 'application/json' },
  ).end(JSON.stringify(body))
}

// Only a Hydra's page carries the token; its base points the page at its own Hydra's WebSocket.
export function serveStatic({
  res,
  path,
  home,
  page,
}: {
  res: ServerResponse
  path: string
  home: string
  page?: {
    token: string
    identity: string
    base: string
  }
}): void {
  const index = join(
    WEB_ROOT,
    'index.html',
  )
  const file = normalize(join(
    WEB_ROOT,
    path === '/' ? 'index.html' : path,
  ))
  const servable = file.startsWith(`${WEB_ROOT}/`) && (page !== undefined || file !== index)

  if (servable) {
    try {
      if (file === index && page) {
        const raw = readFileSync(
          index,
          'utf8',
        )
        const html = raw.replace(
          '</head>',
          `<base href="${page.base}" />\n<meta name="pnyx-token" content="${page.token}" />\n<meta name="pnyx-build" content="${buildOf({ html: raw })}" />\n<meta name="pnyx-hydra" content="${page.identity}" />\n<meta name="pnyx-installation" content="${hydraIdentity({ hydraId: '' })}" />\n</head>`,
        )
        res.writeHead(
          200,
          {
            'content-type': MIME['.html'],
            'cache-control': 'no-store',
          },
        ).end(html)

        return
      }

      const body = readFileSync(file)
      res.writeHead(
        200,
        { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' },
      ).end(body)

      return
    } catch {
      // Not a readable file; answered below.
    }
  }

  // A page served at a nested path would resolve its WebSocket there and never connect.
  if (path !== '/' && !extname(path)) {
    return void res.writeHead(
      302,
      { location: home },
    ).end()
  }

  reply({
    res,
    status: 404,
    body: {
      error: 'not found; run `pnpm run build` for the web Hydra',
      code: 'NOT_FOUND',
    },
  })
}
