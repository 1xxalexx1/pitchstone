const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')

let mainWindow = null
let vaultRoot = null

const EMPTY_NOTE =
  '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n</head>\n<body>\n</body>\n</html>\n'

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

function storePath() {
  return path.join(app.getPath('userData'), 'vault.json')
}

async function persistVaultRoot() {
  if (!vaultRoot) return
  await fs.promises.writeFile(
    storePath(),
    JSON.stringify({ vaultRoot }),
    'utf8'
  )
}

async function loadVaultRoot() {
  try {
    const data = JSON.parse(await fs.promises.readFile(storePath(), 'utf8'))
    const dir = data.vaultRoot
    if (!dir) return
    const stat = await fs.promises.stat(dir)
    if (stat.isDirectory()) vaultRoot = dir
  } catch {
    /* no saved vault, or path gone */
  }
}

function htmlNoteName(input) {
  const base = path.basename(String(input || '').trim())
  if (!base || base === '.' || base === '..') return null
  if (base.includes('/') || base.includes('\\')) return null
  const stem = base.replace(/\.[^.]+$/, '')
  if (!stem) return null
  return stem + '.html'
}

app.whenReady().then(async () => {
  await loadVaultRoot()
  createWindow()
})

ipcMain.handle('select-vault', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open vault',
    properties: ['openDirectory'],
  })
  if (result.canceled || !result.filePaths[0]) return null
  vaultRoot = result.filePaths[0]
  await persistVaultRoot()
  return vaultRoot
})

ipcMain.handle('get-vault', async () => vaultRoot)

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

ipcMain.handle('create-file', async (_event, name) => {
  if (!vaultRoot) return { error: 'No vault open.' }
  const fileName = htmlNoteName(name)
  if (!fileName) return { error: 'Invalid name.' }
  const target = resolveInVault(path.join(vaultRoot, fileName))
  if (!target) return { error: 'Path is outside the vault.' }
  try {
    await fs.promises.writeFile(target, EMPTY_NOTE, { encoding: 'utf8', flag: 'wx' })
    return { path: target, name: fileName }
  } catch (err) {
    if (err.code === 'EEXIST') return { error: 'Already exists.' }
    return { error: err.message }
  }
})

ipcMain.handle('rename-file', async (_event, filePath, name) => {
  const from = resolveInVault(filePath)
  const fileName = htmlNoteName(name)
  if (!from || !fileName) return { error: 'Invalid name.' }
  const to = resolveInVault(path.join(vaultRoot, fileName))
  if (!to) return { error: 'Path is outside the vault.' }
  if (from === to) return { path: to, name: fileName }
  try {
    await fs.promises.access(to)
    return { error: 'Already exists.' }
  } catch {
    /* dest free */
  }
  try {
    await fs.promises.rename(from, to)
    return { path: to, name: fileName }
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('delete-file', async (_event, filePath) => {
  const resolved = resolveInVault(filePath)
  if (!resolved) return { error: 'Path is outside the vault.' }
  try {
    const stat = await fs.promises.stat(resolved)
    if (stat.isDirectory()) return { error: 'Not a file.' }
    await fs.promises.unlink(resolved)
    return { ok: true }
  } catch (err) {
    return { error: err.message }
  }
})
