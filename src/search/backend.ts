// What semantic search runs a text through: the pinned models through
// node-llama-cpp, on the GPU where it has a backend (Metal, CUDA, Vulkan) and the
// CPU otherwise, or, under PNYX_SEMANTIC_STUB=1 for tests, hash vectors and word
// overlap that never touch a model file. The worker process loads models;
// `search setup` also loads them once to run their golden check.
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { BoardError } from '../core/model.ts'
import { EMBEDDERS, PROBES, RERANKER, RERANK_PROBE, modelPath, type EmbedderId, type ModelFile } from './models.ts'
import { runtimeRequire } from './runtime.ts'
import { stubbed } from './settings.ts'

export interface Backend {
  // metal, cuda, vulkan, cpu or stub.
  mode: string
  // Identifies the vectors this backend makes: the model, its file and the mode,
  // since vectors from different backends differ slightly. search.db keeps vectors from one key only.
  key: string
  dims: number
  // Each PROBES text's vector, as this backend makes it.
  probes: Float32Array[]
  // A unit vector.
  embed(text: string): Promise<Float32Array>
  // Relevance of each document to the query, 0 to 1; loads the reranker on first use.
  rerank(query: string, docs: string[]): Promise<number[]>
  close(): Promise<void>
}

const GOLDEN_TOLERANCE = 0.01
const RERANK_TOLERANCE = 0.05
// Chunks are at most 768 characters; longer inputs are cut to fit.
const EMBED_CONTEXT = 1024
const RERANK_CONTEXT = 1024
const RERANK_QUERY_MAX = 512

// Semantic search cannot run: a model failed its check, or the worker did not answer.
// broken names the model file that failed its golden check, so setup can fetch it again.
export class SemanticError extends BoardError {
  broken?: ModelFile
  constructor(message: string, broken?: ModelFile) {
    super(message, 'SEMANTIC_UNAVAILABLE', ['Run `pnyx-axi search setup --semantic` again, or `pnyx-axi settings set search.semantic off`'])

    if (broken) {
      this.broken = broken
    }
  }
}

function unit(vector: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(vector)
  const norm = Math.hypot(...out) || 1

  for (let i = 0; i < out.length; i += 1) {
    out[i]! /= norm
  }

  return out
}

type Embedding = { getEmbeddingFor(tokens: number[]): Promise<{ vector: readonly number[] }> }
type Ranking = { rankAll(query: string, docs: string[], options: { onOverflow: 'maxChunk' }): Promise<number[]> }

// The part of node-llama-cpp this file uses; the package lives in the runtime folder, not in pnyx-axi's dependencies.
interface LlamaCpp {
  LlamaLogLevel: { error: unknown }
  getLlama(options: { gpu: 'auto'; build: 'never'; logLevel: unknown }): Promise<{
    gpu: string | false
    loadModel(options: { modelPath: string }): Promise<{
      tokenize(text: string): number[]
      createEmbeddingContext(o: { contextSize: number; batchSize: number }): Promise<Embedding>
      createRankingContext(options: { contextSize: number }): Promise<Ranking>
    }>
    dispose(): Promise<void>
  }>
}

const llamaCpp = () => import(pathToFileURL(runtimeRequire().resolve('node-llama-cpp')).href) as Promise<LlamaCpp>

// The detected mode without loading a model: what `search setup` picks models by.
export async function detectMode(): Promise<string> {
  if (stubbed()) {
    return 'stub'
  }

  const { getLlama, LlamaLogLevel } = await llamaCpp()
  const llama = await getLlama({ gpu: 'auto', build: 'never', logLevel: LlamaLogLevel.error })
  const mode = llama.gpu || 'cpu'
  await llama.dispose()

  return mode
}

export async function loadBackend(model: EmbedderId): Promise<Backend> {
  return stubbed() ? stubBackend() : realBackend(model)
}

async function realBackend(id: EmbedderId): Promise<Backend> {
  const { getLlama, LlamaLogLevel } = await llamaCpp()
  // build: never; a machine without a prebuilt binary has no semantic search rather than a compile.
  const llama = await getLlama({ gpu: 'auto', build: 'never', logLevel: LlamaLogLevel.error })
  const mode = llama.gpu || 'cpu'
  const spec = EMBEDDERS[id]
  const model = await llama.loadModel({ modelPath: modelPath(spec) })
  const context = await model.createEmbeddingContext({
    contextSize: EMBED_CONTEXT,
    batchSize: EMBED_CONTEXT,
  })

  // Leaves room for the start and end tokens the context adds; its input must stay under the context size.
  const embed = async (text: string) => {
    const tokens = model.tokenize(text).slice(0, EMBED_CONTEXT - 4)

    return unit((await context.getEmbeddingFor(tokens)).vector)
  }

  const probes: Float32Array[] = []

  for (const p of PROBES) {
    probes.push(await embed(p))
  }

  const drift = Math.max(...spec.golden.flatMap((g, i) =>
    g.map((x, d) => Math.abs(x - probes[i]![d]!))))

  if (!(drift <= GOLDEN_TOLERANCE)) {
    throw new SemanticError(`${id} failed its golden check (drift ${drift.toFixed(4)}); the model file or runtime is broken`, spec)
  }

  let ranking: Promise<Ranking> | undefined

  const loadRanking = async () => {
    const reranker = await llama.loadModel({ modelPath: modelPath(RERANKER) })
    const ctx = await reranker.createRankingContext({ contextSize: RERANK_CONTEXT })
    const scores = await ctx.rankAll(RERANK_PROBE, PROBES, { onOverflow: 'maxChunk' })
    const off = Math.max(...scores.map((s, i) => Math.abs(s - RERANKER.golden[i]!)))

    if (!(off <= RERANK_TOLERANCE)) {
      throw new SemanticError(`the reranker failed its golden check (off by ${off.toFixed(3)})`, RERANKER)
    }

    return ctx
  }

  return {
    mode,
    key: `${id}@${spec.sha256.slice(0, 16)}/${mode}`,
    dims: spec.dims,
    probes,
    embed,
    async rerank(query, docs) {
      ranking ??= loadRanking()
      const ctx = await ranking

      // A document too long for the context is scored by its best-scoring piece.
      return ctx.rankAll(query.slice(0, RERANK_QUERY_MAX), docs, { onOverflow: 'maxChunk' })
    },
    close: () => llama.dispose(),
  }
}

const STUB_DIMS = 64
const fold = (text: string) => text.toLowerCase().normalize('NFD')
  .replace(/\p{M}/gu, '')
const stubWords = (text: string) => fold(text).match(/[\p{L}\p{N}]+/gu) ?? []

// Bag of words hashed into 64 dimensions: texts sharing words are near.
function stubVector(text: string): Float32Array {
  const v = new Float32Array(STUB_DIMS)
  v[0] = 0.01

  for (const word of stubWords(text)) {
    const h = createHash('sha256').update(word)
      .digest()
    v[h[0]! % STUB_DIMS]! += h[1]! & 1 ? 1 : -1
  }

  return unit(v)
}

function stubBackend(): Backend {
  return {
    mode: 'stub',
    key: 'stub',
    dims: STUB_DIMS,
    probes: PROBES.map(stubVector),
    embed: async text => stubVector(text),
    // The share of the query's words the document holds.
    rerank: async (query, docs) => {
      const q = new Set(stubWords(query))

      return docs.map(d => {
        const words = new Set(stubWords(d))

        return q.size ? [...q].filter(w => words.has(w)).length / q.size : 0
      })
    },
    close: async () => {},
  }
}
