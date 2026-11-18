const TAB_TITLE_LENGTH = 60

export const hydraTitle = ({ name }: { name: string }) => name || 'Untitled'

export function pageTitle({
  page = 'hydra',
  taskTitle,
  hydra = 'Hydra',
}: {
  page?: string
  taskTitle?: string
  hydra?: string
}): string {
  let label = page === 'settings' ? 'Settings' : taskTitle

  const characters = label ? Array.from(label) : []

  if (characters.length > TAB_TITLE_LENGTH) {
    const prefix = characters.slice(
      0,
      TAB_TITLE_LENGTH,
    ).join('')
    const next = characters[TAB_TITLE_LENGTH]
    const endsInsideWord = next && /\S$/.test(prefix) && /\S/.test(next)
    const wholeWords = endsInsideWord ? prefix.replace(
      /\s+\S*$/,
      '',
    ) : prefix
    label = `${wholeWords.trimEnd()}…`
  }

  return [
    label,
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
