export function compatibleEnvironment({ env }: { env: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
  const result = { ...env }

  for (const [
    key,
    value,
  ] of Object.entries(env)) {
    if (!key.startsWith('PNYX_')) {
      continue
    }

    const suffix = key.slice('PNYX_'.length).replace(
      /^HYDRA(?=_|$)/,
      'TITAN',
    )
    const current = `OTHRYS_${suffix}`

    if (result[current] === undefined) {
      result[current] = value
    }
  }

  return result
}

// The spelling a Pnyx build read, such as PNYX_HYDRA for OTHRYS_TITAN.
export const legacyName = ({ name }: { name: string }): string => name.replace(
  /^OTHRYS_TITAN(?=_|$)/,
  'PNYX_HYDRA',
).replace(
  /^OTHRYS_/,
  'PNYX_',
)

// Commands, hooks and agent contexts from before the rename read the PNYX_ spellings, so a child gets both,
// for every name or only the ones listed.
export function withLegacyNames<Env extends NodeJS.ProcessEnv>({
  env,
  only,
}: {
  env: Env
  only?: string[]
}): Env {
  return {
    ...env,
    ...Object.fromEntries(Object.entries(env)
      .filter(([name]) => name.startsWith('OTHRYS_') && (!only || only.includes(name)))
      .map(([
        name,
        value,
      ]) => [
        legacyName({ name }),
        value,
      ])),
  } as Env
}
