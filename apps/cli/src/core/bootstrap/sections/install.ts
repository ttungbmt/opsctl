import {
  type InstallDeps,
  type InstallOptions,
  type InstallResult,
  type PackageStatus,
  installPackages,
} from '#core/package/install.js'
import type {Change, ChangeStatus, Section, SectionContext} from '#core/bootstrap/section.js'

const STATUS: Record<PackageStatus, ChangeStatus> = {
  'already-installed': 'satisfied',
  failed: 'failed',
  installed: 'changed',
  'would-install': 'would-change',
}

const toChange = (p: InstallResult['packages'][number]): Change => ({
  id: p.spec,
  status: STATUS[p.status],
  ...(p.version === undefined ? {} : {detail: p.version}),
  ...(p.error === undefined ? {} : {error: p.error}),
})

function optionsFor(ctx: SectionContext, packages: string[], dryRun: boolean): InstallOptions {
  return {
    dryRun,
    force: ctx.options.force,
    json: ctx.options.json,
    nonInteractive: ctx.options.nonInteractive,
    packages,
    // The engine already gated for the whole run; gating again would ask twice.
    yes: true,
  }
}

/**
 * The `packages` and `tools` sections. They share every mechanism and differ in one
 * dependency: `packages` resolves exactly as `ops tool install` does, while `tools`
 * clears the system-preferred list so a bare name prefers the mise registry.
 */
export function createInstallSection(name: 'packages' | 'tools', deps: InstallDeps): Section<InstallResult> {
  const sectionDeps: InstallDeps = name === 'tools' ? {...deps, systemPreferred: new Set()} : deps
  const listFor = (ctx: SectionContext) => (name === 'packages' ? ctx.profile.packages : ctx.profile.tools)

  return {
    name,
    async plan(ctx) {
      const result = await installPackages(optionsFor(ctx, listFor(ctx), true), sectionDeps)
      return {changes: result.packages.map(toChange), commands: result.commands ?? [], section: name}
    },
    async apply(ctx) {
      const result = await installPackages(optionsFor(ctx, listFor(ctx), false), sectionDeps)
      return {
        changes: result.packages.map(toChange),
        detail: result,
        section: name,
        status: result.success ? 'ok' : 'failed',
      }
    },
  }
}
