import { inform } from '#app/command-notices.ts'
import { childRepositories, attachProjectGroup, projectGroupCommand } from './group-cli.ts'
import { keepProject } from './ownership.ts'
import { requestCwd } from '#app/request-context.ts'
import { sameProjectPath } from './identity.ts'
import { projectMemoryCommand } from '#memory/project-cli.ts'
import { CLONE_TIMEOUT_MS } from './limits.ts'
import { runFile } from '#app/run-process.ts'
import { isAbsolute, resolve } from 'node:path'
import { commit, guard, meta, parse, required, WRITE, type Output } from '#app/cli-support.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { HydraError } from '#store/errors.ts'
import { loadHydra } from '#app/store.ts'
import { withRegistryLock } from '#store/storage.ts'
import { findProject, projectFolder, projectName, projectRows, sharingHydras } from './read.ts'
import { parseLanding, parseMerger } from '#tasks/delivery/rule.ts'

async function projectCommand({ args }: { args: string[] }): Promise<Output> {
  if (args[0] === 'group') {
    return projectGroupCommand({ args })
  }

  if (args[0] === 'worker-notes') {
    return projectMemoryCommand({
      args: [
        ...args.slice(1),
        '--key',
        'workers',
      ],
    })
  }

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

  if (action === 'keep') {
    return keepProject({
      hydraId,
      ref: required({
        value: ref,
        what: 'repository path',
      }),
      meta: m,
    })
  }

  if (action === 'show') {
    const project = findProject({
      state: current,
      ref: required({
        value: ref,
        what: 'project name or path',
      }),
    })
    let memory: Output | undefined

    if (!project.detached) {
      try {
        memory = await projectMemoryCommand({
          args: [
            'list',
            '--project',
            project.path,
            '--hydra',
            hydraId,
          ],
        })
      } catch (error) {
        if (!(error instanceof HydraError) || error.code !== 'NOT_FOUND') {
          throw error
        }
      }
    }

    const shownState = loadHydra({ hydraId }).state
    const shownProject = findProject({
      state: shownState,
      ref: project.path,
    })
    const attachment = projectRows({
      state: shownState,
      projects: [shownProject],
    })[0]

    return {
      project: shownProject.name,
      ...memory,
      attachment,
    }
  }

  if (action === 'list' && !ref && !values.clone && !values.into) {
    const listedState = loadHydra({ hydraId }).state
    const projects = projectRows({ state: listedState })

    const listed: Output = {
      hydraId,
      revision: listedState.projectsRevision ?? 0,
      projects: projects.length ? projects : 'none: no projects attached',
    }

    if (projects.length === 0) {
      listed.help = ['Attach a project to this Hydra in the UI']
    }

    return listed
  }

  if (action !== 'add' && action !== 'remove' && action !== 'set') {
    throw new HydraError({
      message: 'Use project add <path>, project add --clone <url> --into <folder>, project list, project show <name|path>, project keep <path>, project set <name|path> or project remove <name|path>',
      code: 'VALIDATION_ERROR',
    })
  }

  if ((values.clone && (action !== 'add' || ref || !values.into)) || (values.into && !values.clone)) {
    throw new HydraError({
      message: 'Use project add --clone <url> --into <folder>; the destination is required',
      code: 'VALIDATION_ERROR',
    })
  }

  if (action === 'set') {
    const project = findProject({
      state: current,
      ref: required({
        value: ref,
        what: 'project',
      }),
    })

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

    return await commit({
      hydraId,
      meta: m,
      intent: {
        type: 'hydra.project',
        card: '$projects',
      },
      decide: ({ state }) => {
        const before = findProject({
          state,
          ref: project.path,
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

  if (m.id && Object.hasOwn(
    current.eventIds,
    m.id,
  )) {
    return await commit({
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
    const destination = resolve(
      requestCwd(),
      required({
        value: values.into as string | undefined,
        what: '--into <folder>',
      }),
    )

    try {
      await runFile({
        command: 'git',
        args: [
          'clone',
          '--',
          String(values.clone),
          destination,
        ],
        options: {
          timeout: CLONE_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
          },
        },
      })
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

  if (action === 'add') {
    const repositories = childRepositories({ path })

    if (repositories.length) {
      return attachProjectGroup({
        hydraId,
        paths: repositories,
        landing,
        merge,
        name: projectName({ path }),
        groupId: path,
        meta: m,
        attach: true,
      })
    }
  }

  const result = withRegistryLock({
    fn: async () => await commit({
      hydraId,
      meta: m,
      intent: {
        type: 'hydra.project',
        card: '$projects',
      },
      decide: ({ state }) => {
        const before = state.projects?.find(p => sameProjectPath({
          left: p.path,
          right: path,
        })) ?? null

        const detached = action === 'remove'

        if (detached && !before) {
          throw new HydraError({
            message: 'project not found',
            code: 'NOT_FOUND',
          })
        }

        const sharedWith = detached ? [] : sharingHydras({
          hydraId,
          path,
        })
        const newlyAttached = !detached && (!before || before.detached)

        if (newlyAttached && sharedWith.length) {
          const owners = sharedWith.map(hydra => hydra.id).sort()
            .join(', ')
          inform({
            reason: `Project ${path} is also attached to Hydra ${owners}`,
            clear: 'Choose which Hydra should keep this project and detach it from the others in the UI',
          })
        }

        const after = {
          ...before,
          path: before?.path ?? path,
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
              sharedWith,
            },
          },
        })
      },
    }),
  })

  return result
}

export const project = guard({ handler: projectCommand })
