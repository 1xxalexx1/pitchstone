const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  selectVault: () => ipcRenderer.invoke('select-vault'),
  getVault: () => ipcRenderer.invoke('get-vault'),
  readDir: () => ipcRenderer.invoke('read-dir'),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  createFile: (name) => ipcRenderer.invoke('create-file', name),
  renameFile: (filePath, name) => ipcRenderer.invoke('rename-file', filePath, name),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
})
