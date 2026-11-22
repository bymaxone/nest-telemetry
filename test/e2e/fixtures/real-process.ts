import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** The root of this repository, from which the bundler and the peers resolve. */
const ROOT = join(__dirname, '..', '..', '..')

/** What a child process printed on its standard output, and how it ended. */
export interface ChildResult {
  /** The lines the child wrote to its standard output. */
  readonly lines: string[]
  /** The exit code, or `null` when the child was stopped. */
  readonly code: number | null
}

/** A bundle of the SDK entry, built from the source for the child processes of one suite. */
export interface SdkBundle {
  /** The absolute path of the CommonJS file a child can `require`. */
  readonly file: string
  /** Deletes the bundle. */
  remove(): void
}

/**
 * Bundles the SDK entry from its source with the bundler the package is built with, so a child
 * process runs the code under test without a `dist/` that the test job has not built.
 *
 * @returns The bundle.
 */
export function bundleSdk(): SdkBundle {
  // Inside `node_modules`, so the native module loader finds the peers by walking up from the bundle,
  // and every tool that ignores `node_modules` ignores it too.
  const cache = join(ROOT, 'node_modules', '.cache')
  mkdirSync(cache, { recursive: true })
  const directory = mkdtempSync(join(cache, 'bymax-sdk-'))
  execFileSync(
    join(ROOT, 'node_modules', '.bin', 'tsup'),
    [
      'src/sdk/index.ts',
      '--no-config',
      '--format',
      'cjs',
      '--out-dir',
      directory,
      '--tsconfig',
      'tsconfig.build.json',
      '--target',
      'node24',
      '--external',
      '@opentelemetry/*'
    ],
    { cwd: ROOT, stdio: 'ignore' }
  )
  return {
    file: join(directory, 'index.cjs'),
    remove: () => rmSync(directory, { recursive: true })
  }
}

/**
 * Runs a script in a real Node process, where the process environment inherits from the one root
 * prototype of the process, as a polluted production process does.
 *
 * @param script - The CommonJS source; it can `require` the bundle through `process.env.BUNDLE`.
 * @param environment - The own variables of the child.
 * @param timeoutMs - How long the child may run.
 * @returns What the child printed.
 */
export function runInRealProcess(
  script: string,
  environment: Record<string, string>,
  timeoutMs: number
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      cwd: ROOT,
      env: {
        PATH: process.env['PATH'] ?? '',
        NODE_PATH: join(ROOT, 'node_modules'),
        ...environment
      }
    })
    let text = ''
    child.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ lines: text.split('\n').filter((line) => line !== ''), code })
    })
  })
}
