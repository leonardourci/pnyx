export const HYDRA_CARD = '$hydra'
// The ids a Hydra and its folder may take.
export const HYDRA_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i

export function homeHydraId({ name }: { name: string }): string {
  return name.toLowerCase()
    .replace(
      /[^a-z0-9._-]+/g,
      '-',
    )
    .replace(
      /^[^a-z0-9]+/,
      '',
    )
    .slice(
      0,
      64,
    ) || 'firstmate'
}
