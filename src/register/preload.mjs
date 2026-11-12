// The preload Node runs through `--import`. Everything it does is in `boot.ts`, which is measured
// and mutation-tested; this file exists because the module must end in a top-level `await`, which the
// TypeScript sources cannot contain under the CommonJS transform their tests use. The real
// `node --import` child processes of `pnpm check:runtime` own this file.
import { bootFromEnvironment } from './boot.ts'

await bootFromEnvironment(import.meta.url)
