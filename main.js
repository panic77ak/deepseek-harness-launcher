/**
 * DSH Launcher — main process.
 *
 * Boots the dsh web backend (an npm-installed `@deepseek-ai/dsh` tree) using the
 * Node.js runtime bundled inside Electron (`ELECTRON_RUN_AS_NODE`), waits for the
 * HTTP server to come up, then opens the GUI in a native BrowserWindow.
 *
 * Privacy: this app contains NO user credentials. All API keys and settings live
 * in the user's own `$DSH_HOME` (default `~/.dsh`) and never leave that machine.
 *
 * @module dsh-launcher/main
 */

const { app, BrowserWindow, dialog, shell } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const fs = require('node:fs')

// Startup diagnostics: only active when DSH_DESKTOP_DEBUG is set (or in dev),
// so release builds write nothing and stay quiet.
const DEBUG_ENABLED = Boolean(process.env.DSH_DESKTOP_DEBUG) || !app.isPackaged
const DEBUG_LOG = DEBUG_ENABLED ? path.join(app.getPath('userData'), 'startup.log') : null
function debug(...args) {
  if (!DEBUG_LOG) return
  try {
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${args.join(' ')}\n`)
  } catch { /* ignore */ }
}
debug('main.js loaded, argv=', JSON.stringify(process.argv.slice(1)))

// ── configuration ────────────────────────────────────────────────────────────

/** Port the backend should prefer. Override with `--port <n>` or env DSH_DESKTOP_PORT. */
const DEFAULT_PORT = Number(process.env.DSH_DESKTOP_PORT || 3080)
/** How long to wait for the backend HTTP server before giving up (ms). */
const BOOT_TIMEOUT_MS = 120_000

// ── backend discovery ────────────────────────────────────────────────────────

/**
 * Locate a real Node.js executable, preferring the system one.
 *
 * dsh's Win32 native directory picker spawns its dialog worker with
 * `process.execPath` and expects plain-node semantics (COM + message pump).
 * Running the backend on Electron's `ELECTRON_RUN_AS_NODE` shim breaks that
 * worker, so we prefer the system `node` when present and only fall back to
 * the bundled runtime when no Node is installed.
 *
 * @returns {{ execPath: string, runAsNode: boolean }} the runtime to use.
 */
function resolveNodeRuntime() {
  // 1. An explicit override (DSH_DESKTOP_NODE) wins, for power users.
  if (process.env.DSH_DESKTOP_NODE && fs.existsSync(process.env.DSH_DESKTOP_NODE)) {
    return { execPath: process.env.DSH_DESKTOP_NODE, runAsNode: false }
  }
  // 2. System `node` on PATH (or common locations), with a version gate:
  //    dsh requires ^22.19.0 || >=24.0.0.
  const candidates = ['node', 'node.exe']
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { shell: false, windowsHide: true })
    if (probe.status === 0 && probe.stdout) {
      const version = probe.stdout.toString().trim().replace(/^v/, '')
      const [major, minor] = version.split('.').map(Number)
      if (major >= 24 || (major === 22 && minor >= 19)) {
        return { execPath: candidate, runAsNode: false }
      }
      debug('system node found but too old:', version)
    }
  }
  // 3. Fallback: the Electron binary itself as Node (no system Node needed),
  //    with the known directory-picker caveat.
  return { execPath: process.execPath, runAsNode: true }
}

/**
 * Locate the npm-installed dsh CLI entry.
 * - Packaged: `resources/backend/node_modules/@deepseek-ai/dsh/lib/bin.js`
 * - Dev:      `backend/node_modules/@deepseek-ai/dsh/lib/bin.js` (run `npm run prepare:backend`)
 */
function resolveBackendBin() {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'backend')
    : path.join(__dirname, 'backend')
  const candidate = path.join(base, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!fs.existsSync(candidate)) {
    throw new Error(
      `dsh backend not found at ${candidate}.\n`
      + (app.isPackaged
        ? 'The installation is corrupt; please reinstall DSH Launcher.'
        : 'Run `npm run prepare:backend` first to install the dsh npm tree.'),
    )
  }
  return candidate
}

// ── port helpers ─────────────────────────────────────────────────────────────

/** True when something is already listening on `port` (loopback). */
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    socket.setTimeout(800)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => resolve(false))
  })
}

/**
 * True when the server on `port` looks like a dsh web GUI (serves the boot graph).
 * We probe the root document for `__DSH_BOOT__`, the marker only `dsh web` injects.
 */
function isDshWeb(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve(res.statusCode === 200 && body.includes('__DSH_BOOT__')))
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}

// ── backend process ──────────────────────────────────────────────────────────

let backendChild = null
let backendPort = null
let isQuitting = false

/**
 * Start the dsh web backend child process.
 *
 * Prefers the system Node.js (so dsh's native directory picker works); falls
 * back to the Electron binary as Node (`ELECTRON_RUN_AS_NODE=1`) when no
 * system Node is installed. `--port 0` lets the OS pick a free port; the
 * actual port is parsed from the `dsh web:` readiness line.
 *
 * @param {number} preferPort - port to try first (3080 default), or 0 for any free port.
 * @returns {Promise<number>} the port the backend actually bound.
 */
async function startBackend(preferPort) {
  const bin = resolveBackendBin()
  const runtime = resolveNodeRuntime()
  debug('backend runtime:', runtime.execPath, 'runAsNode=', runtime.runAsNode)
  // --expose-internals lets dsh's HMR service reach Node internals on the
  // Electron-bundled runtime (the native fallback targets system Node ABIs).
  const args = ['--expose-internals', bin, 'web', '--no-open']
  if (preferPort > 0) args.push('--port', String(preferPort))
  else args.push('--port', '0')

  // Inherit the user's environment so `$DSH_HOME`, proxies, PATH etc. work as usual.
  const env = runtime.runAsNode
    ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    : { ...process.env }
  const child = spawn(runtime.execPath, args, {
    env,
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  backendChild = child
  let stderrTail = ''
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000)
  })

  // Resolve the bound port from the readiness line `dsh web: http://127.0.0.1:PORT`.
  const port = await new Promise((resolvePort, rejectPort) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        rejectPort(new Error(`dsh web backend did not become ready within ${BOOT_TIMEOUT_MS / 1000}s.\n${stderrTail}`))
      }
    }, BOOT_TIMEOUT_MS)

    const onData = (chunk) => {
      const text = chunk.toString()
      const match = text.match(/dsh web: http:\/\/127\.0\.0\.1:(\d+)/)
      if (match) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolvePort(Number(match[1]))
        }
      }
    }
    child.stdout.on('data', onData)
    child.once('exit', (code, signal) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        rejectPort(new Error(`dsh web backend exited early (code=${code} signal=${signal}).\n${stderrTail}`))
      }
    })
  })

  backendPort = port
  child.on('exit', (code, signal) => {
    debug('backend child exited', 'code=', code, 'signal=', signal, 'isQuitting=', isQuitting, 'app.isQuitting=', app.isQuitting)
    debug('backend stderr tail:', stderrTail)
    if (!isQuitting && !app.isQuitting) {
      dialog.showErrorBox(
        'DSH Launcher — backend stopped',
        `The dsh web backend exited unexpectedly (code=${code} signal=${signal}).\n`
        + 'The window will close. Restart DSH Launcher to try again.',
      )
    }
    app.quit()
  })
  return port
}

