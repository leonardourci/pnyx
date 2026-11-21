import { randomUUID } from 'node:crypto'

const HOME_HISTORY_LIMIT = 50_000

export interface SocketCursor {
  epoch: string
  seq: number
}

export interface SocketFrame<Value> extends SocketCursor {
  value: Value
}

export function createSocketHistory<Value>({
  limit = HOME_HISTORY_LIMIT,
  epoch = randomUUID(),
}: {
  limit?: number
  epoch?: string
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('socket history needs a positive capacity')
  }

  const frames: SocketFrame<Value>[] = new Array(limit)
  let first = 0
  let size = 0
  let seq = 0

  return {
    cursor: (): SocketCursor => ({
      epoch,
      seq,
    }),
    append({ value }: { value: Value }): SocketFrame<Value> {
      const frame = {
        epoch,
        seq: ++seq,
        value: structuredClone(value),
      }
      const index = (first + size) % limit
      frames[index] = frame

      if (size === limit) {
        first = (first + 1) % limit
      } else {
        size += 1
      }

      return structuredClone(frame)
    },
    since({ cursor }: { cursor?: SocketCursor }): SocketFrame<Value>[] | undefined {
      if (!cursor || cursor.epoch !== epoch || !Number.isSafeInteger(cursor.seq)
        || cursor.seq < seq - size || cursor.seq > seq) {
        return undefined
      }

      const found: SocketFrame<Value>[] = []
      const offset = cursor.seq - (seq - size)

      for (let i = offset; i < size; i += 1) {
        found.push(structuredClone(frames[(first + i) % limit]!))
      }

      return found
    },
  }
}
