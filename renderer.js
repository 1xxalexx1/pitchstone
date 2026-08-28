let currentPath = null
const editor = document.getElementById('editor')
const preview = document.getElementById('preview')
const PREVIEW_DELAY_MS = 100
const SAVE_DELAY_MS = 800
const PREVIEW_CSS =
  'html,body{margin:0}' +
  'body{padding:12px 16px;font:15px/1.45 ui-sans-serif,system-ui,sans-serif;' +
  'color:#d8d2c8;background:#1e1c19}' +
  'a{color:#e08a58}' +
  'code,pre{font-family:ui-monospace,Menlo,Consolas,monospace;background:#2a2723}' +
  'pre{padding:8px;overflow:auto}' +
  'img{max-width:100%}'
const TAB_LABELS = {
  markdown: 'Markdown',
  html: 'HTML',
  cssjs: 'CSS+JS',
}
const TAB_MODES = {
  markdown: 'markdown',
  html: 'htmlmixed',
  cssjs: 'cssjs',
}
const TAB_PLACEHOLDERS = {
  markdown: '',
  html: '',
  cssjs: '/* CSS */\n\n---js---\n\n// JS',
}
const SKIP_TAGS = {
  html: true,
  head: true,
  body: true,
  script: true,
  style: true,
  link: true,
  meta: true,
  title: true,
  noscript: true,
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
})

CodeMirror.defineMode('cssjs', (config) =>
  CodeMirror.multiplexingMode(CodeMirror.getMode(config, 'css'), {
    open: '---js---',
    close: '\u0000',
    mode: CodeMirror.getMode(config, 'javascript'),
    delimStyle: 'delimit',
  })
)

let previewTimer = null
let saveTimer = null
let dirty = false
let applyingTab = false
let activeTab = 'markdown'
let lastBody = 'markdown'
const buffers = {
  markdown: '',
  html: '',
  cssjs: '',
}

const cm = CodeMirror.fromTextArea(editor, {
  lineNumbers: true,
  theme: 'material-darker',
  tabSize: 2,
  indentUnit: 2,
  lineWrapping: true,
  matchBrackets: true,
  autoCloseBrackets: true,
  autoCloseTags: true,
  mode: 'markdown',
  placeholder: TAB_PLACEHOLDERS.markdown,
  gutters: ['CodeMirror-linenumbers', 'CodeMirror-lint-markers'],
  lint: { getAnnotations: lintBuffer, async: false },
  extraKeys: {
    'Ctrl-Space': 'autocomplete',
    'Alt-Space': 'autocomplete',
    'Ctrl-S': () => {
      void saveFile()
    },
    'Cmd-S': () => {
      void saveFile()
    },
  },
  hintOptions: { hint: tabHint, completeSingle: false },
})

function tabHint(instance, options) {
  const mode = instance.getOption('mode')
  if (mode === 'htmlmixed') return CodeMirror.hint.html(instance, options)
  if (mode === 'markdown') return CodeMirror.hint.anyword(instance, options)
  if (mode === 'cssjs') {
    const cursor = instance.getCursor()
    const before = instance.getRange({ line: 0, ch: 0 }, cursor)
    if (before.indexOf('---js---') !== -1) {
      return CodeMirror.hint.javascript(instance, options)
    }
    return CodeMirror.hint.css(instance, options)
  }
  return CodeMirror.hint.anyword(instance, options)
}

function jsSyntaxNotes(text) {
  if (!text.trim()) return []
  try {
    new Function(text)
    return []
  } catch (err) {
    const first = text.split('\n')[0] || ' '
    return [
      {
        from: CodeMirror.Pos(0, 0),
        to: CodeMirror.Pos(0, Math.max(1, first.length)),
        message: err.message,
        severity: 'error',
      },
    ]
  }
}