// ── window ───────────────────────────────────────────────────────────────────

/** Keep a strong reference so the window is never garbage-collected. */
let mainWindow = null

/** Create the GUI window pointed at the backend. */
function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'DSH Launcher — DeepSeek Harness',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    // External links open in the system browser; the GUI itself never needs popups.
    if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
      shell.openExternal(targetUrl)
    }
    return { action: 'deny' }
  })

  mainWindow.on('page-title-updated', (event) => {
    // Keep our own window title instead of the page's.
    event.preventDefault()
  })

  mainWindow.on('closed', () => {
    debug('window closed')
    mainWindow = null
  })
  mainWindow.webContents.on('did-fail-load', (event, code, desc, validatedURL) => {
    debug('did-fail-load', code, desc, validatedURL)
  })
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    debug('render-process-gone', JSON.stringify(details))
    // A crashed renderer should never take the whole app (and backend) down.
    // Reload the GUI in a fresh render process instead.
    if (details.reason === 'crashed' || details.reason === 'oom') {
      debug('reloading window after renderer crash')
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload()
    }
  })

  mainWindow.loadURL(url)
  return mainWindow
}

// Disable GPU acceleration before the app is ready. On some Windows GPU
// drivers / remote-desktop / VM setups the Chromium compositor crashes the
// render process (observed as `render-process-gone` + backend exit -1); a
// software-composited renderer is far more robust and costs nothing for this
// UI's workload.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-gpu')

// ── lifecycle ────────────────────────────────────────────────────────────────

// Single instance: a second launch focuses the existing window instead of
// starting a second backend (which would fight over the port).
const gotLock = app.requestSingleInstanceLock()
debug('requestSingleInstanceLock ->', gotLock)
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    debug('app.whenReady fired')
    try {
      // 1. Prefer the configured port if it is already a healthy dsh web GUI —
      //    reuse it (e.g. a browser instance is already serving 3080).
      let url
      let reused = false
      if (DEFAULT_PORT > 0 && await isDshWeb(DEFAULT_PORT)) {
        backendPort = DEFAULT_PORT
        reused = true
        debug('reusing existing dsh web on port', DEFAULT_PORT)
      } else {
        // 2. Otherwise boot our own backend. If the preferred port is taken by
        //    something else (not dsh), let the OS pick a free one.
        const prefer = DEFAULT_PORT > 0 && !(await portInUse(DEFAULT_PORT)) ? DEFAULT_PORT : 0
        debug('starting backend, preferPort=', prefer)
        const port = await startBackend(prefer)
        debug('backend ready on port', port)
        url = `http://127.0.0.1:${port}`
      }
      if (reused) url = `http://127.0.0.1:${DEFAULT_PORT}`

      debug('creating window for', url)
      createWindow(url)
    } catch (error) {
      debug('startup failed:', error?.stack || error)
      dialog.showErrorBox('DSH Launcher — failed to start', String(error?.stack || error))
      app.quit()
    }
  })

  app.on('window-all-closed', () => {
    debug('window-all-closed')
    // Quit even on macOS: this app exists to host a backend process.
    app.quit()
  })

  app.on('before-quit', () => {
    debug('before-quit')
    isQuitting = true
    if (backendChild && !backendChild.killed) {
      // Graceful SIGTERM on POSIX (dsh shuts down cleanly); on Windows
      // child.kill() terminates the process tree via taskkill semantics in
      // recent Node, and dsh's own SIGINT handler covers Ctrl-C paths.
      backendChild.kill()
    }
  })
}
