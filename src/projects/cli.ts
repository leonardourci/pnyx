import { CLONE_TIMEOUT_MS } from './limits.ts'
import { execFile } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import { commit, guard, meta, parse, required, WRITE, type Output } from '../cli/commands.ts'
import { hydraEvent } from '../core/hydra.ts'
import { HydraError } from '../core/model.ts'
import { loadHydra, withRegistryLock } from '../store/hydra-store.ts'
import { findProject, projectFolder, projectName, projectRows, sharingHydras } from './read.ts'

const clone = promisify(execFile)

async function projectCommand({ args }: { args: string[] }): Promise<Output> {
  const { values, positionals, hydraId } = parse({ args, options: { ...WRITE, clone: { type: 'string' }, into: { type: 'string' }, copy: { type: 'string' } }, positionals: 2 })
  const [action, ref] = positionals
  const m = meta({ values })
  const current = loadHydra({ hydraId }).state
  const readonly = current.config?.hydra.kind === 'firstmate'

  if (action === 'list' && !ref && !values.clone && !values.into) {
    const projects = projectRows({ state: current })

    return { hydraId, readonly, revision: current.projectsRevision ?? 0, projects: projects.length ? projects : 'none: no projects attached' }
  }

  if (action !== 'add' && action !== 'remove' && action !== 'set') {
    throw new HydraError({ message: 'Use project add <path>, project add --clone <url> --into <folder>, project list, project set <name|path> --copy <command> or project remove <name|path>', code: 'VALIDATION_ERROR' })
  }

  if (readonly) {
    throw new HydraError({ message: 'This Hydra’s projects are managed by Firstmate', code: 'READ_ONLY' })
  }

  if ((action === 'set') !== (values.copy !== undefined)) {
    throw new HydraError({ message: 'Use project set <name|path> --copy <shell command>; an empty command restores git worktree copies', code: 'VALIDATION_ERROR' })
  }

  if ((values.clone && (action !== 'add' || ref || !values.into)) || (values.into && !values.clone)) {
    throw new HydraError({ message: 'Use project add --clone <url> --into <folder>; the destination is required', code: 'VALIDATION_ERROR' })
  }

  if (m.id && current.eventIds[m.id] !== undefined) {
    return commit({ hydraId, meta: m, intent: { type: 'hydra.project', card: '$projects' }, decide: () => ({ skipped: 'duplicate' }) })
  }

  if (m.actor === 'web' && action === 'add' && !isAbsolute(String(values.into ?? ref ?? ''))) {
    throw new HydraError({ message: 'Enter an absolute laptop folder path in Settings', code: 'VALIDATION_ERROR' })
  }

  let path: string

  if (values.clone) {
    const destination = resolve(required({ value: values.into as string | undefined, what: '--into <folder>' }))

    try {
      await clone('git', ['clone', '--', String(values.clone), destination], { timeout: CLONE_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    } catch {
      throw new HydraError({ message: `git clone failed into ${destination}; check the URL, access and destination before retrying`, code: 'CLONE_FAILED' })
    }

    path = projectFolder({ path: destination })
  } else {
    path = action === 'add' ? projectFolder({ path: required({ value: ref, what: 'project path' }) })
      : findProject({ state: current, ref: required({ value: ref, what: 'project name or path' }) }).path
  }

  const result = withRegistryLock({
    fn: () => commit({
      hydraId,
      meta: m,
      intent: { type: 'hydra.project', card: '$projects' },
      confirmation: action === 'add' ? { token: values.confirm as string | undefined, when: ({ event }) => event.type === 'hydra.project' && event.data.sharedWith.length > 0 } : undefined,
      decide: ({ state }) => {
        if (state.config?.hydra.kind === 'firstmate') {
          throw new HydraError({ message: 'This Hydra’s projects are managed by Firstmate', code: 'READ_ONLY' })
        }

        const before = state.projects?.find(p => p.path === path) ?? null

        if (action === 'set') {
          const copy = String(values.copy).trim()

          if (!before || (before.copy ?? '') === copy) {
            return { skipped: 'unchanged' }
          }

          const after = { ...before }
          delete after.copy

          return hydraEvent({ state, meta: m, cardId: '$projects', change: { type: 'hydra.project', data: { before, after: copy ? { ...after, copy } : after, sharedWith: [] } } })
        }

        const detached = action === 'remove'

        if (before?.detached === detached) {
          return { skipped: 'unchanged' }
        }

        const after = { ...before, path, name: before?.name ?? projectName({ path }), detached }

        return hydraEvent({ state, meta: m, cardId: '$projects', change: { type: 'hydra.project', data: { before, after, sharedWith: detached ? [] : sharingHydras({ hydraId, path }) } } })
      },
    }),
  })

  if (values.clone && result.confirmation === 'needed') {
    result.help = [`Clone completed. Attach its folder with \`pnyx-axi project add ${JSON.stringify(path)} --hydra ${hydraId} --confirm ${result.token}\``]
  }

  return result
}

export const project = guard({ handler: projectCommand })
export const PROJECT_HELP = `pnyx-axi project add <path> [--hydra <id>]
pnyx-axi project add --clone <url> --into <folder> [--hydra <id>]
pnyx-axi project list [--hydra <id>]
pnyx-axi project remove <name|path> [--hydra <id>]
pnyx-axi project set <name|path> --copy <shell command> [--hydra <id>]

A project is a folder on this laptop, shown by its folder name. Relative paths are accepted.
Clone runs git directly; --into always names the destination. No agent receives the URL.
Remove detaches only; tasks and history stay. Add the path again to re-attach.
Sharing a folder with another Hydra first names those Hydras and returns confirmation: needed.
Repeat with --confirm <token> to attach it. Firstmate-linked Hydras list their home’s projects read-only.
Workers start in their task's own copy: a git worktree on branch pnyx/<hydra>-<task>, kept under the Hydra's folder.
--copy sets a command run in the project folder instead; it gets PNYX_TASK, PNYX_TASK_TITLE and PNYX_PROJECT and prints the new folder's path last.
An empty --copy restores git worktree copies.
Writes accept --event-id and --if-revision (project list shows the projects revision).`
