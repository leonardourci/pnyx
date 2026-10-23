import { staleLearnings } from '../memory/learnings.ts'
import { explained, meta, parse, required, WRITE, type Output } from '../cli/commands.ts'
import { HydraError } from '../core/model.ts'
import { loadHydra } from '../store/hydra-store.ts'
import { findProject } from './read.ts'
import { PROJECT_MEMORY_BUDGET, PROJECT_MEMORY_DOCUMENTS, PROJECT_MEMORY_NEARLY_FULL, projectMemoryView, writeProjectMemory, type ProjectMemoryKey } from './memory.ts'

export function projectMemoryCommand({ args }: { args: string[] }): Output {
  const {
    values,
    positionals,
    hydraId,
  } = parse({
    args,
    options: {
      ...WRITE,
      project: { type: 'string' },
      key: { type: 'string' },
      text: { type: 'string' },
      sources: { type: 'string' },
    },
    positionals: 1,
  })
  const project = findProject({
    state: loadHydra({ hydraId }).state,
    ref: required({
      value: values.project as string | undefined,
      what: '--project <name|path>',
    }),
    attached: true,
  })
  const action = positionals[0] ?? 'list'

  if (action === 'list') {
    const view = projectMemoryView(project)

    return {
      project: project.name,
      id: view.id,
      identity: view.identity,
      revision: view.revision,
      profile: view.status,
      learnings: view.learnings ?? [],
      stale: staleLearnings({
        lines: view.learnings ?? [],
        now: new Date().toISOString(),
      }),
      memory: Object.keys(view.documents).length ? view.documents : 'none: no project memory yet',
      used: `${view.used} of ${PROJECT_MEMORY_BUDGET} characters`,
      ref: view.currentSources.ref,
      sources: Object.entries(view.currentSources.hashes).map(([
        file,
        hash,
      ]) => ({
        file,
        hash,
      })),
      changed: view.changed.length ? view.changed : 'none',
      fingerprint: view.currentSources.fingerprint || 'unavailable',
      help: [
        ...(view.used > PROJECT_MEMORY_BUDGET * PROJECT_MEMORY_NEARLY_FULL ? ['Project memory is nearly full: load inscribe with this project and curate it.'] : []),
        'Read changed files at the listed ref (git show <ref>:<file>); profile saves need --sources <fingerprint>. Do not refresh from a worker branch.',
      ],
    }
  }

  if (action === 'confirm') {
    const view = projectMemoryView(project)

    return writeProjectMemory({
      path: project.path,
      hydraId,
      key: 'learnings',
      after: view.documents.learnings ?? null,
      confirmed: required({
        value: values.text as string | undefined,
        what: '--text <existing learning line>',
      }),
      meta: meta({ values }),
    })
  }

  const key = values.key as ProjectMemoryKey | undefined

  if (![
    'set',
    'forget',
  ].includes(action) || !key || !Object.hasOwn(
    PROJECT_MEMORY_DOCUMENTS,
    key,
  )) {
    throw new HydraError({
      message: 'Use project memory list|set|forget|confirm --project <name|path>; keys are profile, preferences, learnings and workers',
      code: 'VALIDATION_ERROR',
    })
  }

  const after = action === 'forget' ? null : required({
    value: values.text as string | undefined,
    what: '--text',
  }).trim()

  if (after === '') {
    throw new HydraError({
      message: 'Project memory text must not be empty',
      code: 'VALIDATION_ERROR',
    })
  }

  const m = meta({ values })
  explained({ meta: m })

  return writeProjectMemory({
    path: project.path,
    hydraId,
    key,
    after,
    sources: values.sources as string | undefined,
    meta: m,
  })
}
