// Installation-wide data is keyed by this server and Othrys home, so two installs never share a cache.
export function installationScope({ resource }: { resource: string }): string {
  const identity = document.querySelector<HTMLMetaElement>('meta[name=othrys-installation]')?.content ?? ''

  return `${location.origin}:${identity}/${resource}`
}
