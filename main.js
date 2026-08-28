const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const scan = require('./vault-scan')

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

function dirName(input) {
  const base = path.basename(String(input || '').trim())
  if (!base || base === '.' || base === '..') return null
  if (base.includes('/') || base.includes('\\')) return null
  if (base.startsWith('.')) return null
  return base
}

function inside(parent, child) {
  return child === parent || child.startsWith(parent + path.sep)
}

async function listTree(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true })
  const items = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isSymbolicLink()) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      items.push({
        name: entry.name,
        path: full,
        isDir: true,
        children: await listTree(full),
      })
    } else if (entry.isFile()) {
      items.push({ name: entry.name, path: full, isDir: false })
    }
  }
  items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return items
}

async function parentDir(dirPath) {
  if (!dirPath) return vaultRoot
  const resolved = resolveInVault(dirPath)
  if (!resolved) return null
  try {
    const stat = await fs.promises.stat(resolved)
    if (!stat.isDirectory()) return null
    return resolved
  } catch {
    return null
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
  try {
    return { items: await listTree(vaultRoot) }
  } catch (err) {
    return { error: err.message }
  }
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

ipcMain.handle('create-file', async (_event, name, dirPath) => {
  if (!vaultRoot) return { error: 'No vault open.' }
  const fileName = htmlNoteName(name)
  if (!fileName) return { error: 'Invalid name.' }
  const parent = await parentDir(dirPath)
  if (!parent) return { error: 'Path is outside the vault.' }
  const target = resolveInVault(path.join(parent, fileName))
  if (!target) return { error: 'Path is outside the vault.' }
  try {
    await fs.promises.writeFile(target, EMPTY_NOTE, { encoding: 'utf8', flag: 'wx' })
    return { path: target, name: fileName }
  } catch (err) {
    if (err.code === 'EEXIST') return { error: 'Already exists.' }
    return { error: err.message }
  }
})

ipcMain.handle('create-dir', async (_event, name, dirPath) => {
  if (!vaultRoot) return { error: 'No vault open.' }
  const folderName = dirName(name)
  if (!folderName) return { error: 'Invalid name.' }
  const parent = await parentDir(dirPath)
  if (!parent) return { error: 'Path is outside the vault.' }
  const target = resolveInVault(path.join(parent, folderName))
  if (!target) return { error: 'Path is outside the vault.' }
  try {
    await fs.promises.mkdir(target)
    return { path: target, name: folderName }
  } catch (err) {
    if (err.code === 'EEXIST') {
      try {
        const stat = await fs.promises.stat(target)
        if (stat.isDirectory()) return { path: target, name: folderName }
      } catch {
        /* fall through */
      }
      return { error: 'Already exists.' }
    }
    return { error: err.message }
  }
})

ipcMain.handle('rename-file', async (_event, filePath, name) => {
  const from = resolveInVault(filePath)
  if (!from || from === path.resolve(vaultRoot)) return { error: 'Invalid name.' }
  let stat
  try {
    stat = await fs.promises.stat(from)
  } catch (err) {
    return { error: err.message }
  }
  const newName = stat.isDirectory() ? dirName(name) : htmlNoteName(name)
  if (!newName) return { error: 'Invalid name.' }
  const to = resolveInVault(path.join(path.dirname(from), newName))
  if (!to) return { error: 'Path is outside the vault.' }
  if (from === to) return { path: to, name: newName }
  try {
    await fs.promises.access(to)
    return { error: 'Already exists.' }
  } catch {
    /* dest free */
  }
  try {
    await fs.promises.rename(from, to)
    return { path: to, name: newName }
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('move-file', async (_event, filePath, dirPath) => {
  const from = resolveInVault(filePath)
  const destDir = await parentDir(dirPath)
  if (!from || !destDir || from === path.resolve(vaultRoot)) {
    return { error: 'Path is outside the vault.' }
  }
  const to = resolveInVault(path.join(destDir, path.basename(from)))
  if (!to) return { error: 'Path is outside the vault.' }
  if (from === to) return { path: to }
  if (inside(from, to)) return { error: 'Cannot move a folder into itself.' }
  try {
    await fs.promises.access(to)
    return { error: 'Already exists.' }
  } catch {
    /* dest free */
  }
  try {
    await fs.promises.rename(from, to)
    return { path: to }
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('delete-file', async (_event, filePath) => {
  const resolved = resolveInVault(filePath)
  if (!resolved || resolved === path.resolve(vaultRoot)) {
    return { error: 'Path is outside the vault.' }
  }
  try {
    const stat = await fs.promises.stat(resolved)
    if (stat.isDirectory()) await fs.promises.rm(resolved, { recursive: true })
    else await fs.promises.unlink(resolved)
    return { ok: true }
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('scan-wikilinks', async () => {
  if (!vaultRoot) return { items: [] }
  try {
    const files = []
    scan.flattenFiles(await listTree(vaultRoot), '', files)
    const seen = {}
    const items = []
    for (const file of files) {
      const text = await fs.promises.readFile(file.path, 'utf8')
      for (const target of scan.extractWikiTargets(text)) {
        if (scan.matchWikiFile(target, files) || seen[target]) continue
        seen[target] = true
        items.push(target)
      }
    }
    items.sort((a, b) => a.localeCompare(b))
    return { items }
  } catch (err) {
    return { error: err.message, items: [] }
  }
})

ipcMain.handle('search-vault', async (_event, rawQuery) => {
  const query = String(rawQuery || '').slice(0, 200).trim()
  if (!vaultRoot) return { error: 'No vault open.', notes: [], hits: [], headings: [] }
  if (!query) return { notes: [], hits: [], headings: [] }
  const needle = query.toLowerCase()
  try {
    const files = []
      scan.flattenFiles(await listTree(vaultRoot), '', files)
    const notes = []
    const hits = []
    const headings = []
    for (const file of files) {
      const folder = file.rel.includes('/')
        ? file.rel.slice(0, file.rel.lastIndexOf('/'))
        : ''
      const nameHit =
        file.stem.toLowerCase().includes(needle) ||
        file.rel.toLowerCase().includes(needle)
      if (nameHit && notes.length < 40) {
        notes.push({
          path: file.path,
          rel: file.rel,
          stem: file.stem,
          folder,
        })
      }
      let st
      try {
        st = await fs.promises.stat(file.path)
      } catch {
        continue
      }
      if (st.size > 1024 * 1024) continue
      const text = await fs.promises.readFile(file.path, 'utf8')
      const lines = text.split('\n')
      let n = 0
      for (let i = 0; i < lines.length && n < 3 && hits.length < 40; i++) {
        if (!lines[i].toLowerCase().includes(needle)) continue
        hits.push({
          path: file.path,
          rel: file.rel,
          stem: file.stem,
          folder,
          line: i + 1,
          preview: scan.previewLine(lines[i]),
        })
        n += 1
      }
      if (headings.length < 40) {
        for (const h of scan.extractHeadings(text)) {
          if (!h.text.toLowerCase().includes(needle)) continue
          headings.push({
            path: file.path,
            rel: file.rel,
            stem: file.stem,
            folder,
            text: h.text,
            level: h.level,
          })
          if (headings.length >= 40) break
        }
      }
    }
    return { notes, hits, headings }
  } catch (err) {
    return { error: err.message, notes: [], hits: [], headings: [] }
  }
})

ipcMain.handle('export-markdown', async (_event, content, suggestedName) => {
  const stem =
    path.basename(String(suggestedName || 'untitled')).replace(/\.[^.]+$/, '') ||
    'untitled'
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Markdown',
    defaultPath: path.join(vaultRoot || app.getPath('documents'), stem + '.md'),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  try {
    await fs.promises.writeFile(result.filePath, String(content ?? ''), 'utf8')
    return { ok: true }
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('note-context', async (_event, filePath) => {
  if (!vaultRoot || !filePath) return scan.emptyContext()
  const resolved = resolveInVault(filePath)
  if (!resolved) return scan.emptyContext()
  try {
    const files = []
    scan.flattenFiles(await listTree(vaultRoot), '', files)
    for (const file of files) {
      try {
        const st = await fs.promises.stat(file.path)
        file.text = st.size > 1024 * 1024 ? '' : await fs.promises.readFile(file.path, 'utf8')
      } catch {
        file.text = ''
      }
    }
    return scan.noteContext(resolved, files)
  } catch (err) {
    return Object.assign(scan.emptyContext(), { error: err.message })
  }
})
