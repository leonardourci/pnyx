import type { HydraState } from '#app/model.ts'

const TAB_TITLE_LENGTH = 60

export const hydraTitle = ({ name }: { name: string }) => name || 'Untitled'

export function pageTitle({
  page = 'hydra',
  cards,
  selected = null,
  hydra = 'Hydra',
}: {
  page?: string
  cards: HydraState['cards']
  selected?: string | null
  hydra?: string
}): string {
  const label = page === 'settings' ? 'Settings' : selected && cards[selected]?.title
  const shortTitle = label && label.length > TAB_TITLE_LENGTH ? `${label.slice(
    0,
    TAB_TITLE_LENGTH,
  ).replace(
    /\s+\S*$/,
    '',
  )}…` : label

  return [
    shortTitle,
    hydra,
    'Pnyx',
  ].filter(Boolean).join(' · ')
}

export const shouldReload = ({
  loaded,
  server,
}: {
  loaded: string | undefined
  server: string
}) =>
  Boolean(loaded && server && loaded !== server)
