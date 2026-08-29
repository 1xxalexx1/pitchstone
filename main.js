const { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme } = require('electron')
const path = require('path')
const fs = require('fs')
const scan = require('./vault-scan')
const agent = require('./agent-bridge')

let mainWindow = null
let vaultRoot = null
let acpHost = null
let permUi = null

const EMPTY_NOTE =
  '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n</head>\n<body>\n</body>\n</html>\n'

const TITLEBAR_HEIGHT = 40
const TITLEBAR_COLOR = '#01000000'
const TITLEBAR_LIGHT_SYMBOL = '#1f2937'
const TITLEBAR_DARK_SYMBOL = '#f8fafc'

function windowBg() {
  return nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff'
}

function titleBarOpts() {
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 18 },
    }
  }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: TITLEBAR_COLOR,
      height: TITLEBAR_HEIGHT,
      symbolColor: nativeTheme.shouldUseDarkColors
        ? TITLEBAR_DARK_SYMBOL
        : TITLEBAR_LIGHT_SYMBOL,
    },
  }
}

function syncAppearance() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.setBackgroundColor(windowBg())
  const overlay = titleBarOpts().titleBarOverlay
  if (!overlay) return
  try {
    mainWindow.setTitleBarOverlay(overlay)
  } catch (_) {
    /* overlay unsupported on this build */
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 840,
    minHeight: 620,
    title: 'Pitchstone',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: windowBg(),
    ...(process.platform === 'darwin' ? { disableAutoHideCursor: true } : {}),
    ...titleBarOpts(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.once('ready-to-show', () => {
    if (!mainWindow.isDestroyed()) mainWindow.show()
  })
  mainWindow.on('enter-full-screen', () => {
    mainWindow.webContents.send('win-fullscreen', true)
  })
  mainWindow.on('leave-full-screen', () => {
    mainWindow.webContents.send('win-fullscreen', false)
  })
  mainWindow.loadFile(path.join(__dirname, 'index.html'), {
    query: { p: process.platform },
  })
}

function sendMenu(id) {
  if (mainWindow) mainWindow.webContents.send('menu-action', id)
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Vault…',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendMenu('open'),
        },
        { type: 'separator' },
        {
          label: 'New Note',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendMenu('new'),
        },
        { label: 'New Folder', click: () => sendMenu('folder') },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => sendMenu('save'),
        },
        { label: 'Export Markdown…', click: () => sendMenu('export') },
        { type: 'separator' },
        { label: 'Rename…', click: () => sendMenu('rename') },
        { label: 'Delete…', click: () => sendMenu('delete') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Vault Shell', click: () => sendMenu('shell-vault') },
        { label: 'Code Shell', click: () => sendMenu('shell-ide') },
        { type: 'separator' },
        {
          label: 'Search',
          accelerator: 'CmdOrCtrl+K',
          click: () => sendMenu('search'),
        },
        { label: 'Files', click: () => sendMenu('files') },
        { label: 'Graph', click: () => sendMenu('graph') },
        { label: 'Agent', click: () => sendMenu('agent') },
        { type: 'separator' },
        { label: 'Toggle Theme', click: () => sendMenu('theme') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  return Menu.buildFromTemplate(template)
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

function agentStorePath() {
  return path.join(app.getPath('userData'), 'agent.json')
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
  app.setName('Pitchstone')
  Menu.setApplicationMenu(buildMenu())
  await loadVaultRoot()
  createWindow()
})

ipcMain.handle('set-dark', (_event, dark) => {
  nativeTheme.themeSource = dark ? 'dark' : 'light'
  syncAppearance()
})

nativeTheme.on('updated', () => {
  syncAppearance()
})

ipcMain.handle('select-vault', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open vault',
    properties: ['openDirectory'],
  })
  if (result.canceled || !result.filePaths[0]) return null
  vaultRoot = result.filePaths[0]
  dropAgent()
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

ipcMain.handle('agent-config-get', async () => {
  try {
    const cfg = JSON.parse(await fs.promises.readFile(agentStorePath(), 'utf8'))
    if (cfg.kind === 'stdio') cfg.kind = 'acp'
    return cfg
  } catch {
    return { kind: 'acp', target: '' }
  }
})

ipcMain.handle('agent-config-set', async (_event, cfg) => {
  const kind = String((cfg && cfg.kind) || 'acp')
  const target = String((cfg && cfg.target) || '')
  const next = { kind, target }
  const prev = await readAgentCfg()
  await fs.promises.writeFile(agentStorePath(), JSON.stringify(next), 'utf8')
  if (prev.kind !== next.kind || prev.target !== next.target) dropAgent()
  return next
})

