/**
 * Fork: a self-hosted Studio that lists and switches between the projects of its registry
 * (deploy/platform/SPEC.md, option B+). Turns on the header's project switcher and the command
 * menu's "Switch project", which upstream shows only on the platform.
 *
 * Inlined at build time like every `NEXT_PUBLIC_*` variable, so it takes an image built with
 * `NEXT_PUBLIC_IS_MULTI_PROJECT=true`. Off by default, and off changes nothing. The server side is
 * switched by `STUDIO_PROJECT_REGISTRY` or `STUDIO_PROJECT_REGISTRY_URL` at run time
 * (`lib/api/self-hosted/project-context.ts`); without either, the switcher lists `default` alone.
 */
export const IS_MULTI_PROJECT = process.env.NEXT_PUBLIC_IS_MULTI_PROJECT === 'true'
