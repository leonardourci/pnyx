// The model files semantic search runs on, pinned by URL and SHA-256, and their
// one explicit download into $PNYX_HOME/models/. All are Apache-2.0.
import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { HydraError } from '../core/model.ts'
import { pnyxHome } from '../store/storage.ts'

export interface ModelFile {
  file: string
  url: string
  sha256: string
  bytes: number
}

export interface Embedder extends ModelFile {
  dims: number
  // The cosine similarity a card found by meaning alone must reach to count as a
  // strong match when the reranker does not run.
  floor: number
  // The first 16 dimensions of each PROBES vector, as the pinned file gives them
  // on Metal. Metal and CPU differ by under 0.002 a dimension; a broken
  // conversion or runtime differs by far more.
  golden: number[][]
}

const HF = 'https://huggingface.co'

// Floors calibrated on the round-2 evaluation set A (30 documents, 24 answerable and
// 6 no-answer queries) with the real models on Metal: 0.85 keeps 77% of the 311m's
// relevant pairs and passes 0.1% of irrelevant ones, 0.82 keeps 69% of the 97m's and
// passes 0.3%; neither adds a result to a no-answer query.
export const EMBEDDERS = {
  // granite-embedding-311m-multilingual-r2, community Q8_0 conversion whose vectors match IBM's ONNX.
  'granite-311m': {
    file: 'granite-embedding-311M-multilingual-r2-Q8_0.gguf',
    url: `${HF}/mykor/granite-embedding-311m-multilingual-r2-GGUF/resolve/4413a1d4c63ed0aeda030202ad982a613a91f9ea/granite-embedding-311M-multilingual-r2-Q8_0.gguf`,
    sha256: '960116d274ff796e65713a984c4d3de52999795512c64a02bb162e231fa1f3f8',
    bytes: 347018080,
    dims: 768,
    floor: 0.85,
    golden: [
      [
        0.00267,
        -0.00182,
        0.02855,
        0.01821,
        0.01481,
        -0.02663,
        0.00875,
        0.01482,
        0.06914,
        -0.00348,
        -0.01602,
        0.01384,
        0.20082,
        0.00362,
        0.00788,
        -0.02239,
      ],
      [
        0.0236,
        -0.02037,
        0.03073,
        -0.01654,
        -0.00024,
        -0.03252,
        -0.00303,
        -0.01737,
        0.06083,
        -0.00535,
        0.00135,
        0.01721,
        0.20501,
        -0.00506,
        0.00375,
        -0.04972,
      ],
      [
        -0.01879,
        0.01368,
        -0.01198,
        -0.00011,
        0.01027,
        -0.07786,
        0.05603,
        -0.00413,
        -0.04121,
        0.01467,
        0.00137,
        -0.03024,
        0.17125,
        0.03246,
        0.04358,
        -0.03574,
      ],
    ],
  },
  // granite-embedding-97m-multilingual-r2: the CPU default, about four times faster.
  'granite-97m': {
    file: 'granite-embedding-97M-multilingual-r2-Q8_0.gguf',
    url: `${HF}/mykor/granite-embedding-97m-multilingual-r2-GGUF/resolve/45ce642d3fab2033d167ec09641a159010f7d9d9/granite-embedding-97M-multilingual-r2-Q8_0.gguf`,
    sha256: '25155b89638e501ac33495fa278d551d7545e1e2f62722a499bba1f064c080f2',
    bytes: 115061088,
    dims: 384,
    floor: 0.82,
    golden: [
      [
        -0.02959,
        0.01938,
        0.01701,
        0.01376,
        0.00369,
        0.02401,
        -0.01196,
        0.07337,
        -0.002,
        -0.07297,
        0.00355,
        -0.01358,
        0.04005,
        0.03131,
        0.00851,
        0.01067,
      ],
      [
        -0.01988,
        0.03863,
        0.00627,
        -0.00427,
        -0.0094,
        0.00363,
        -0.01166,
        0.08304,
        -0.01887,
        -0.08826,
        -0.00066,
        -0.01361,
        0.04235,
        0.02495,
        0.01012,
        0.03127,
      ],
      [
        -0.03215,
        0.0036,
        0.02912,
        -0.01569,
        0.03489,
        -0.04232,
        0.01918,
        -0.05247,
        -0.0714,
        -0.00457,
        -0.01436,
        0.01828,
        -0.05007,
        0.01295,
        0.00098,
        0.02684,
      ],
    ],
  },
} satisfies Record<string, Embedder>

export type EmbedderId = keyof typeof EMBEDDERS
export const EMBEDDER_IDS = Object.keys(EMBEDDERS) as EmbedderId[]

// Qwen3-Reranker-0.6B, Q8_0 from ggml-org.
export const RERANKER: ModelFile & { golden: number[] } = {
  file: 'qwen3-reranker-0.6b-q8_0.gguf',
  url: `${HF}/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/resolve/a02f48bb4f057028298c21fa033da2b30d7742d5/qwen3-reranker-0.6b-q8_0.gguf`,
  sha256: '22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48',
  bytes: 639153184,
  // Its scores for RERANK_PROBE over PROBES, on Metal (CPU is within 0.03).
  golden: [
    0.4794,
    0.1785,
    0,
  ],
}

