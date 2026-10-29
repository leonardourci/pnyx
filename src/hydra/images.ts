import { FILE_BLOCK } from './attachments.ts'

// An image attached to a message travels as an `[image: <path>]` token where the owner placed it,
// so every route carries it as text and hosted sessions also receive the file itself.
export const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
} as const
export type ImageType = (typeof IMAGE_TYPES)[keyof typeof IMAGE_TYPES]
// Claude takes images up to 5 MB once base64 encoded, which adds a third.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024 * 3 / 4
const EXTENSIONS = Object.keys(IMAGE_TYPES).map(extension => extension.slice(1))
  .join('|')
export const ATTACHMENT_NAME = new RegExp(`^[\\da-f]{8}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{12}\\.(?:${EXTENSIONS})$`)
export const IMAGE = /\[image: (\/[^\]\n]+)\]/g

export const imageLine = ({ path }: { path: string }) => `[image: ${path}]`

export const imageExtension = ({ type }: { type: string }) =>
  Object.entries(IMAGE_TYPES).find(([
    , known,
  ]) => known === type)?.[0]

export const imageType = ({ path }: { path: string }): ImageType | undefined =>
  IMAGE_TYPES[(/\.\w+$/.exec(path)?.[0] ?? '') as keyof typeof IMAGE_TYPES]

// Shown text also renders a bare absolute image path as an image chip; only tokens are sent as images.
export const SHOWN_IMAGE = new RegExp(
  `\\[image: (\\/[^\\]\\n]+)\\]|(?<![\\w/.:~-])(\\/[^\\s\\[\\]()<>"'\`]+\\.(?:${EXTENSIONS}))(?![\\w/]|\\.\\w)`,
  'g',
)
// Code and link targets render literally, so their paths get no chip and no number.
const LITERAL = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1|`[^`\n]+`|\]\([^)\n]*\)/gm

export const imagePaths = ({ text }: { text: string }) =>
  [...text.matchAll(IMAGE)].map(match => match[1]!)

export const shownImagePath = ({ match }: { match: RegExpMatchArray }) => {
  const [
    , tokenPath,
    barePath,
  ] = match

  return {
    path: (tokenPath ?? barePath)!,
    bare: tokenPath === undefined,
  }
}

export function imageNames({ text }: { text: string }): Map<string, string> {
  const names = new Map<string, string>()

  for (const path of imagePaths({
    text: text.replace(
      FILE_BLOCK,
      '',
    ),
  })) {
    if (!names.has(path)) {
      names.set(
        path,
        `Image ${names.size + 1}`,
      )
    }
  }

  return names
}

// Tokens keep the composer's Image N numbers; a bare path is named by its file, like the path it shows.
export function shownImageNames({ text }: { text: string }): Map<string, string> {
  const shown = text.replace(
    LITERAL,
    '',
  )
  const names = imageNames({ text: shown })

  for (const match of shown.matchAll(SHOWN_IMAGE)) {
    const {
      path,
      bare,
    } = shownImagePath({ match })

    if (bare && !names.has(path)) {
      names.set(
        path,
        path.slice(path.lastIndexOf('/') + 1),
      )
    }
  }

  return names
}

// Only files Pnyx stored for a Hydra are sent as images; any other path stays text.
export function attachedImages({
  text,
  hydras,
}: {
  text: string
  hydras: string
}): string[] {
  return [...new Set(imagePaths({ text }))].filter(path => {
    const parts = path.slice(hydras.length + 1).split('/')

    return path.startsWith(`${hydras}/`) && parts.length === 3 && parts[1] === 'attachments'
      && ATTACHMENT_NAME.test(parts[2]!) && !parts[0]!.startsWith('.')
  })
}