function lintBuffer(text) {
  if (activeTab === 'cssjs') return jsSyntaxNotes(splitCssJs(text).js)
  if (activeTab === 'html') {
    const doc = new DOMParser().parseFromString(text, 'text/html')
    const err = doc.querySelector('parsererror')
    if (!err) return []
    return [
      {
        from: CodeMirror.Pos(0, 0),
        to: CodeMirror.Pos(0, 1),
        message: err.textContent.trim(),
        severity: 'error',
      },
    ]
  }
  return []
}

function splitCssJs(raw) {
  const marker = '\n---js---\n'
  const index = raw.indexOf(marker)
  if (index === -1) return { css: raw, js: '' }
  return {
    css: raw.slice(0, index),
    js: raw.slice(index + marker.length),
  }
}

function htmlFromMarkdown(md) {
  if (!md.trim()) return ''
  const parsed = marked.parse(md)
  const doc = new DOMParser().parseFromString(parsed, 'text/html')
  const blocks = Array.from(doc.body.children)
  if (blocks.length) return blocks.map((el) => el.outerHTML).join('\n')
  return doc.body.innerHTML.trim()
}

function selectorsFromHtml(html) {
  if (!html.trim()) return []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const seen = {}
  const list = []
  function add(sel) {
    if (seen[sel]) return
    seen[sel] = true
    list.push(sel)
  }
  for (const el of doc.body.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase()
    if (!SKIP_TAGS[tag]) add(tag)
    for (const cls of el.classList) add('.' + cls)
    if (el.id) add('#' + el.id)
  }
  return list
}

function cssHasSelector(css, sel) {
  const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('(?:^|[}\\s])' + escaped + '\\s*\\{').test('\n' + css)
}

function mergeCssRules(css, selectors) {
  let out = css.trimEnd()
  for (const sel of selectors) {
    if (cssHasSelector(out, sel)) continue
    if (out) out += '\n\n'
    out += sel + ' {\n  \n}'
  }
  return out ? out + '\n' : ''
}

function syncCssFromHtml(html) {
  const raw = buffers.cssjs
  const parts = splitCssJs(raw)
  const css = mergeCssRules(parts.css, selectorsFromHtml(html))
  const hadJs = raw.indexOf('\n---js---\n') !== -1
  buffers.cssjs = hadJs
    ? css.replace(/\n*$/, '') + '\n---js---\n' + parts.js
    : css
}

function syncFromMarkdown() {
  buffers.html = htmlFromMarkdown(buffers.markdown)
  syncCssFromHtml(buffers.html)
}

function bodyHtml() {
  return buffers.html.trim() ? buffers.html : marked.parse(buffers.markdown)
}

function looksLikeHtmlNote(raw) {
  const text = raw.trim()
  if (/^<!DOCTYPE html/i.test(text) || /^<html[\s>]/i.test(text)) return 'document'
  if (/^<[a-zA-Z!]/.test(text)) return 'fragment'
  return 'markdown'
}

function loadNote(raw) {
  if (looksLikeHtmlNote(raw) === 'markdown') {
    buffers.markdown = raw
    lastBody = 'markdown'
    syncFromMarkdown()
    return
  }
  const doc = new DOMParser().parseFromString(raw, 'text/html')
  const css = Array.from(doc.querySelectorAll('style'))
    .map((el) => el.textContent)
    .join('\n\n')
    .trim()
  const js = Array.from(doc.querySelectorAll('script'))
    .filter((el) => !el.getAttribute('src'))
    .map((el) => el.textContent)
    .join('\n\n')
    .trim()
  const body = doc.body.cloneNode(true)
  body.querySelectorAll('script, style').forEach((el) => el.remove())
  buffers.html = body.innerHTML.trim()
  buffers.cssjs = js ? css + '\n---js---\n' + js : css ? css + '\n' : ''
  buffers.markdown = buffers.html ? turndown.turndown(buffers.html) : ''
  lastBody = 'html'
}

function syncOpenBuffers() {
  buffers[activeTab] = cm.getValue()
  if (activeTab === 'markdown') syncFromMarkdown()
  else if (activeTab === 'html') syncCssFromHtml(buffers.html)
}

