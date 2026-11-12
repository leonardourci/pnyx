import { existsSync } from 'node:fs'
import { Session } from 'node:inspector/promises'
import type { Profiler } from 'node:inspector'
import { setTimeout as delay } from 'node:timers/promises'
import { writeDurably } from '#store/storage.ts'
import { log } from '#app/diagnostics.ts'
import { HydraError } from '#store/errors.ts'

export const PROFILE_SECONDS = 10
export const PROFILE_MAX_SECONDS = 60
const MICROS_PER_MS = 1000
const MS_PER_SECOND = 1000
const PROFILE_FUNCTIONS = 20
let profiling = false

export function profileFunctions({ profile }: { profile: Profiler.Profile }) {
  const counts = new Map<number, {
    samples: number
    micros: number
  }>()
  const samples = profile.samples ?? []

  for (let index = 0; index < samples.length; index++) {
    const id = samples[index]!
    const count = counts.get(id) ?? {
      samples: 0,
      micros: 0,
    }
    count.samples++
    count.micros += profile.timeDeltas?.[index] ?? 0
    counts.set(
      id,
      count,
    )
  }

  const total = profile.endTime - profile.startTime

  return profile.nodes.flatMap(node => {
    const count = counts.get(node.id)

    if (!count) {
      return []
    }

    return [
      {
        function: node.callFrame.functionName || '(anonymous)',
        file: node.callFrame.url,
        line: node.callFrame.lineNumber + 1,
        samples: count.samples,
        selfMs: Math.round(count.micros / MICROS_PER_MS),
        percent: Math.round(count.micros / total * 1000) / 10,
      },
    ]
  }).sort((
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

  if (existsSync(path)) {
    throw new HydraError({
      code: 'ALREADY_EXISTS',
      message: `CPU profile output already exists: ${path}`,
    })
  }

  if (profiling) {
    throw new HydraError({
      code: 'BUSY',
      message: 'A CPU profile is already running',
    })
  }

  profiling = true
  const session = new Session()

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
    } finally {
      profile = (await session.post('Profiler.stop')).profile
    }

    writeDurably({
      path,
      data: JSON.stringify(profile),
      flag: 'wx',
    })

    return {
      path,
      seconds,
      samples: profile.samples?.length ?? 0,
      functions: profileFunctions({ profile }),
    }
  } finally {
    session.disconnect()
    profiling = false
  }
}
