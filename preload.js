const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  onMenuAction: (fn) => {
    ipcRenderer.removeAllListeners('menu-action')
    ipcRenderer.on('menu-action', (_event, id) => fn(id))
  },
  selectVault: () => ipcRenderer.invoke('select-vault'),
  getVault: () => ipcRenderer.invoke('get-vault'),
  readDir: () => ipcRenderer.invoke('read-dir'),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  createFile: (name, dirPath) => ipcRenderer.invoke('create-file', name, dirPath),
  createDir: (name, dirPath) => ipcRenderer.invoke('create-dir', name, dirPath),
  renameFile: (filePath, name) => ipcRenderer.invoke('rename-file', filePath, name),
  moveFile: (filePath, dirPath) => ipcRenderer.invoke('move-file', filePath, dirPath),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
  scanWikilinks: () => ipcRenderer.invoke('scan-wikilinks'),
  exportMarkdown: (content, name) =>
    ipcRenderer.invoke('export-markdown', content, name),
  searchVault: (query) => ipcRenderer.invoke('search-vault', query),
  noteContext: (filePath) => ipcRenderer.invoke('note-context', filePath),
  agentConfigGet: () => ipcRenderer.invoke('agent-config-get'),
  agentConfigSet: (cfg) => ipcRenderer.invoke('agent-config-set', cfg),
  agentSend: (payload) => ipcRenderer.invoke('agent-send', payload),
})
