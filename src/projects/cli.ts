import { PROJECT_MEMORY_BUDGET } from './memory.ts'
import { projectMemoryCommand } from './memory-cli.ts'
import { CLONE_TIMEOUT_MS } from './limits.ts'
import { execFile } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import { commit, guard, meta, parse, required, WRITE, type Output } from '../cli/commands.ts'
import { hydraEvent } from '../core/hydra.ts'
import { HydraError } from '../core/model.ts'
import { loadHydra, withRegistryLock } from '../store/hydra-store.ts'
import { findProject, projectFolder, projectName, projectRows, sharingHydras } from './read.ts'
import { parseLanding, parseMerger } from '../landing/rule.ts'

const clone = promisify(execFile)

async function projectCommand({ args }: { args: string[] }): Promise<Output> {
  if (args[0] === 'memory') {
    return projectMemoryCommand({ args: args.slice(1) })
  }

  const {
    values,
    positionals,
    hydraId,
  } = parse({
    args,
    options: {
      ...WRITE,
      clone: { type: 'string' },
      into: { type: 'string' },
      'command-name': { type: 'string' },
      command: { type: 'string' },
      'brings-own-folder': { type: 'string' },
      copy: { type: 'string' },
      landing: { type: 'string' },
      merge: { type: 'string' },
    },
    positionals: 2,
  })
  const [
    action,
    ref,
  ] = positionals
  const m = meta({ values })
  const current = loadHydra({ hydraId }).state
  const readonly = current.config?.hydra.kind === 'firstmate'

  const settings = values['command-name'] !== undefined || values.command !== undefined || values['brings-own-folder'] !== undefined
  const landing = values.landing === undefined
    ? undefined
    : parseLanding({ value: String(values.landing) })
  const merge = values.merge === undefined
    ? undefined
    : parseMerger({ value: String(values.merge) })
  const rules = landing !== undefined || merge !== undefined

  if (rules && action !== 'set' && action !== 'add') {
    throw new HydraError({
      message: 'Landing rules need project add <path> or project set <name|path>',
      code: 'VALIDATION_ERROR',
    })
  }

  if ((settings || values.copy !== undefined) && action !== 'set') {
    throw new HydraError({
      message: 'Command settings need project set <name|path>',
      code: 'VALIDATION_ERROR',
    })
  }

  if (action === 'show') {
    return projectMemoryCommand({
      args: [
        'list',
        '--project',
        required({
          value: ref,
          what: 'project name or path',
        }),
        '--hydra',
        hydraId,
      ],
    })
  }

  if (action === 'list' && !ref && !values.clone && !values.into) {
    const projects = projectRows({ state: current })

    return {
      hydraId,
      readonly,
      revision: current.projectsRevision ?? 0,
      projects: projects.length ? projects : 'none: no projects attached',
    }
  }

  if (action !== 'add' && action !== 'remove' && action !== 'set') {
    throw new HydraError({
      message: 'Use project add <path>, project add --clone <url> --into <folder>, project list, project show <name|path>, project set <name|path> or project remove <name|path>',
      code: 'VALIDATION_ERROR',
    })
  }

  if (readonly) {
    throw new HydraError({
      message: 'This Hydra’s projects are managed by Firstmate',
      code: 'READ_ONLY',
    })
  }

  if ((values.clone && (action !== 'add' || ref || !values.into)) || (values.into && !values.clone)) {
    throw new HydraError({
      message: 'Use project add --clone <url> --into <folder>; the destination is required',
      code: 'VALIDATION_ERROR',
    })
  }

  if (action === 'set') {
    if (values.clone || values.into || (!settings && !rules && values.copy === undefined)) {
      throw new HydraError({
        message: 'Use project set <name|path> --command-name <name> --command <shell> [--brings-own-folder true|false], --copy <shell> or --landing pr|branch --merge owner|hydra',
        code: 'VALIDATION_ERROR',
      })
    }

    if (values['brings-own-folder'] !== undefined && ![
      'true',
      'false',
    ].includes(String(values['brings-own-folder']))) {
      throw new HydraError({
        message: '--brings-own-folder must be true or false',
        code: 'VALIDATION_ERROR',
      })
    }

    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'hydra.project',
        card: '$projects',
      },
      decide: ({ state }) => {
        if (state.config?.hydra.kind === 'firstmate') {
          throw new HydraError({
            message: 'This Hydra’s projects are managed by Firstmate',
            code: 'READ_ONLY',
          })
        }

        const before = findProject({
          state,
          ref: required({
            value: ref,
            what: 'project name or path',
          }),
        })
        const command = String(values.command ?? before.startCommand?.command ?? '').trim()
        const name = String(values['command-name'] ?? before.startCommand?.name ?? '').trim()

        if (command && !name) {
          throw new HydraError({
            message: 'Give the project command a name with --command-name',
            code: 'VALIDATION_ERROR',
          })
        }

        const after = { ...before }

        if (landing !== undefined) {
          after.landing = landing
        }

        if (merge !== undefined) {
          after.merge = merge
        }

        if (values.copy !== undefined) {
          const copy = String(values.copy).trim()
          delete after.copy

          if (copy) {
            after.copy = copy
          }
        }

        if (settings) {
          delete after.startCommand

          if (command) {
            after.startCommand = {
              name,
              command,
              bringsOwnFolder: values['brings-own-folder'] === undefined ? before.startCommand?.bringsOwnFolder ?? false : values['brings-own-folder'] === 'true',
            }
          }
        }

        return JSON.stringify(before) === JSON.stringify(after) ? { skipped: 'unchanged' }
          : hydraEvent({
            state,
            meta: m,
            cardId: '$projects',
            change: {
              type: 'hydra.project',
              data: {
                before,
                after,
                sharedWith: [],
              },
            },
          })
      },
    })
  }

  if (m.id && current.eventIds[m.id] !== undefined) {
    return commit({
      hydraId,
      meta: m,
      intent: {
        type: 'hydra.project',
        card: '$projects',
      },
      decide: () => ({ skipped: 'duplicate' }),
    })
  }

  if (m.actor === 'web' && action === 'add' && !isAbsolute(String(values.into ?? ref ?? ''))) {
    throw new HydraError({
      message: 'Enter an absolute laptop folder path',
      code: 'VALIDATION_ERROR',
    })
  }

  let path: string

  if (values.clone) {
    const destination = resolve(required({
      value: values.into as string | undefined,
      what: '--into <folder>',
    }))

    try {
      await clone(
        'git',
        [
          'clone',
          '--',
          String(values.clone),
          destination,
        ],
        {
          timeout: CLONE_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
          },
        },
      )
    } catch {
      throw new HydraError({
        message: `git clone failed into ${destination}; check the URL, access and destination before retrying`,
        code: 'CLONE_FAILED',
      })
    }

    path = projectFolder({ path: destination })
  } else {
    path = action === 'add' ? projectFolder({
      path: required({
        value: ref,
        what: 'project path',
      }),
    })
      : findProject({
        state: current,
        ref: required({
          value: ref,
          what: 'project name or path',
        }),
      }).path
  }

  const result = withRegistryLock({
    fn: () => commit({
      hydraId,
      meta: m,
      intent: {
        type: 'hydra.project',
        card: '$projects',
      },
      confirmation: action === 'add' ? {
        token: values.confirm as string | undefined,
        when: ({ event }) => event.type === 'hydra.project' && event.data.sharedWith.length > 0,
      } : undefined,
      decide: ({ state }) => {
        if (state.config?.hydra.kind === 'firstmate') {
          throw new HydraError({
            message: 'This Hydra’s projects are managed by Firstmate',
            code: 'READ_ONLY',
          })
        }

        const before = state.projects?.find(p => p.path === path) ?? null

        const detached = action === 'remove'
        const after = {
          ...before,
          path,
          name: before?.name ?? projectName({ path }),
          detached,
        }

        if (landing !== undefined) {
          after.landing = landing
        }

        if (merge !== undefined) {
          after.merge = merge
        }

        if (before && JSON.stringify(before) === JSON.stringify(after)) {
          return { skipped: 'unchanged' }
        }

        return hydraEvent({
          state,
          meta: m,
          cardId: '$projects',
          change: {
            type: 'hydra.project',
            data: {
              before,
              after,
              sharedWith: detached ? [] : sharingHydras({
                hydraId,
                path,
              }),
            },
          },
        })
      },
    }),
  })

  if (values.clone && result.confirmation === 'needed') {
    result.help = [`Clone completed. Attach its folder with \`pnyx-axi project add ${JSON.stringify(path)} --hydra ${hydraId} --confirm ${result.token}\``]
  }

  return result
}

