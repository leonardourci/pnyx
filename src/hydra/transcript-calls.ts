import { readTranscriptRecord } from '#workers/transcripts.ts'
import { callOf, type ActionRead, type CurrentAction, type RecordCalls } from './calls.ts'

const MAX_CALLS = 8

export function recordCalls({ record }: { record: unknown }): RecordCalls {
  const parsed = readTranscriptRecord({ record })
  const found: RecordCalls = {
    calls: parsed.calls.map(callOf),
    results: parsed.results,
  }

  if (parsed.at !== undefined) {
    found.at = parsed.at
  }

  return found
}

const parseLine = ({ line }: { line: string }): unknown => {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

// Calls written back to back are one run, the agent's current action; a later run replaces it.
export function readAction({
  lines,
  prev,
}: {
  lines: string[]
  prev?: ActionRead
}): ActionRead {
  let calls = prev?.action?.calls ?? []
  let at = prev?.action?.at
  let open = prev?.open ?? false
  const answered = new Set(prev?.answered)

  for (const line of lines) {
    const record = parseLine({ line })

    if (record === undefined) {
      continue
    }

    const found = recordCalls({ record })

    if (found.calls.length && open) {
      calls = [
        ...calls,
        ...found.calls,
      ]
    } else if (found.calls.length) {
      calls = found.calls
      at = found.at
      answered.clear()
    }

    open = found.calls.length > 0

    for (const id of found.results) {
      if (calls.some(call => call.id === id)) {
        answered.add(id)
      }
    }
  }

  if (!calls.length) {
    return {
      action: null,
      answered: [],
      open: false,
    }
  }

  const kept = calls.slice(-MAX_CALLS)
  const action: CurrentAction = {
    calls: kept,
    done: kept.every(call => answered.has(call.id)),
  }

  if (at) {
    action.at = at
  }

  return {
    action,
    answered: [...answered],
    open,
  }
}
