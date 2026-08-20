/**
 * Prepare the bundled dsh backend tree.
 *
 * Installs the public `@deepseek-ai/dsh` npm package (and its full dependency
 * tree, including the prebuilt web frontend dist) into `backend/` so the app can
 * boot `dsh web` offline. This tree contains ONLY public npm packages — no user
 * credentials, no `~/.dsh` data, nothing machine-specific.
 *
 * Usage: `node scripts/prepare-backend.mjs`
 *
 * @module dsh-launcher/scripts/prepare-backend
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const BACKEND_DIR = path.join(ROOT, 'backend')

// Clean the previous tree so stale packages (or any accidentally copied user
// data) can never survive into a release build.
if (fs.existsSync(BACKEND_DIR)) {
  fs.rmSync(BACKEND_DIR, { recursive: true, force: true })
}
fs.mkdirSync(BACKEND_DIR, { recursive: true })

// A minimal package.json keeps npm from walking up into the parent project.
fs.writeFileSync(
  path.join(BACKEND_DIR, 'package.json'),
  JSON.stringify({ name: 'dsh-launcher-backend', private: true, version: '0.0.0' }, null, 2),
)

console.log('dsh-launcher: installing @deepseek-ai/dsh into backend/ (this downloads public packages only)…')

/**
 * Run `npm install` without a shell.
 * - Windows: npm is a .cmd shim, so drive the npm CLI with the current Node
 *   runtime directly (no shell, no injection surface).
 * - macOS/Linux: `npm` is an executable shell script with a shebang; run it
 *   directly.
 */
function runNpm(args) {
  if (process.platform === 'win32') {
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (!fs.existsSync(npmCli)) {
      throw new Error(`npm CLI not found at ${npmCli}`)
    }
    return execFileSync(process.execPath, [npmCli, ...args], { cwd: BACKEND_DIR, stdio: 'inherit' })
  }
  return execFileSync('npm', args, { cwd: BACKEND_DIR, stdio: 'inherit' })
}

try {
  runNpm(['install', '--prefix', BACKEND_DIR, '@deepseek-ai/dsh', '--no-audit', '--no-fund', '--loglevel=error'])
} catch (error) {
  console.error('dsh-launcher: npm install failed', error)
  process.exit(1)
}

const bin = path.join(BACKEND_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const dist = path.join(BACKEND_DIR, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
if (!fs.existsSync(bin) || !fs.existsSync(dist)) {
  console.error('dsh-launcher: backend install looks incomplete (missing dsh bin or frontend dist)')
  process.exit(1)
}

console.log('dsh-launcher: backend ready.')
