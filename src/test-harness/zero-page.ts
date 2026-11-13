import { Zero, type ResultType } from '@rocicorp/zero'
import { WebSocket as NodeSocket } from 'ws'
import { schema } from '#store/zero-schema.ts'

// How long a client waits for a query's first answer; zero-cache answers a page's in well under a second.
const ANSWER_MS = 20_000

const decoded = ({ data }: { data: Buffer | ArrayBuffer | Buffer[] }) => {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8')
  }

  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data

  return Buffer.from(bytes).toString('utf8')
}

// zero-cache's first start copies the home's tables into its replica before it reports ready.
const READY_MS = 60_000
const POLL_MS = 100

// What the test reads of a materialized Zero view, whose listener signature Zero owns.
interface View {
  // eslint-disable-next-line pnyx/object-params -- Zero owns the view listener's signature.
  addListener(listener: (
    data: unknown,
    resultType: ResultType,
  ) => void): unknown
  destroy(): void
}

// The page's read: a Zero client whose WebSocket carries the cookie as a browser's would, with every frame it received.
export async function readRows<Rows>({
  url,
  cookie,
  query,
  keepOpen = false,
}: {
  url: string
  cookie?: string
  query({ zero }: { zero: Zero }): View
  // Leaves the client connected, as an open page is, and returns how to close it.
  keepOpen?: boolean
}) {
  const browserSocket = globalThis.WebSocket
  const frames: string[] = []
  globalThis.WebSocket = class extends NodeSocket {
    // eslint-disable-next-line pnyx/object-params -- the WebSocket constructor owns this signature.
    constructor(
      address: string,
      protocols?: string | string[],
    ) {
      super(
        address,
        protocols,
        cookie ? { headers: { cookie } } : {},
      )
      this.on(
        'message',
        // Zero sends row data in binary messages, so each one is decoded before it is searched.
        (data: Buffer | ArrayBuffer | Buffer[]) => frames.push(decoded({ data })),
      )
      // A page left open sees its socket drop and its reconnects refused while the server stops.
      this.on(
        'error',
        () => undefined,
      )
    }
  } as unknown as typeof WebSocket
  const zero = new Zero({
    cacheURL: url,
    schema,
    userID: 'owner',
    kvStore: 'mem',
  })

  const close = async () => {
    await zero.close()
    globalThis.WebSocket = browserSocket
  }

  try {
    const view = query({ zero })
    const answer = await new Promise<{
      rows: Rows
      resultType: ResultType
    }>(resolve => {
      // A port that is not zero-cache's sync port never answers a client; nothing reached it by then.
      const capped = setTimeout(
        () => resolve({
          rows: [] as Rows,
          resultType: 'unknown',
        }),
        ANSWER_MS,
      )
      view.addListener((
        rows,
        resultType: ResultType,
      ) => {
        if (resultType !== 'unknown') {
          clearTimeout(capped)
          resolve({
            rows: rows as Rows,
            resultType,
          })
        }
      })
    })
    view.destroy()

    return {
      ...answer,
      frames,
      close,
    }
  } finally {
    if (!keepOpen) {
      await close()
    }
  }
}

// Waits until zero-cache answers behind /zero for this cookie.
export async function zeroReady({
  url,
  cookie,
}: {
  url: string
  cookie: string
}): Promise<Response> {
  for (const end = performance.now() + READY_MS; performance.now() < end;) {
    const answer = await fetch(
      url,
      { headers: { cookie } },
    )

    if (answer.status === 200) {
      return answer
    }

    await new Promise(resolve => setTimeout(
      resolve,
      POLL_MS,
    ))
  }

  throw new Error('timed out waiting for zero-cache behind /zero')
}
