import { projectsFor } from '#projects/read.ts'

import { SET_UP_SKILL } from './skill-names.ts'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { TEMPLATE_NUDGE } from '#hydra/digest.ts'
import type { HydraProject } from '#projects/model.ts'
import { effectiveDispatch, loginFolder, onTemplate, type Harness } from '#workers/dispatch-config.ts'
import { detectedHarnesses, hookStatus, setupHooks } from './hooks.ts'
import { skillStatus } from './skills.ts'
import { readableProjectMemory } from '#memory/project-memory.ts'
import { sharingHydras } from '#projects/read.ts'
import { serviceFile } from './service.ts'
import { loadHydra } from '#app/store.ts'
import { recordExitCode } from '#app/request-context.ts'

export interface SetupItem {
  name: string
  missing: string
  // Hydra runs a hydra fix itself; an owner fix becomes a question card or a one-line ask in chat.
  by: 'hydra' | 'owner'
  fix: string
}

export const onPath = ({ name }: { name: string }) =>
  (process.env.PATH ?? '').split(delimiter).some(dir => dir && existsSync(join(
    dir,
    name,
  )))

const SIGN_IN: Record<Harness, string> = {
  claude: 'sign in to Claude Code (`claude`, then /login)',
  codex: 'sign in to Codex (`codex login`)',
}

export async function setupCheck({
  hydraId,
  readable,
}: {
  hydraId: string
  readable: HydraProject[]
}): Promise<SetupItem[]> {
  const items: SetupItem[] = []

  if (onTemplate()) {
    items.push({
      name: 'config',
      missing: TEMPLATE_NUDGE,
      by: 'hydra',
      fix: 'configure dispatch rules in the UI',
    })
  }

  try {
    const {
      dispatch,
      accounts,
      fallback,
    } = effectiveDispatch()
    const harnesses = new Set([
      ...Object.values(dispatch.rules).flatMap(rule => rule.candidates),
      ...dispatch.default,
    ].map(candidate => candidate.harness))

    for (const [
      name,
      account,
    ] of Object.entries(accounts)) {
      if (!existsSync(loginFolder({ account }))) {
        items.push({
          name: `account:${name}`,
          missing: `login folder ${account.folder} does not exist`,
          by: 'owner',
          fix: `${SIGN_IN[account.provider]} with that folder, or remove ${name} in the UI`,
        })
      }
    }

    // A registered account without its folder already has its own row.
    const registered = new Set(Object.values(accounts).map(account => account.provider))

    for (const harness of [...harnesses].sort()) {
      if (!registered.has(harness)) {
        items.push({
          name: `login:${harness}`,
          missing: `no ${harness} login for the rules that name it`,
          by: 'owner',
          // Default logins count only while no account is registered; otherwise the login must be registered too.
          fix: fallback ? SIGN_IN[harness] : `${SIGN_IN[harness]}, then configure its account folder in the UI`,
        })
      }
    }
  } catch (error) {
    items.push({
      name: 'config',
      missing: (error as Error).message,
      by: 'owner',
      fix: 'inspect and correct dispatch in the UI',
    })
  }

  try {
    const script = hookStatus()
    const missing = script === 'current' ? detectedHarnesses().map(harness => setupHooks({
      harness,
      opts: {
        remove: false,
        preview: true,
      },
    }))
      .filter(hook => hook.change === 'installed')
      .map(hook => hook.config) : []

    if (script !== 'current' || missing.length) {
      items.push({
        name: 'hooks',
        missing: script === 'current' ? `reporting hooks not installed in ${missing.join(', ')}` : `hook script ${script}`,
        by: 'owner',
        fix: `pnyx setup hooks --hydra ${hydraId}`,
      })
    }
  } catch (error) {
    items.push({
      name: 'hooks',
      missing: (error as Error).message,
      by: 'owner',
      fix: 'fix that config by hand, then run `pnyx setup hooks`',
    })
  }

  const skills = skillStatus()

  if (skills !== 'ready') {
    items.push({
      name: 'skills',
      missing: skills,
      by: 'owner',
      fix: skills.startsWith('conflict') ? 'move that skill aside, then run `pnyx setup skills`' : `pnyx setup skills --hydra ${hydraId}`,
    })
  }

  if (!onPath({ name: 'quota-axi' })) {
    items.push({
      name: 'quota-axi',
      missing: 'quota-axi not on PATH, so dispatch cannot rank accounts by quota',
      by: 'owner',
      fix: 'install quota-axi (https://axi.md)',
    })
  }

  // ponytail: an installed job counts as running, since launchd or systemd keeps it alive; ask them if that proves too loose.
  if ((process.platform === 'darwin' || process.platform === 'linux') && !existsSync(serviceFile().path)) {
    items.push({
      name: 'service',
      missing: 'no login service, so Hydras stop when this server stops',
      by: 'owner',
      fix: 'pnyx setup',
    })
  }

  const profiles = await Promise.all(readable.filter(project => !project.detached)
    .map(async project => ({
      project,
      status: (await readableProjectMemory({
        ...project,
        hydraId,
      }))?.status,
    })))

  for (const {
    project,
    status,
  } of profiles) {
    const duplicates = sharingHydras({
      hydraId,
      path: project.path,
    })

    if (duplicates.length) {
      const hydras = [
        hydraId,
        ...duplicates.map(hydra => hydra.id),
      ].sort().join(', ')
      items.push({
        name: `project-owner:${project.path}`,
        missing: `repository ${project.path} is attached to Hydras ${hydras}`,
        by: 'owner',
        fix: `Choose a keeper for ${project.path} in the UI`,
      })
    }

    if (status === 'missing') {
      items.push({
        name: `profile:${project.name}`,
        missing: `project ${project.name} has no profile`,
        by: 'hydra',
        fix: `save a profile for ${project.name} through the UI`,
      })
    }
  }

  return items
}

export const setupDigest = ({ items }: { items: SetupItem[] }) => items.length ? [
  `Setup needed (load ${SET_UP_SKILL}):`,
  ...items.map(item => `- ${item.name}: ${item.missing} · ${item.by === 'hydra' ? 'you' : 'owner'}: ${item.fix}`),
] : []

export async function setupCheckOutput({ hydraId }: { hydraId: string }) {
  const loaded = loadHydra({ hydraId }).state
  const items = await setupCheck({
    hydraId,
    readable: projectsFor({state: loaded}),
  })

  if (!items.length) {
    return {
      hydraId,
      setup: 'complete',
    }
  }

  recordExitCode({ code: 1 })

  return {
    hydraId,
    missing: items,
    help: [`Hydra runs setup commands directly; login rows need the owner’s credentials; see the ${SET_UP_SKILL} skill`],
  }
}
