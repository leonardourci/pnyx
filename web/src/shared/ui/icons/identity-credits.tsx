import { IDENTITY_ICONS } from './identity.ts'

const CC_BY = 'https://creativecommons.org/licenses/by/3.0/'
const AUTHORS = [...new Set(IDENTITY_ICONS.map(icon => icon.author))]

function AuthorCredit({ author }: { author: string }) {
  const drawn = IDENTITY_ICONS.filter(icon => icon.author === author)

  return (
    <p>
      {drawn.map((
        icon,
        n,
      ) => (
        <span key={icon.id}>
          {n ? ', ' : ''}<a href={icon.source} target="_blank" rel="noreferrer">{icon.label}</a>
        </span>
      ))}
      {' '}by {author} on game-icons.net, licensed under <a href={CC_BY} target="_blank" rel="noreferrer">CC BY 3.0</a>.
    </p>
  )
}

// The credits every identity icon needs, one line per artist, read from the registry so a new icon is credited too.
export function IdentityCredits() {
  return (
    <>
      <p>Hydra, column and composer icons from game-icons.net, drawn in the theme’s colors:</p>
      {AUTHORS.map(author => <AuthorCredit key={author} author={author} />)}
    </>
  )
}