// Fixed texts every model run is checked against before it is trusted.
export const PROBES = [
  'The deploy was rolled back after the migration locked the orders table.',
  'O deploy foi revertido depois que a migração travou a tabela de pedidos.',
  'Add a dark mode toggle to the settings page.',
]
export const RERANK_PROBE = 'rollback after database schema change blocked writes'

const STALL_MS = 60_000

export const modelsDir = () => join(
  pnyxHome(),
  'models',
)
export const modelPath = ({ model }: { model: ModelFile }) => join(
  modelsDir(),
  model.file,
)

// Present at its pinned size; download() checked its SHA-256 before naming it.
export function isInstalled({ model }: { model: ModelFile }): boolean {
  try {
    return statSync(modelPath({ model })).size === model.bytes
  } catch {
    return false
  }
}

function removeAbandoned({ model }: { model: ModelFile }): void {
  for (const name of readdirSync(modelsDir())) {
    const pid = Number(name.slice(
      model.file.length + 1,
      -'.part'.length,
    ))

    if (!name.startsWith(`${model.file}.`) || !name.endsWith('.part') || !Number.isInteger(pid)) {
      continue
    }

    try {
      process.kill(
        pid,
        0,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        rmSync(
          join(
            modelsDir(),
            name,
          ),
          { force: true },
        )
      }
    }
  }
}

// Fetches a pinned file to <file>.<pid>.part, hashing as it streams, and names it
// only when size and SHA-256 match. Reports progress in bytes. A minute without
// data aborts it.
// ponytail: a failed download starts over; resume with a Range request if large files fail often.
export async function download({
  model,
  progress = () => {},
}: {
  model: ModelFile
  progress?: ({ bytes }: { bytes: number }) => void
}): Promise<'present' | 'downloaded'> {
  if (isInstalled({ model })) {
    return 'present'
  }

  mkdirSync(
    modelsDir(),
    { recursive: true },
  )
  removeAbandoned({ model })
  const part = `${modelPath({ model })}.${process.pid}.part`
  const failed = ({ why }: { why: string }) => new HydraError({
    message: `download of ${model.file} failed: ${why}`,
    code: 'DOWNLOAD_FAILED',
    help: ['Check the network and run `pnyx-axi oracle setup --semantic` again'],
  })
  const stall = new AbortController()
  let timer = setTimeout(
    () => stall.abort(new Error('no data for a minute')),
    STALL_MS,
  )
  const res = await fetch(
    model.url,
    { signal: stall.signal },
  ).catch((error: Error) => {
    clearTimeout(timer)
    throw failed({ why: error.message })
  })

  if (!res.ok || !res.body) {
    throw failed({ why: `HTTP ${res.status}` })
  }

  const hash = createHash('sha256')
  let bytes = 0
  const count = new Transform({
    transform(
      chunk: Buffer,
      _encoding,
      done,
    ) {
      clearTimeout(timer)
      timer = setTimeout(
        () => stall.abort(new Error('no data for a minute')),
        STALL_MS,
      )
      hash.update(chunk)
      bytes += chunk.length
      progress({ bytes })
      done(
        null,
        chunk,
      )
    },
  })

  try {
    await pipeline(
      Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
      count,
      createWriteStream(part),
    )
    const sha256 = hash.digest('hex')

    if (bytes !== model.bytes || sha256 !== model.sha256) {
      throw failed({ why: `it does not match its pin (${bytes} bytes, sha256 ${sha256})` })
    }

    renameSync(
      part,
      modelPath({ model }),
    )
  } catch (error) {
    rmSync(
      part,
      { force: true },
    )
    throw error instanceof HydraError ? error : failed({ why: (error as Error).message })
  } finally {
    clearTimeout(timer)
  }

  return 'downloaded'
}

// A failed download or golden check, recorded so searches stop starting workers that
// would fail the same way (or fetch a gigabyte again) until it expires. The
// reranker's failures are kept apart: searches still run on the embedder meanwhile.
type Failing = 'semantic' | 'reranker'
const failurePath = ({ what }: { what: Failing }) => join(
  pnyxHome(),
  `${what}-failure.json`,
)

export function recordFailure({
  message,
  forMs,
  what = 'semantic',
}: {
  message: string
  forMs: number
  what?: Failing
}): void {
  mkdirSync(
    pnyxHome(),
    { recursive: true },
  )
  writeFileSync(
    failurePath({ what }),
    `${JSON.stringify({
      message,
      until: Date.now() + forMs,
    })}\n`,
  )
}

export function activeFailure({ what = 'semantic' }: { what?: Failing } = {}): string | undefined {
  try {
    const {
      message,
      until,
    } = JSON.parse(readFileSync(
      failurePath({ what }),
      'utf8',
    )) as {
      message: string
      until: number
    }

    return until > Date.now() ? message : undefined
  } catch {
    return undefined
  }
}

export function clearFailure(): void {
  rmSync(
    failurePath({ what: 'semantic' }),
    { force: true },
  )
  rmSync(
    failurePath({ what: 'reranker' }),
    { force: true },
  )
}
