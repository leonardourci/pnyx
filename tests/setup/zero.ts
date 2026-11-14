// A Zero client sending the page's cookie, keeping every frame so a test can show what never reached the page.
import { Zero, type ResultType } from '@rocicorp/zero'
import { WebSocket as NodeSocket } from 'ws'
import { schema } from '#store/zero-schema.ts'
import { until } from './pnyx.ts'

// zero-cache's first start copies the home's tables into its replica before it answers.
const READY_MS = 60_000
const ANSWER_MS = 20_000

interface View {
  // eslint-disable-next-line pnyx/object-params -- Zero owns the view listener's signature.
  addListener(listener: (
    data: unknown,
    resultType: ResultType,
  ) => void): unknown
  destroy(): void
}

const text = ({ data }: { data: Buffer | ArrayBuffer | Buffer[] }) => Array.isArray(data)
  ? Buffer.concat(data).toString('utf8')
  : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString('utf8')

export async function readRows<Rows>({
  url,
  cookie,
  query,
}: {
  url: string
  cookie?: string
  query({ zero }: { zero: Zero }): View
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
        (data: Buffer | ArrayBuffer | Buffer[]) => frames.push(text({ data })),
      )
      // A client zero-cache refuses sees its socket close; the read then answers with no rows.
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

  try {
    const view = query({ zero })
    const answer = await new Promise<{
      rows: Rows
      resultType: ResultType
    }>(resolve => {
      // A client zero-cache refuses never gets an answer.
      const capped = setTimeout(
        () => resolve({
          rows: [] as Rows,
          resultType: 'unknown',
        }),
        ANSWER_MS,
      )
      view.addListener((
        rows,
        resultType,
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
    }
  } finally {
    await zero.close()
    globalThis.WebSocket = browserSocket
  }
}

// Waits until zero-cache answers behind /zero for this cookie.
export const zeroReady = ({
  url,
  cookie,
}: {
  url: string
  cookie: string
}) => until({
  what: 'zero-cache to answer behind /zero',
  timeoutMs: READY_MS,
  check: async () => (await fetch(
    url,
    { headers: { cookie } },
  )).status === 200,
})
