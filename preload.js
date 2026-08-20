/**
 * DSH Launcher — preload script.
 *
 * The GUI runs fully sandboxed with nodeIntegration off; this preload only
 * exposes read-only runtime facts to the renderer (used by the status bar / title).
 * No privileged APIs are exposed.
 *
 * @module dsh-launcher/preload
 */

const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('dshDesktop', {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  platform: process.platform,
})
