import { findProject } from '#projects/read.ts'
import { INSCRIBE_SKILL } from '#setup/skill-names.ts'
import { memoryConditions } from './conditions.ts'
import { learningChange, staleLearnings } from './learnings.ts'
import { explained, meta, parse, required, WRITE, type Output } from '#app/cli-support.ts'
import { TitanError } from '#store/errors.ts'
import { loadTitan } from '#app/store.ts'
import { PROJECT_MEMORY_BUDGET, PROJECT_MEMORY_DOCUMENTS, PROJECT_MEMORY_NEARLY_FULL, projectMemoryView, writeProjectMemory, type ProjectMemoryKey } from './project-memory.ts'

export async function projectMemoryCommand({ args }: { args: string[] }): Promise<Output> {
  const {
    values,
    positionals,
    titanId,
  } = parse({
    args,
    options: {
      ...WRITE,
      project: { type: 'string' },
      key: { type: 'string' },
      text: { type: 'string' },
      sources: { type: 'string' },
      kind: { type: 'string' },
      until: { type: 'string' },
      used: { type: 'string' },
    },
    positionals: 1,
  })
  const action = positionals[0] ?? 'list'
  const project = findProject({
    state: loadTitan({ titanId }).state,
    ref: required({
      value: values.project as string | undefined,
      what: '--project <name|path>',
    }),
    attached: true,
  })
  const learning = learningChange({
    action,
    kind: values.kind as string | undefined,
    until: values.until as string | undefined,
    used: values.used as string | undefined,
    text: values.text as string | undefined,
  })

  if (action === 'list') {
    const view = await projectMemoryView({
      ...project,
      titanId,
    })

    return {
      project: project.name,
      id: view.id,
      identity: view.identity,
      revision: view.revision,
      profile: view.status,
      learnings: view.learnings ?? [],
      archived: view.archived,
      stale: staleLearnings({
        lines: view.learnings ?? [],
        conditions: memoryConditions(),
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
        ...(view.used > PROJECT_MEMORY_BUDGET * PROJECT_MEMORY_NEARLY_FULL ? [`Project memory is nearly full: load ${INSCRIBE_SKILL} with this project and curate it.`] : []),
        'Read changed files at the listed ref (git show <ref>:<file>); profile saves need --sources <fingerprint>. Do not refresh from a worker branch.',
      ],
    }
  }

  if (action === 'save' || action === 'archive') {
    return writeProjectMemory({
      path: project.path,
      titanId,
      key: 'learnings',
      after: null,
      learning,
      meta: meta({ values }),
    })
  }

  if (action === 'confirm') {
    const view = await projectMemoryView({
      ...project,
      titanId,
    })
    const change = meta({ values })

    const duplicate = view.events.some(event => event.id === change.id)

    if (!duplicate && change.ifRevision !== undefined && change.ifRevision !== view.revision) {
      throw new TitanError({
        message: 'Project memory changed. Read it again before confirming the learning.',
        code: 'REVISION_CONFLICT',
      })
    }

    return writeProjectMemory({
      path: project.path,
      titanId,
      key: 'learnings',
      after: view.documents.learnings ?? null,
      confirmed: required({
        value: values.text as string | undefined,
        what: '--text <existing learning line>',
      }),
      meta: {
        ...change,
        ifRevision: view.revision,
      },
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
    throw new TitanError({
      message: 'Use project memory list|set|forget|confirm|save|archive --project <name|path>; keys are profile, preferences, learnings and workers',
      code: 'VALIDATION_ERROR',
    })
  }

  const after = action === 'forget' ? null : required({
    value: values.text as string | undefined,
    what: '--text',
  }).trim()

  if (after === '') {
    throw new TitanError({
      message: 'Project memory text must not be empty',
      code: 'VALIDATION_ERROR',
    })
  }

  const m = meta({ values })
  explained({ meta: m })

  return writeProjectMemory({
    path: project.path,
    titanId,
    key,
    after,
    sources: values.sources as string | undefined,
    learning,
    meta: m,
  })
}
