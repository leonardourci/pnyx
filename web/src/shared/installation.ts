// Installation-wide data is keyed by this server and Pnyx home, so two installs never share a cache.
export function installationScope({ resource }: { resource: string }): string {
  const identity = document.querySelector<HTMLMetaElement>('meta[name=pnyx-installation]')?.content ?? ''

  return `${location.origin}:${identity}/${resource}`
}