function emitAgent(event) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('agent-event', event)
  }
}

function dropAgent() {
  if (permUi) {
    permUi({ cancelled: true })
    permUi = null
  }
  if (acpHost) {
    acpHost.dispose()
    acpHost = null
  }
}

async function readAgentCfg() {
  try {
    const cfg = JSON.parse(await fs.promises.readFile(agentStorePath(), 'utf8'))
    if (cfg.kind === 'stdio') cfg.kind = 'acp'
    return cfg
  } catch {
    return { kind: 'acp', target: '' }
  }
}

function vaultFile(filePath) {
  if (!filePath) return null
  if (path.isAbsolute(filePath)) return resolveInVault(filePath)
  if (!vaultRoot) return null
  return resolveInVault(path.join(vaultRoot, filePath))
}

function makeAcpHost(cfg) {
  const resolved = agent.resolveKind(cfg.kind, cfg.target)
  return new agent.AcpHost({
    command: resolved.target,
    cwd: vaultRoot,
    readFile: async (filePath) => {
      const target = vaultFile(filePath)
      if (!target) throw new Error('Path is outside the vault.')
      const st = await fs.promises.stat(target)
      if (st.size > 1024 * 1024) throw new Error('File too large.')
      return fs.promises.readFile(target, 'utf8')
    },
    writeFile: async (filePath, content) => {
      const target = vaultFile(filePath)
      if (!target) throw new Error('Path is outside the vault.')
      if (Buffer.byteLength(String(content), 'utf8') > 2 * 1024 * 1024) {
        throw new Error('Write too large.')
      }
      await fs.promises.writeFile(target, content, 'utf8')
    },
    askPermission: (payload) =>
      new Promise((resolve) => {
        permUi = resolve
        emitAgent({ type: 'permission', title: payload.title, options: payload.options })
      }),
    onEvent: emitAgent,
  })
}

function clipNote(payload) {
  if (!payload || !payload.note) return null
  const filePath = vaultFile(payload.note.path)
  if (!filePath) return null
  return {
    path: filePath,
    html: String(payload.note.html || '').slice(0, 200000),
  }
}

ipcMain.handle('agent-start', async () => {
  if (!vaultRoot) return { error: 'Open a vault first.' }
  const cfg = await readAgentCfg()
  const resolved = agent.resolveKind(cfg.kind, cfg.target)
  if (resolved.kind !== 'acp') return { error: 'Start is for ACP agents.' }
  dropAgent()
  acpHost = makeAcpHost(cfg)
  try {
    await acpHost.start()
    return { ok: true, sessionId: acpHost.sessionId }
  } catch (err) {
    dropAgent()
    return { error: err.message }
  }
})

ipcMain.handle('agent-stop', async () => {
  dropAgent()
  emitAgent({ type: 'status', status: 'idle', text: 'stopped' })
  return { ok: true }
})

ipcMain.handle('agent-cancel', async () => {
  if (acpHost) acpHost.cancel()
  return { ok: true }
})

ipcMain.handle('agent-permission', async (_event, choice) => {
  if (permUi) {
    permUi(choice && choice.optionId ? choice : { cancelled: true })
    permUi = null
  }
  return { ok: true }
})

ipcMain.handle('agent-prompt', async (_event, payload) => {
  if (!vaultRoot) return { error: 'Open a vault first.' }
  const cfg = await readAgentCfg()
  const resolved = agent.resolveKind(cfg.kind, cfg.target)
  const message = String((payload && payload.message) || '').trim()
  if (!message) return { error: 'Empty message.' }
  const note = clipNote(payload)
  if (resolved.kind !== 'acp') {
    try {
      const reply = await agent.runAgent(
        { kind: resolved.kind, target: resolved.target },
        { pitchstone: 1, message, note },
        vaultRoot
      )
      const edits = []
      for (const item of reply.edits || []) {
        const target = vaultFile(item.path)
        if (!target) continue
        edits.push({
          path: target,
          rel: path.relative(vaultRoot, target).replace(/\\/g, '/'),
          html: item.html,
        })
      }
      return { mode: 'json', text: reply.text || '', edits }
    } catch (err) {
      return { error: err.message }
    }
  }
  if (!acpHost || !acpHost.alive) {
    dropAgent()
    acpHost = makeAcpHost(cfg)
    try {
      await acpHost.start()
    } catch (err) {
      dropAgent()
      return { error: err.message }
    }
  }
  try {
    await acpHost.prompt(agent.promptBlocks(message, note))
    return { mode: 'acp', ok: true }
  } catch (err) {
    return { error: err.message }
  }
})
