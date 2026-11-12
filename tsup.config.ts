import { defineConfig } from 'tsup'

// One bundle per published subpath. Every entry shares the same output shape; only the
// entry file and the externals differ.
const common = {
  format: ['esm', 'cjs'] as ('esm' | 'cjs')[],
  dts: true,
  tsconfig: 'tsconfig.build.json',
  outDir: 'dist',
  outExtension: ({ format }: { format: string }): { js: string } => ({
    js: format === 'esm' ? '.mjs' : '.cjs'
  }),
  // Peers are never bundled: a bundled copy would be a second instance of the package
  // the host already loaded (a different injection token, a different OTel global).
  external: [/^@nestjs\//, /^@opentelemetry\//, 'reflect-metadata', 'rxjs'],
  target: 'node24' as const,
  clean: false,
  splitting: false,
  treeshake: true,
  sourcemap: false
}

export default defineConfig([
  // SDK entry (`.`) — programmatic start. Imports no `@nestjs/*` package.
  { ...common, entry: { 'sdk/index': 'src/sdk/index.ts' } },
  // Zero-config preload for `node --import`.
  { ...common, entry: { 'register/index': 'src/register/index.ts' } },
  // NestJS module and shutdown provider.
  { ...common, entry: { 'nest/index': 'src/nest/index.ts' } }
])
