let currentPath = null

document.getElementById('open').addEventListener('click', async () => {
  const folder = await window.api.selectVault()
  if (!folder) return
  currentPath = null
  document.getElementById('path').textContent = folder
  document.getElementById('status').textContent = ''

  const result = await window.api.readDir()
  const list = document.getElementById('files')
  list.replaceChildren()
  if (result.error) {
    list.textContent = result.error
    return
  }
  for (const item of result.items) {
    const li = document.createElement('li')
    li.textContent = item.isDir ? item.name + '/' : item.name
    if (!item.isDir) {
      li.style.cursor = 'pointer'
      li.addEventListener('click', async () => {
        const file = await window.api.readFile(item.path)
        if (file.error) {
          document.getElementById('editor').value = file.error
          currentPath = null
          return
        }
        currentPath = item.path
        document.getElementById('editor').value = file.content
        document.getElementById('status').textContent = item.name
      })
    }
    list.appendChild(li)
  }
})

async function saveFile() {
  if (!currentPath) {
    document.getElementById('status').textContent = 'Open a file first.'
    return
  }
  const result = await window.api.writeFile(
    currentPath,
    document.getElementById('editor').value
  )
  document.getElementById('status').textContent = result.error || 'Saved'
}

document.getElementById('save').addEventListener('click', () => {
  void saveFile()
})

window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    void saveFile()
  }
})