export const project = guard({ handler: projectCommand })
export const PROJECT_HELP = `pnyx-axi project memory list|set|forget|confirm --project <name|path> [--key profile|preferences|learnings] [--text <text>] [--sources <fingerprint>] [--hydra <id>]

Project memory is shared by normalized git remote (canonical path without a remote), with one ${PROJECT_MEMORY_BUDGET}-character budget.
List prints default-branch source hashes, changed files and the fingerprint required when saving a profile.
Preferences and learnings persist independently of profile refreshes. Writes accept --reason, --event-id and --if-revision.

pnyx-axi project add <path> [--landing pr|branch] [--merge owner|hydra] [--hydra <id>]
pnyx-axi project add --clone <url> --into <folder> [--landing pr|branch] [--merge owner|hydra] [--hydra <id>]
pnyx-axi project list [--hydra <id>]
pnyx-axi project show <name|path> [--hydra <id>]
pnyx-axi project set <name|path> --command-name <name> --command <shell> [--brings-own-folder true|false] [--hydra <id>]
pnyx-axi project remove <name|path> [--hydra <id>]
pnyx-axi project set <name|path> --copy <shell command> [--hydra <id>]
pnyx-axi project set <name|path> [--landing pr|branch] [--merge owner|hydra] [--hydra <id>]

A project is a folder on this laptop, shown by its folder name. Relative paths are accepted.
Clone runs git directly; --into always names the destination. No agent receives the URL.
Remove detaches only; tasks and history stay. Add the path again to re-attach.
Sharing a folder with another Hydra first names those Hydras and returns confirmation: needed.
Repeat with --confirm <token> to attach it. Firstmate-linked Hydras list their home’s projects read-only.
Set saves a named start command; an empty --command clears it. --brings-own-folder declares that the command creates its worker’s folder.
Workers start in their task's own copy: a git worktree on branch pnyx/<hydra>-<task>, kept under the Hydra's folder.
--copy sets a command run in the project folder instead; it gets PNYX_TASK, PNYX_TASK_TITLE and PNYX_PROJECT and prints the new folder's path last.
An empty --copy restores git worktree copies.
Landing rules say where a worker's job stops. --landing pr (the default): commit, push and open a pull request; --landing branch: commit on the task's branch only.
--merge owner (the default): the owner merges; --merge hydra: Hydra may merge with task merge once every check is green.
Writes accept --event-id and --if-revision (project list shows the projects revision).`
