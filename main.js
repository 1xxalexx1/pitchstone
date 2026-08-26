const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')

let mainWindow = null
let vaultRoot = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.loadFile(path.join(__dirname, 'index.html'))
}

function resolveInVault(target) {
  if (!vaultRoot || !target) return null
  const root = path.resolve(vaultRoot)
  const resolved = path.resolve(target)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return resolved
}

app.whenReady().then(createWindow)

ipcMain.handle('select-vault', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open vault',
    properties: ['openDirectory'],
  })
  if (result.canceled || !result.filePaths[0]) return null
  vaultRoot = result.filePaths[0]
  return vaultRoot
})

ipcMain.handle('read-dir', async () => {
  if (!vaultRoot) return { error: 'No vault open.' }
  const entries = await fs.promises.readdir(vaultRoot, { withFileTypes: true })
  const items = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    items.push({
      name: entry.name,
      path: path.join(vaultRoot, entry.name),
      isDir: entry.isDirectory(),
    })
  }
  items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return { items }
})

ipcMain.handle('read-file', async (_event, filePath) => {
  const resolved = resolveInVault(filePath)
  if (!resolved) return { error: 'Path is outside the vault.' }
  try {
    const content = await fs.promises.readFile(resolved, 'utf8')
    return { content }
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('write-file', async (_event, filePath, content) => {
  const resolved = resolveInVault(filePath)
  if (!resolved) return { error: 'Path is outside the vault.' }
  try {
    await fs.promises.writeFile(resolved, content, 'utf8')
    return { ok: true }
  } catch (err) {
    return { error: err.message }
  }
})
