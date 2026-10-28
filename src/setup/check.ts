import { SET_UP_SKILL } from '../integrations/skills/names.ts'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { TEMPLATE_NUDGE } from '../core/digest.ts'
import type { HydraState } from '../app/model.ts'
import { configPath, effectiveDispatch, loginFolder, onTemplate, parseAccounts, readConfig, type Harness } from '../workers/dispatch-config.ts'
import { detectedHarnesses, hookStatus, setupHooks } from '../integrations/hooks/install.ts'
import { skillStatus } from '../integrations/skills/install.ts'
import { projectMemoryView } from '../memory/project-memory.ts'
import { projectsFor } from '../projects/read.ts'
import { serviceFile } from '../server/service.ts'
import { loadHydra } from '../app/store.ts'

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

// Reads only files, PATH and each attached project's git sources, so it is cheap enough for every session open.
export function setupCheck({
  hydraId,
  state,
}: {
  hydraId: string
  state: HydraState
}): SetupItem[] {
  const items: SetupItem[] = []

  if (onTemplate({
    hydraId,
    state,
  })) {
    items.push({
      name: 'config',
      missing: TEMPLATE_NUDGE,
      by: 'hydra',
      fix: `pnyx-axi rule init --shared --hydra ${hydraId}`,
    })
  }

  try {
    const {
      dispatch,
      accounts,
      fallback,
    } = effectiveDispatch({
      hydraId,
      state,
    })
    const harnesses = new Set([
      ...Object.values(dispatch.rules).flatMap(rule => rule.candidates),
      ...dispatch.default,
    ].map(candidate => candidate.harness))

    // A per-Hydra registry with accounts replaces the shared one.
    const shared = !Object.keys(parseAccounts({
      value: readConfig({
        path: configPath({
          hydraId,
          accounts: true,
        }),
      }),
    }).accounts).length ? ' --shared' : ''

    for (const [
      name,
      account,
    ] of Object.entries(accounts)) {
      if (!existsSync(loginFolder({ account }))) {
        items.push({
          name: `account:${name}`,
          missing: `login folder ${account.folder} does not exist`,
          by: 'owner',
          fix: `${SIGN_IN[account.provider]} with that folder, or remove it: pnyx-axi account remove ${name}${shared} --hydra ${hydraId}`,
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
          fix: fallback ? SIGN_IN[harness] : `${SIGN_IN[harness]}, then pnyx-axi account set ${harness}:personal --provider ${harness} --folder <login folder>${shared} --hydra ${hydraId}`,
        })
      }
    }
  } catch (error) {
    items.push({
      name: 'config',
      missing: (error as Error).message,
      by: 'owner',
      fix: 'fix that file by hand',
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
        fix: `pnyx-axi setup hooks --hydra ${hydraId}`,
      })
    }
  } catch (error) {
    items.push({
      name: 'hooks',
      missing: (error as Error).message,
      by: 'owner',
      fix: 'fix that config by hand, then run `pnyx-axi setup hooks`',
    })
  }

  const skills = skillStatus()

  if (skills !== 'ready') {
    items.push({
      name: 'skills',
      missing: skills,
      by: 'owner',
      fix: skills.startsWith('conflict') ? 'move that skill aside, then run `pnyx-axi setup skills`' : `pnyx-axi setup skills --hydra ${hydraId}`,
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

  // ponytail: an installed job counts as running, since launchd keeps it alive; read launchctl if that proves too loose.
  if (process.platform === 'darwin' && !existsSync(serviceFile().path)) {
    items.push({
      name: 'service',
      missing: 'no login service, so Hydras stop when this server stops',
      by: 'owner',
      fix: 'pnyx-axi setup service',
    })
  }

  for (const project of projectsFor({ state }).filter(project => !project.detached)) {
    if (projectMemoryView(project).status === 'missing') {
      items.push({
        name: `profile:${project.name}`,
        missing: `project ${project.name} has no profile`,
        by: 'hydra',
        fix: `write its profile as the Hydra contract describes (pnyx-axi project memory list --project ${project.name} --hydra ${hydraId})`,
      })
    }
  }

  return items
}

export const setupDigest = ({ items }: { items: SetupItem[] }) => items.length ? [
  `Setup needed (load ${SET_UP_SKILL}):`,
  ...items.map(item => `- ${item.name}: ${item.missing} · ${item.by === 'hydra' ? 'you' : 'owner'}: ${item.fix}`),
] : []

export function setupCheckOutput({ hydraId }: { hydraId: string }) {
  const items = setupCheck({
    hydraId,
    state: loadHydra({ hydraId }).state,
  })

  if (!items.length) {
    return {
      hydraId,
      setup: 'complete',
    }
  }

  process.exitCode = 1

  return {
    hydraId,
    missing: items,
    help: [`Hydra runs the hydra rows itself and asks you to confirm the owner rows; see the ${SET_UP_SKILL} skill`],
  }
}
