import { randomUUID } from 'node:crypto'

const HOME_HISTORY_LIMIT = 50_000
const HOME_HISTORY_BYTES = 4 << 20

export interface SocketCursor {
  epoch: string
  seq: number
}

export interface SocketFrame<Value> extends SocketCursor {
  value: Value
}

export function createSocketHistory<Value>({
  limit = HOME_HISTORY_LIMIT,
  byteLimit = HOME_HISTORY_BYTES,
  measure = ({ frame }) => Buffer.byteLength(JSON.stringify(frame)),
  epoch = randomUUID(),
}: {
  limit?: number
  byteLimit?: number
  measure?({ frame }: { frame: SocketFrame<Value> }): number
  epoch?: string
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1
    || !Number.isSafeInteger(byteLimit) || byteLimit < 1) {
    throw new RangeError('socket history needs a positive capacity')
  }

  const frames: ({
    frame: SocketFrame<Value>
    bytes: number
  } | undefined)[] = new Array(limit)
  let first = 0
  let size = 0
  let seq = 0
  let bytes = 0

  const evict = () => {
    bytes -= frames[first]!.bytes
    frames[first] = undefined
    first = (first + 1) % limit
    size -= 1
  }

  return {
    cursor: (): SocketCursor => ({
      epoch,
      seq,
    }),
    append({ value }: { value: Value }): SocketFrame<Value> {
      const saved = structuredClone(value)
      const frame = {
        epoch,
        seq: seq + 1,
        value: saved,
      }
      const frameBytes = measure({ frame })
      seq = frame.seq

      while (size && (size === limit || bytes + frameBytes > byteLimit)) {
        evict()
      }

      if (frameBytes <= byteLimit) {
        frames[(first + size) % limit] = {
          frame,
          bytes: frameBytes,
        }
        size += 1
        bytes += frameBytes
      }

      return structuredClone(frame)
    },
    since({
      cursor,
      budget = byteLimit,
    }: {
      cursor?: SocketCursor
      budget?: number
    }): SocketFrame<Value>[] | undefined {
      if (!cursor || cursor.epoch !== epoch || !Number.isSafeInteger(cursor.seq)
        || cursor.seq < seq - size || cursor.seq > seq) {
        return undefined
      }

      const offset = cursor.seq - (seq - size)
      let remaining = budget

      for (let i = offset; i < size; i += 1) {
        remaining -= frames[(first + i) % limit]!.bytes

        if (remaining < 0) {
          return undefined
        }
      }

      return Array.from(
        { length: size - offset },
        (
          _,
          i,
        ) =>
          structuredClone(frames[(first + offset + i) % limit]!.frame),
      )
    },
  }
}
