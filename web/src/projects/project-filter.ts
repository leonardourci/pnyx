import { useCallback, useEffect, useState } from 'react'

export function useProjectFilter() {
  const [
    project,
    setProject,
  ] = useState(new URLSearchParams(location.search).get('open-project') ?? new URLSearchParams(location.search).get('project') ?? '')
  const [
    projectReferences,
    setProjectReferences,
  ] = useState<string[]>([])
  const resolveProject = useCallback(
    ({ references }: { references: string[] }) => {
      setProjectReferences(references)
    },
    [],
  )
  useEffect(
    () => {
      const url = new URL(location.href)

      if (url.searchParams.has('add-project')) {
        url.searchParams.delete('add-project')
      }

      // ?settings opens Settings once; leaving it and reloading returns to the Hydra.
      url.searchParams.delete('settings')

      const project = url.searchParams.get('open-project')

      if (project !== null) {
        url.searchParams.delete('open-project'); url.searchParams.set(
          'project',
          project,
        )
      }

      history.replaceState(
        null,
        '',
        url,
      )
    },
    [],
  )

  const filterProject = ({ path }: { path: string }) => {
    setProject(path)
    const url = new URL(location.href)

    if (path) {
      url.searchParams.set(
        'project',
        path,
      )
    } else {
      url.searchParams.delete('project')
    }

    history.replaceState(
      null,
      '',
      url,
    )
  }

  return {
    project,
    projectReferences,
    resolveProject,
    filterProject,
  }
}
