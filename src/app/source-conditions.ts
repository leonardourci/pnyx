// A child started from source needs the source condition, or its # imports resolve to dist.
export const SOURCE_CONDITIONS = import.meta.url.endsWith('.ts') ? ['--conditions=source'] : []