function noteToHtmlFile() {
  syncOpenBuffers()
  const parts = splitCssJs(buffers.cssjs)
  const css = parts.css.trim()
  const js = parts.js.trim()
  const body = bodyHtml()
  let head = '<meta charset="utf-8">'
  if (css) head += '\n<style>\n' + css + '\n</style>'
  let out =
    '<!DOCTYPE html>\n<html>\n<head>\n' +
    head +
    '\n</head>\n<body>\n' +
    body
  if (js) out += '\n<script>\n' + js + '\n</script>'
  return out + '\n</body>\n</html>\n'
}

function updatePreview() {
  buffers[activeTab] = cm.getValue()
  const parts = splitCssJs(buffers.cssjs)
  preview.srcdoc =
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    PREVIEW_CSS +
    '</style><style>' +
    parts.css +
    '</style></head><body>' +
    bodyHtml() +
    '<script>' +
    parts.js +
    '</script></body></html>'
}

function schedulePreview() {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(updatePreview, PREVIEW_DELAY_MS)
}

function applyTabChrome(name) {
  editor.setAttribute('aria-label', TAB_LABELS[name])
  cm.setOption('mode', TAB_MODES[name])
  cm.setOption('placeholder', TAB_PLACEHOLDERS[name])
  for (const button of document.querySelectorAll('#tabs [data-tab]')) {
    button.setAttribute(
      'aria-selected',
      button.dataset.tab === name ? 'true' : 'false'
    )
  }
}

function showTab(name) {
  applyingTab = true
  activeTab = name
  cm.setValue(buffers[name])
  applyingTab = false
  applyTabChrome(name)
  updatePreview()
  requestAnimationFrame(() => {
    cm.refresh()
    if (cm.performLint) cm.performLint()
  })
}

function setTab(name) {
  if (name === activeTab) return
  buffers[activeTab] = cm.getValue()
  if (activeTab === 'markdown') syncFromMarkdown()
  if (activeTab === 'html') {
    lastBody = 'html'
    syncCssFromHtml(buffers.html)
  }
  if (name === 'markdown' && lastBody === 'html' && buffers.html.trim()) {
    buffers.markdown = turndown.turndown(buffers.html)
  }
  if (name === 'html' && lastBody === 'markdown') syncFromMarkdown()
  if (name === 'cssjs') syncCssFromHtml(bodyHtml())
  if (name === 'markdown' || name === 'html') lastBody = name
  showTab(name)
}

cm.on('change', () => {
  if (applyingTab) return
  buffers[activeTab] = cm.getValue()
  if (activeTab === 'markdown') {
    lastBody = 'markdown'
    syncFromMarkdown()
  } else if (activeTab === 'html') {
    lastBody = 'html'
    syncCssFromHtml(buffers.html)
  }
  schedulePreview()
  markDirty()
})

cm.on('inputRead', (instance, change) => {
  if (change.origin !== '+input' || applyingTab) return
  const typed = change.text[0]
  if (!typed || typed.length !== 1 || !/[\w.#@<$-]/.test(typed)) return
  if (!CodeMirror.commands.autocomplete) return
  CodeMirror.commands.autocomplete(instance)
})

function setStatus(text) {
  document.getElementById('status').textContent = text
}

function markDirty() {
  if (!currentPath) return
  dirty = true
  setStatus('Unsaved')
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void saveFile()
  }, SAVE_DELAY_MS)
}

async function refreshFiles() {
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
    if (item.isDir) {
      list.appendChild(li)
      continue
    }
    li.style.cursor = 'pointer'
    if (item.path === currentPath) li.setAttribute('aria-current', 'true')
    li.addEventListener('click', () => {
      void openListedFile(item)
    })
    list.appendChild(li)
  }
}

