let currentPath = null
const editor = document.getElementById('editor')
const preview = document.getElementById('preview')
const PREVIEW_DELAY_MS = 100
const PREVIEW_CSS =
  'html,body{margin:0}' +
  'body{padding:12px 16px;font:15px/1.45 ui-sans-serif,system-ui,sans-serif;' +
  'color:#d8d2c8;background:#1e1c19}' +
  'a{color:#d4b36a}' +
  'code,pre{font-family:ui-monospace,Menlo,Consolas,monospace;background:#2a2723}' +
  'pre{padding:8px;overflow:auto}' +
  'img{max-width:100%}'

let previewTimer = null

function updatePreview() {
  const html = marked.parse(editor.value)
  preview.srcdoc =
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    PREVIEW_CSS +
    '</style></head><body>' +
    html +
    '</body></html>'
}

function schedulePreview() {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(updatePreview, PREVIEW_DELAY_MS)
}

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
          editor.value = file.error
          currentPath = null
          return
        }
        currentPath = item.path
        editor.value = file.content
        updatePreview()
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
    editor.value
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

editor.addEventListener('input', schedulePreview)
updatePreview()
