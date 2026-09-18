/**
 * ADR-0010 and ADR-0011 as a build failure.
 * Without this, layer separation is a promise in a README.
 */
module.exports = {
  forbidden: [
    {
      name: 'web-only-touches-contracts',
      comment:
        'The frontend must not import the domain or infrastructure. Its only ' +
        'contract with the backend is @aa/contracts (and HTTP).',
      severity: 'error',
      from: { path: '^apps/web' },
      to: { path: 'packages/(core|adapters)' },
    },
    {
      name: 'core-does-not-touch-infrastructure',
      comment: 'packages/core is pure domain. I/O goes behind a port.',
      severity: 'error',
      from: { path: '^packages/core' },
      to: { path: 'packages/(adapters|contracts)|^apps/' },
    },
    {
      name: 'core-has-no-external-deps',
      comment:
        'Only exception: @js-temporal/polyfill (date primitive). ' +
        'src/testing is excluded: it is test support and may import vitest.',
      severity: 'error',
      from: { path: '^packages/core/src', pathNot: '^packages/core/src/testing' },
      to: {
        dependencyTypes: ['npm'],
        pathNot: 'node_modules/@js-temporal/polyfill',
      },
    },
    {
      name: 'contracts-depends-on-nothing',
      comment: 'DTOs only. One import and it stops being a boundary.',
      severity: 'error',
      from: { path: '^packages/contracts' },
      to: { path: 'packages/(core|adapters)|^apps/' },
    },
    {
      name: 'apps-do-not-touch-each-other',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/(?!$1)([^/]+)/' },
    },
    { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'no-unresolvable',
      comment:
        'An import that does not resolve. Also the first line of defence for ' +
        'the boundary: pnpm only links what a package declares, so importing ' +
        '@aa/core from apps/web lands here before any path rule runs.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    // Workspace packages export TypeScript source directly (no build step
    // between packages in dev), so the resolver needs the exports field and
    // .ts extensions. Without this, a cross-boundary import shows up as
    // "unresolvable" instead of as the boundary violation it actually is.
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    },
  },
};
