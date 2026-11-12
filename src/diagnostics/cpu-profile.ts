import { closeSync, openSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { Session } from 'node:inspector/promises'
import type { Profiler, Runtime } from 'node:inspector'
import { setTimeout as delay } from 'node:timers/promises'
import { writeOpenFile } from '#store/storage.ts'
import { log } from '#app/diagnostics.ts'
import { oneDecimal } from '#app/log-line.ts'
import { HydraError } from '#store/errors.ts'

export const PROFILE_SECONDS = 10
export const PROFILE_MAX_SECONDS = 60
const MICROS_PER_MS = 1000
const MS_PER_SECOND = 1000
const PROFILE_FUNCTIONS = 20
let profiling = false

// V8 nodes are call-tree positions, so one function reached from several callers spans several nodes.
const frameKey = ({ frame }: { frame: Runtime.CallFrame }) => [
  frame.url,
  frame.functionName,
  frame.lineNumber,
  frame.columnNumber,
].join(':')

export function profileFunctions({ profile }: { profile: Profiler.Profile }) {
  const frames = new Map(profile.nodes.map(node => [
    node.id,
    node.callFrame,
  ]))
  const counts = new Map<string, {
    frame: Runtime.CallFrame
    samples: number
    micros: number
  }>()

  profile.samples?.forEach((
    id,
    index,
  ) => {
    const frame = frames.get(id)

    if (!frame) {
      return
    }

    const key = frameKey({ frame })
    const count = counts.get(key) ?? {
      frame,
      samples: 0,
      micros: 0,
    }
    count.samples++
    count.micros += profile.timeDeltas?.[index] ?? 0
    counts.set(
      key,
      count,
    )
  })

  const total = profile.endTime - profile.startTime

  return [...counts.values()].map(count => ({
    function: count.frame.functionName || '(anonymous)',
    file: count.frame.url,
    line: count.frame.lineNumber + 1,
    samples: count.samples,
    selfMs: Math.round(count.micros / MICROS_PER_MS),
    percent: oneDecimal({ value: count.micros / total * 100 }),
  })).sort((
    a,
    b,
  ) => b.selfMs - a.selfMs)
    .slice(
      0,
      PROFILE_FUNCTIONS,
    )
}

export async function captureCpuProfile({
  seconds,
  path,
  signal,
}: {
  seconds: number
  path: string
  signal?: AbortSignal
}) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > PROFILE_MAX_SECONDS) {
    throw new HydraError({
      code: 'VALIDATION_ERROR',
      message: `--seconds must be between 1 and ${PROFILE_MAX_SECONDS}`,
    })
  }

  if (profiling) {
    throw new HydraError({
      code: 'BUSY',
      message: 'A CPU profile is already running',
    })
  }

  const fd = reserveOutput({ path })
  profiling = true
  const session = new Session()
  let saved = false

  try {
    session.connect()
    await session.post('Profiler.enable')
    await session.post('Profiler.start')
    log({
      operation: 'cpu.profile',
      status: 'started',
      name: path,
    })
    let profile: Profiler.Profile

    try {
      await delay(
        seconds * MS_PER_SECOND,
        undefined,
        { signal },
      )
    } catch (error) {
      if (signal?.aborted) {
        throw new HydraError({
          code: 'CANCELLED',
          message: 'CPU profile cancelled: its Hydra stopped',
        })
      }

      throw error
    } finally {
      profile = (await session.post('Profiler.stop')).profile
    }

    writeOpenFile({
      fd,
      path,
      data: JSON.stringify(profile),
    })
    saved = true

    return {
      path,
      seconds,
      samples: profile.samples?.length ?? 0,
      functions: profileFunctions({ profile }),
      help: [`Open \`${path}\` in Chrome DevTools > Performance (Load profile)`],
    }
  } finally {
    closeSync(fd)

    if (!saved) {
      rmSync(
        path,
        { force: true },
      )
    }

    session.disconnect()
    profiling = false
  }
}

// Claims the output before sampling, so a bad path fails at once instead of after the capture.
function reserveOutput({ path }: { path: string }): number {
  try {
    return openSync(
      path,
      'wx',
      0o600,
    )
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code

    if (code === 'EEXIST') {
      throw new HydraError({
        code: 'ALREADY_EXISTS',
        message: `CPU profile output already exists: ${path}`,
      })
    }

    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') {
      throw new HydraError({
        code: 'VALIDATION_ERROR',
        message: `CPU profile folder is missing or not writable: ${dirname(path)}`,
      })
    }

    throw error
  }
}
