import { useEffect, useState } from 'react'
import type { FolderListing } from '#projects/folders.ts'

export function useFolders({
  path,
  repository,
  connected,
}: {
  path: string
  repository: string
  connected: boolean
}) {
  const [
    result,
    setResult,
  ] = useState<{
    query: string
    listing?: FolderListing
    error?: string
  }>()
  const query = new URLSearchParams({
    path,
    repository,
  }).toString()
  useEffect(
    () => {
      if (!connected) {
        return
      }

      const abort = new AbortController()
      const timer = setTimeout(
        () => {
          void fetch(
            new URL(
              `folders?${query}`,
              document.baseURI,
            ),
            { signal: abort.signal },
          ).then(async response => {
            const body = await response.json()

            if (!response.ok) {
              throw new Error(body.error ?? 'Folders could not be listed.')
            }

            if (!abort.signal.aborted) {
              setResult({
                query,
                listing: body as FolderListing,
              })
            }
          })
            .catch((error: Error) => {
              if (!abort.signal.aborted) {
                setResult({
                  query,
                  error: error.message,
                })
              }
            })
        },
        150,
      )

      return () => {
        clearTimeout(timer); abort.abort()
      }
    },
    [
      query,
      connected,
    ],
  )

  return result?.query === query ? result : undefined
}

