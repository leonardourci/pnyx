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