async function openListedFile(item) {
  const file = await window.api.readFile(item.path)
  if (file.error) {
    buffers.markdown = file.error
    currentPath = null
    lastBody = 'markdown'
    dirty = false
    syncFromMarkdown()
    showTab('markdown')
    setStatus(file.error)
    return
  }
  currentPath = item.path
  dirty = false
  clearTimeout(saveTimer)
  loadNote(file.content)
  showTab('markdown')
  setStatus('Saved')
  await refreshFiles()
}

async function showVault(folder) {
  currentPath = null
  dirty = false
  clearTimeout(saveTimer)
  buffers.markdown = ''
  buffers.html = ''
  buffers.cssjs = ''
  lastBody = 'markdown'
  showTab('markdown')
  document.getElementById('path').textContent = folder
  setStatus('')
  await refreshFiles()
}

document.getElementById('tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-tab]')
  if (!button) return
  setTab(button.dataset.tab)
})

function askName(label, initial) {
  return new Promise((resolve) => {
    const dialog = document.getElementById('name-dialog')
    const input = document.getElementById('name-dialog-input')
    document.getElementById('name-dialog-label').textContent = label
    input.value = initial || ''
    function done() {
      dialog.removeEventListener('close', done)
      resolve(dialog.returnValue === 'ok' ? input.value : null)
    }
    dialog.addEventListener('close', done)
    dialog.showModal()
    input.focus()
    input.select()
  })
}

function askConfirm(message) {
  return new Promise((resolve) => {
    const dialog = document.getElementById('confirm-dialog')
    document.getElementById('confirm-dialog-text').textContent = message
    function done() {
      dialog.removeEventListener('close', done)
      resolve(dialog.returnValue === 'ok')
    }
    dialog.addEventListener('close', done)
    dialog.showModal()
  })
}

document.getElementById('open').addEventListener('click', async () => {
  const folder = await window.api.selectVault()
  if (!folder) return
  await showVault(folder)
})

document.getElementById('new-file').addEventListener('click', async () => {
  const folder = await window.api.getVault()
  if (!folder) {
    setStatus('Open a vault first.')
    return
  }
  const name = await askName('Note name')
  if (name == null || !name.trim()) return
  const result = await window.api.createFile(name)
  if (result.error) {
    setStatus(result.error)
    return
  }
  currentPath = result.path
  dirty = false
  loadNote(
    '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n</head>\n<body>\n</body>\n</html>\n'
  )
  showTab('markdown')
  setStatus('Saved')
  await refreshFiles()
})

document.getElementById('rename-file').addEventListener('click', async () => {
  if (!currentPath) {
    setStatus('Open a file first.')
    return
  }
  const currentName = currentPath.split(/[/\\]/).pop().replace(/\.html$/i, '')
  const name = await askName('Rename to', currentName)
  if (name == null || !name.trim()) return
  const result = await window.api.renameFile(currentPath, name)
  if (result.error) {
    setStatus(result.error)
    return
  }
  currentPath = result.path
  setStatus('Saved')
  await refreshFiles()
})

document.getElementById('delete-file').addEventListener('click', async () => {
  if (!currentPath) {
    setStatus('Open a file first.')
    return
  }
  if (!(await askConfirm('Delete this note?'))) return
  const result = await window.api.deleteFile(currentPath)
  if (result.error) {
    setStatus(result.error)
    return
  }
  currentPath = null
  dirty = false
  clearTimeout(saveTimer)
  buffers.markdown = ''
  buffers.html = ''
  buffers.cssjs = ''
  lastBody = 'markdown'
  showTab('markdown')
  setStatus('Deleted')
  await refreshFiles()
})

async function saveFile() {
  if (!currentPath) {
    setStatus('Open a file first.')
    return
  }
  setStatus('Saving')
  const result = await window.api.writeFile(currentPath, noteToHtmlFile())
  if (result.error) {
    dirty = true
    setStatus(result.error)
    return
  }
  dirty = false
  setStatus('Saved')
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

void (async () => {
  const folder = await window.api.getVault()
  if (folder) await showVault(folder)
})()

updatePreview()
requestAnimationFrame(() => cm.refresh())
