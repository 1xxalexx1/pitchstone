let currentPath = null
let vaultFolder = ''
let selectedPath = null
let selectedIsDir = false
let expandedPaths = new Set()
let treeItems = []
let unresolvedTargets = []
let noteCtx = {
  outline: [],
  linked: [],
  unlinked: [],
  outgoing: [],
  graph: { current: null, out: [], incoming: [], unresolved: [] },
}
let inspectGen = 0
let navView = 'files'
let wikiMarks = []
let wikiIndex = 0
let wikiRows = []
let paletteRows = []
let paletteIndex = 0
let paletteTimer = null
let paletteNotesOnly = false
let paletteQuery = ''
let paletteGen = 0
const editor = document.getElementById('editor')
const preview = document.getElementById('preview')
const PREVIEW_DELAY_MS = 100
const SAVE_DELAY_MS = 800
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
turndown.addRule('wikilink', {
  filter: (node) =>
    node.nodeName === 'A' && node.classList && node.classList.contains('wikilink'),
  replacement: (content, node) => {
    const href = (node.getAttribute('href') || '')
      .replace(/\\/g, '/')
      .replace(/\.html$/i, '')
    const label = content.trim()
    const leaf = href.split('/').pop()
    if (label && label !== href && label !== leaf) return '[[' + href + '|' + label + ']]'
    return '[[' + href + ']]'
  },
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
  theme: 'pitchstone',
  styleActiveLine: true,
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
    'Cmd-1': () => setTab('markdown'),
    'Cmd-2': () => setTab('html'),
    'Cmd-3': () => setTab('cssjs'),
    'Ctrl-1': () => setTab('markdown'),
    'Ctrl-2': () => setTab('html'),
    'Ctrl-3': () => setTab('cssjs'),
    Esc() {
      if (wikiPopupOpen()) {
        hideWikiPopup()
        return
      }
      return CodeMirror.Pass
    },
    Up() {
      if (wikiPopupOpen()) {
        wikiMove(-1)
        return
      }
      return CodeMirror.Pass
    },
    Down() {
      if (wikiPopupOpen()) {
        wikiMove(1)
        return
      }
      return CodeMirror.Pass
    },
    Enter() {
      if (wikiPopupOpen()) {
        wikiPick()
        return
      }
      return CodeMirror.Pass
    },
    'Cmd-Enter'() {
      if (wikiPopupOpen()) {
        void wikiCreate()
        return
      }
      return CodeMirror.Pass
    },
    'Ctrl-Enter'() {
      if (wikiPopupOpen()) {
        void wikiCreate()
        return
      }
      return CodeMirror.Pass
    },
  },
  hintOptions: { hint: tabHint, completeSingle: false },
})

function tabHint(instance, options) {
  const mode = instance.getOption('mode')
  if (mode === 'htmlmixed') return CodeMirror.hint.html(instance, options)
  if (mode === 'markdown') {
    if (wikiQueryAtCursor()) {
      return { list: [], from: instance.getCursor(), to: instance.getCursor() }
    }
    return CodeMirror.hint.anyword(instance, options)
  }
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
  const parsed = marked.parse(replaceWikilinks(md))
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
  return buffers.html.trim() ? buffers.html : htmlFromMarkdown(buffers.markdown)
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

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function previewChrome() {
  const fg = token('--cs-foreground')
  const bg = token('--cs-card')
  const link = token('--cs-primary')
  const fence = token('--cs-background-subtle')
  return (
    'html,body{margin:0}' +
    'body{padding:12px 16px;font:15px/1.45 Inter,system-ui,sans-serif;color:' +
    fg +
    ';background:' +
    bg +
    '}' +
    'a{color:' +
    link +
    '}' +
    'code,pre{font-family:ui-monospace,Menlo,Consolas,monospace;background:' +
    fence +
    '}' +
    'pre{padding:8px;overflow:auto}' +
    'img{max-width:100%}' +
    'a.wikilink{text-decoration:underline dotted}' +
    'a.wikilink-unresolved{opacity:.7;font-style:italic;text-decoration:underline dashed}'
  )
}

const WIKI_PREVIEW_JS =
  'document.addEventListener("click",function(e){' +
  'var a=e.target.closest&&e.target.closest("a.wikilink");' +
  'if(!a)return;e.preventDefault();' +
  'parent.postMessage({pitchstone:"wiki",href:a.getAttribute("href")||""},"*");' +
  '});'

function updatePreview() {
  buffers[activeTab] = cm.getValue()
  const parts = splitCssJs(buffers.cssjs)
  preview.srcdoc =
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    previewChrome() +
    '</style><style>' +
    parts.css +
    '</style></head><body>' +
    bodyHtml() +
    '<script>' +
    parts.js +
    '</script><script>' +
    WIKI_PREVIEW_JS +
    '</script></body></html>'
}

function schedulePreview() {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(() => {
    updatePreview()
    markWikilinks()
    updateWikiPopup()
    if (selectedUtil() === 'outline') renderUtility()
  }, PREVIEW_DELAY_MS)
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
  hideWikiPopup()
  applyingTab = true
  activeTab = name
  cm.setValue(buffers[name])
  applyingTab = false
  applyTabChrome(name)
  updatePreview()
  markWikilinks()
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
  if (applyingTab) return
  updateWikiPopup()
  if (change.origin !== '+input' || wikiQueryAtCursor()) return
  const typed = change.text[0]
  if (!typed || typed.length !== 1 || !/[\w.#@<$-]/.test(typed)) return
  if (!CodeMirror.commands.autocomplete) return
  CodeMirror.commands.autocomplete(instance)
})

cm.on('cursorActivity', () => {
  if (applyingTab) return
  updateWikiPopup()
})

cm.on('mousedown', (instance, event) => {
  if (activeTab !== 'markdown') return
  if (!(event.metaKey || event.ctrlKey)) return
  const pos = instance.coordsChar({ left: event.clientX, top: event.clientY })
  const target = wikiAtPos(pos)
  if (!target) return
  event.preventDefault()
  void openWiki(target)
})

function setStatus(text) {
  const el = document.getElementById('status')
  el.className = 'ps-save'
  if (text === 'Saved' || text === 'Exported') {
    el.textContent = text === 'Exported' ? '* Exported' : '* Saved'
    el.classList.add('ps-save--saved')
  } else if (text === 'Unsaved') {
    el.textContent = 'o Unsaved'
    el.classList.add('ps-save--dirty')
  } else if (text === 'Saving') {
    el.textContent = '... Saving'
    el.classList.add('ps-save--saving')
  } else if (!text || text === 'Ready' || text === 'Deleted') {
    el.textContent = text || ''
  } else {
    el.textContent = 'x ' + text
    el.classList.add('ps-save--error')
  }
}

function setEmptyVault(show) {
  const el = document.getElementById('empty-vault')
  if (el) el.hidden = !show
}

function applyTheme(dark) {
  document.documentElement.classList.toggle('dark', dark)
  const btn = document.getElementById('theme-toggle')
  if (btn) {
    btn.setAttribute(
      'aria-label',
      dark ? 'Switch to light theme' : 'Switch to dark theme'
    )
  }
  localStorage.setItem('pitchstone-theme', dark ? 'dark' : 'light')
  if (window.api.setDark) void window.api.setDark(dark)
  updatePreview()
}

function initTheme() {
  const saved = localStorage.getItem('pitchstone-theme')
  const dark = saved
    ? saved === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches
  applyTheme(dark)
}

const UTIL_EMPTY = {
  outline: 'No outline yet.',
  backlinks: 'No backlinks yet.',
  agent: 'No agent yet.',
}
const DOCK_EMPTY = {
  problems: 'No problems.',
  output: 'No output.',
  backlinks: 'No backlinks yet.',
  agent: 'No agent yet.',
}
const SVG_NS = 'http://www.w3.org/2000/svg'

function selectedUtil() {
  const el = document.querySelector('.ps-utility-hdr [aria-selected="true"]')
  return (el && el.dataset.util) || 'outline'
}

function selectedDock() {
  const el = document.querySelector('.ps-dock__tab[aria-selected="true"]')
  return (el && el.dataset.dock) || 'problems'
}

function liveOutline() {
  const src = bodyHtml()
  const out = []
  const html = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi
  let m
  while ((m = html.exec(src))) {
    const title = m[2].replace(/<[^>]+>/g, '').trim()
    if (title) out.push({ level: Number(m[1]), text: title })
  }
  if (out.length) return out
  const md = buffers.markdown
  const re = /^(#{1,3})\s+(.+)$/gm
  while ((m = re.exec(md))) out.push({ level: m[1].length, text: m[2].trim() })
  return out
}

function noteRel(item) {
  return String(item.rel || item.stem || '')
    .replace(/\.(html|md)$/i, '')
    .replace(/\\/g, '/')
}

function fillBacklinks(into) {
  const linked = noteCtx.linked || []
  const unlinked = noteCtx.unlinked || []
  if (!linked.length && !unlinked.length) {
    into.textContent = UTIL_EMPTY.backlinks
    return
  }
  into.replaceChildren()
  if (linked.length) {
    const label = document.createElement('div')
    label.className = 'ps-inspect-label'
    label.textContent = 'LINKED'
    into.appendChild(label)
    for (const item of linked) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'ps-backlink'
      const path = document.createElement('span')
      path.className = 'ps-backlink__path'
      path.textContent = noteRel(item)
      const snip = document.createElement('span')
      snip.className = 'ps-backlink__snip'
      snip.textContent = item.snippet || ''
      btn.appendChild(path)
      btn.appendChild(snip)
      btn.addEventListener('click', () => {
        expandTo(item.path)
        void openListedFile({ path: item.path })
      })
      into.appendChild(btn)
    }
  }
  if (unlinked.length) {
    const label = document.createElement('div')
    label.className = 'ps-inspect-label'
    label.textContent = 'UNLINKED'
    into.appendChild(label)
    for (const item of unlinked) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'ps-backlink ps-backlink--unlinked'
      const path = document.createElement('span')
      path.className = 'ps-backlink__path'
      path.textContent = noteRel(item)
      btn.appendChild(path)
      btn.title = item.snippet || noteRel(item)
      btn.addEventListener('click', () => {
        expandTo(item.path)
        void openListedFile({ path: item.path })
      })
      into.appendChild(btn)
    }
  }
}

function renderOutline(into) {
  const headings = liveOutline()
  if (!headings.length) {
    into.textContent = UTIL_EMPTY.outline
    return
  }
  const list = document.createElement('ul')
  list.className = 'ps-outline'
  for (const h of headings) {
    const li = document.createElement('li')
    li.className = 'ps-outline__item ps-outline__item--h' + h.level
    li.textContent = h.text
    list.appendChild(li)
  }
  into.replaceChildren(list)
}

function renderUtility() {
  const body = document.getElementById('utility-body')
  if (!body) return
  const tab = selectedUtil()
  body.hidden = tab === 'agent'
  if (tab === 'agent') {
    placeAgentPanel()
    return
  }
  placeAgentPanel()
  if (tab === 'outline') renderOutline(body)
  else if (tab === 'backlinks') fillBacklinks(body)
}

function renderDock() {
  const body = document.getElementById('dock-body')
  if (!body) return
  const tab = selectedDock()
  const panel = document.getElementById('agent-panel')
  if (panel && body.contains(panel)) {
    document.getElementById('utility').appendChild(panel)
  }
  if (tab === 'agent') {
    body.replaceChildren()
    placeAgentPanel()
    return
  }
  if (tab === 'backlinks') fillBacklinks(body)
  else body.textContent = DOCK_EMPTY[tab] || ''
}

function placeAgentPanel() {
  const panel = document.getElementById('agent-panel')
  if (!panel) return
  const ide = document.documentElement.dataset.shell === 'ide'
  const showDock = ide && selectedDock() === 'agent'
  const showUtil = !ide && selectedUtil() === 'agent'
  if (showDock) {
    document.getElementById('dock-body').appendChild(panel)
    panel.hidden = false
  } else {
    document.getElementById('utility').appendChild(panel)
    panel.hidden = !showUtil
  }
}

function showAgent() {
  const ide = document.documentElement.dataset.shell === 'ide'
  if (ide) {
    for (const el of document.querySelectorAll('.ps-dock__tab[data-dock]')) {
      el.setAttribute(
        'aria-selected',
        el.dataset.dock === 'agent' ? 'true' : 'false'
      )
    }
    renderDock()
  } else {
    for (const el of document.querySelectorAll('.ps-utility-hdr [data-util]')) {
      el.setAttribute(
        'aria-selected',
        el.dataset.util === 'agent' ? 'true' : 'false'
      )
    }
    renderUtility()
  }
}

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name)
  for (const key of Object.keys(attrs || {})) el.setAttribute(key, attrs[key])
  return el
}

function stackYs(count, mid, gap) {
  if (count < 1) return []
  const start = mid - ((count - 1) * gap) / 2
  const out = []
  for (let i = 0; i < count; i++) out.push(start + i * gap)
  return out
}

function graphLabel(text) {
  const s = String(text || '')
  return s.length > 14 ? s.slice(0, 13) + '...' : s
}

function renderGraph() {
  const host = document.getElementById('graph')
  if (!host) return
  const g = noteCtx.graph || {}
  if (!g.current) {
    host.replaceChildren()
    const empty = document.createElement('div')
    empty.className = 'ps-graph__empty'
    empty.textContent = currentPath ? 'No links yet.' : 'Open a note.'
    host.appendChild(empty)
    return
  }
  const incoming = g.incoming || []
  const out = g.out || []
  const unresolved = g.unresolved || []
  const W = 248
  const gap = 36
  const mid = 90
  const extra = unresolved.length ? 56 : 0
  const H = Math.max(220, mid + (Math.max(incoming.length, out.length, 1) * gap) / 2 + 48 + extra)
  const cx = W / 2
  const cy = Math.max(mid, 28 + extra / 2)
  const inX = 40
  const outX = W - 40
  const inYs = stackYs(incoming.length, cy, gap)
  const outYs = stackYs(out.length, cy, gap)
  const svg = svgEl('svg', {
    viewBox: '0 0 ' + W + ' ' + H,
    width: String(W),
    height: String(H),
  })
  function edge(x1, y1, x2, y2) {
    svg.appendChild(
      svgEl('line', {
        class: 'ps-graph__edge',
        x1: String(x1),
        y1: String(y1),
        x2: String(x2),
        y2: String(y2),
      })
    )
  }
  function node(kind, x, y, r, label, attrs) {
    const group = svgEl('g', { class: 'ps-graph__node ps-graph__' + kind })
    for (const key of Object.keys(attrs || {})) group.setAttribute(key, attrs[key])
    group.appendChild(svgEl('circle', { cx: String(x), cy: String(y), r: String(r) }))
    const text = svgEl('text', { x: String(x), y: String(y + r + 12) })
    text.textContent = graphLabel(label)
    group.appendChild(text)
    svg.appendChild(group)
  }
  incoming.forEach((item, i) => {
    edge(inX, inYs[i], cx - 19, cy)
    node('in', inX, inYs[i], 12, item.stem, { 'data-path': item.path })
  })
  out.forEach((item, i) => {
    edge(cx + 19, cy, outX, outYs[i])
    node('out', outX, outYs[i], 12, item.stem, { 'data-path': item.path })
  })
  unresolved.forEach((item, i) => {
    const x = cx - ((unresolved.length - 1) * 36) / 2 + i * 36
    const y = cy + 64
    edge(cx, cy + 19, x, y - 8)
    node('unresolved', x, y, 8, item.target.split('/').pop(), {
      'data-wiki': item.target,
    })
  })
  node('current', cx, cy, 19, g.current.stem, { 'data-path': g.current.path })
  svg.addEventListener('click', (event) => {
    const hit = event.target.closest('[data-path], [data-wiki]')
    if (!hit) return
    const wiki = hit.getAttribute('data-wiki')
    if (wiki) {
      void openWiki(wiki)
      return
    }
    const filePath = hit.getAttribute('data-path')
    if (!filePath || filePath === currentPath) return
    expandTo(filePath)
    void openListedFile({ path: filePath })
  })
  host.replaceChildren(svg)
}

function setNavView(view) {
  navView = view === 'graph' ? 'graph' : 'files'
  document.getElementById('tree-rail').hidden = navView === 'graph'
  document.getElementById('graph-rail').hidden = navView !== 'graph'
  document.getElementById('files-open').setAttribute(
    'aria-current',
    navView === 'files' ? 'true' : 'false'
  )
  document.getElementById('graph-open').setAttribute(
    'aria-current',
    navView === 'graph' ? 'true' : 'false'
  )
  if (navView === 'graph') renderGraph()
}

async function refreshInspect() {
  const gen = ++inspectGen
  const ctx = currentPath
    ? await window.api.noteContext(currentPath)
    : {
        outline: [],
        linked: [],
        unlinked: [],
        outgoing: [],
        graph: { current: null, out: [], incoming: [], unresolved: [] },
      }
  if (gen !== inspectGen) return
  noteCtx = ctx && ctx.graph ? ctx : noteCtx
  renderUtility()
  renderDock()
  if (navView === 'graph') renderGraph()
}

function noteName() {
  return currentPath ? currentPath.split(/[/\\]/).pop() : 'untitled'
}

function vaultLeaf() {
  if (!vaultFolder) return 'vault'
  const parts = vaultFolder.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || 'vault'
}

function setVaultPath(folder) {
  vaultFolder = folder || ''
  const el = document.getElementById('path')
  if (!el) return
  if (!folder) {
    el.textContent = 'no folder yet'
    el.removeAttribute('title')
    return
  }
  el.textContent = vaultLeaf()
  el.title = folder
}

function updateChrome() {
  const name = noteName()
  document.title = currentPath ? name + ' — Pitchstone' : 'Pitchstone'
  const label = document.getElementById('note-tab-label')
  if (label) label.textContent = currentPath ? name : 'untitled'
  const dot = document.getElementById('note-dirty')
  if (dot) dot.hidden = !dirty
  const crumb = document.getElementById('breadcrumbs')
  if (crumb) {
    crumb.replaceChildren()
    const root = document.createElement('span')
    root.textContent = vaultLeaf()
    crumb.appendChild(root)
    if (currentPath) {
      const sep = document.createElement('span')
      sep.className = 'ps-breadcrumbs__sep'
      sep.textContent = '/'
      const leaf = document.createElement('span')
      leaf.className = 'ps-breadcrumbs__leaf'
      leaf.textContent = name
      crumb.appendChild(sep)
      crumb.appendChild(leaf)
    }
  }
  const openList = document.getElementById('open-notes-list')
  if (!openList) return
  openList.replaceChildren()
  if (!currentPath) return
  const li = document.createElement('li')
  li.className = 'ps-tree__row'
  li.setAttribute('aria-current', 'true')
  li.textContent = name
  if (dirty) {
    const mark = document.createElement('span')
    mark.className = 'ps-dot'
    li.appendChild(mark)
  }
  openList.appendChild(li)
}

function applyShell(shell) {
  const ide = shell === 'ide'
  document.documentElement.dataset.shell = ide ? 'ide' : 'vault'
  localStorage.setItem('pitchstone-shell', ide ? 'ide' : 'vault')
  document.getElementById('open-notes').hidden = !ide
  document.getElementById('breadcrumbs').hidden = !ide
  document.getElementById('dock').hidden = !ide
  document.getElementById('utility').hidden = ide
  for (const btn of document.querySelectorAll('#shell-toggle [data-shell]')) {
    btn.setAttribute('aria-selected', btn.dataset.shell === (ide ? 'ide' : 'vault') ? 'true' : 'false')
  }
  placeAgentPanel()
  requestAnimationFrame(() => cm.refresh())
}

function initShell() {
  const saved = localStorage.getItem('pitchstone-shell')
  applyShell(saved === 'ide' ? 'ide' : 'vault')
}

function markDirty() {
  if (!currentPath) return
  dirty = true
  setStatus('Unsaved')
  updateChrome()
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void saveFile()
  }, SAVE_DELAY_MS)
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
}

function flattenNotes(items, folder, into) {
  for (const item of items) {
    if (item.isDir) {
      flattenNotes(
        item.children,
        folder ? folder + '/' + item.name : item.name,
        into
      )
    } else if (/\.html$/i.test(item.name)) {
      const rel = (folder ? folder + '/' + item.name : item.name).replace(
        /\\/g,
        '/'
      )
      into.push({
        path: item.path,
        name: item.name,
        stem: item.name.replace(/\.html$/i, ''),
        folder: folder || '',
        rel,
      })
    }
  }
  return into
}

function allNotes() {
  return flattenNotes(treeItems, '', [])
}

function resolveWiki(target) {
  const t = String(target || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\.html$/i, '')
  if (!t) return null
  const notes = allNotes()
  const lower = t.toLowerCase()
  const relHit = notes.find(
    (n) => n.rel.replace(/\.html$/i, '').toLowerCase() === lower
  )
  if (relHit) return relHit
  const stem = t.split('/').pop().toLowerCase()
  const hits = notes.filter((n) => n.stem.toLowerCase() === stem)
  return hits.length === 1 ? hits[0] : null
}

function wikiHref(target, note) {
  if (note) return note.rel
  return target.replace(/\\/g, '/').replace(/\.html$/i, '') + '.html'
}

function replaceWikilinks(md) {
  const parts = md.split(/(```[\s\S]*?```|`[^`]+`)/)
  return parts
    .map((part, i) => {
      if (i % 2) return part
      return part.replace(/\[\[([^\]\n]+?)\]\]/g, (_, inner) => {
        const pipe = inner.indexOf('|')
        const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim()
        const label = (pipe === -1 ? target : inner.slice(pipe + 1)).trim()
        const note = resolveWiki(target)
        const cls = note ? 'wikilink' : 'wikilink wikilink-unresolved'
        return (
          '<a class="' +
          cls +
          '" href="' +
          escapeHtml(wikiHref(target, note)) +
          '">' +
          escapeHtml(label) +
          '</a>'
        )
      })
    })
    .join('')
}

function markWikilinks() {
  for (const mark of wikiMarks) mark.clear()
  wikiMarks = []
  if (activeTab !== 'markdown') return
  const n = cm.lineCount()
  for (let i = 0; i < n; i++) {
    const line = cm.getLine(i)
    const re = /\[\[([^\]|\n]+)(?:\|[^\]]+)?\]\]/g
    let m
    while ((m = re.exec(line))) {
      const resolved = resolveWiki(m[1].trim())
      wikiMarks.push(
        cm.markText(
          { line: i, ch: m.index },
          { line: i, ch: m.index + m[0].length },
          {
            className: resolved ? 'cm-wikilink' : 'cm-wikilink-unresolved',
          }
        )
      )
    }
  }
}

function wikiAtPos(pos) {
  const line = cm.getLine(pos.line)
  const re = /\[\[([^\]|\n]+)(?:\|[^\]]+)?\]\]/g
  let m
  while ((m = re.exec(line))) {
    if (pos.ch >= m.index && pos.ch <= m.index + m[0].length) return m[1].trim()
  }
  return null
}

function wikiQueryAtCursor() {
  if (activeTab !== 'markdown') return null
  const cur = cm.getCursor()
  const before = cm.getLine(cur.line).slice(0, cur.ch)
  const start = before.lastIndexOf('[[')
  if (start === -1) return null
  const chunk = before.slice(start + 2)
  if (chunk.indexOf(']]') !== -1) return null
  return { line: cur.line, from: start, query: chunk }
}

function wikiPopupOpen() {
  const el = document.getElementById('wiki-popup')
  return el && !el.hidden
}

function hideWikiPopup() {
  const el = document.getElementById('wiki-popup')
  if (!el || el.hidden) return false
  el.hidden = true
  el.replaceChildren()
  wikiRows = []
  return true
}

function wikiMove(delta) {
  if (!wikiRows.length) return
  wikiIndex = (wikiIndex + delta + wikiRows.length) % wikiRows.length
  const rows = document.querySelectorAll('#wiki-popup .ps-popover__row')
  rows.forEach((row, i) => {
    row.setAttribute('aria-selected', i === wikiIndex ? 'true' : 'false')
  })
}

function insertWiki(target) {
  const q = wikiQueryAtCursor()
  if (!q) return
  cm.replaceRange(target + ']]', { line: q.line, ch: q.from + 2 }, cm.getCursor())
  hideWikiPopup()
}

function wikiPick() {
  const row = wikiRows[wikiIndex]
  if (!row) return
  if (row.type === 'create') {
    void wikiCreate()
    return
  }
  insertWiki(row.target)
}

async function wikiCreate() {
  const q = wikiQueryAtCursor()
  const target = (q && q.query.trim()) || 'untitled'
  const note = await createWikiNote(target)
  if (!note) return
  insertWiki(target.replace(/\\/g, '/').replace(/\.html$/i, ''))
  await refreshFiles()
}

async function createWikiNote(target) {
  const cleaned = String(target || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\.html$/i, '')
  if (!cleaned) return null
  const parts = cleaned.split('/').filter(Boolean)
  const name = parts.pop()
  let dir
  for (const part of parts) {
    const made = await window.api.createDir(part, dir)
    if (made.error && !made.path) {
      setStatus(made.error)
      return null
    }
    dir = made.path
    expandedPaths.add(dir)
  }
  const result = await window.api.createFile(name, dir)
  if (result.error) {
    setStatus(result.error)
    return null
  }
  return { path: result.path, name: result.name }
}

async function openWiki(target) {
  hideWikiPopup()
  let note = resolveWiki(target)
  if (!note) {
    note = await createWikiNote(target)
    if (!note) return
    await refreshFiles()
  }
  expandTo(note.path)
  await openListedFile(note)
}

function updateWikiPopup() {
  const el = document.getElementById('wiki-popup')
  if (!el) return
  const q = wikiQueryAtCursor()
  if (!q) {
    hideWikiPopup()
    return
  }
  const query = q.query.toLowerCase()
  const notes = allNotes().filter((n) => {
    if (!query) return true
    return (
      n.stem.toLowerCase().indexOf(query) !== -1 ||
      n.rel.toLowerCase().indexOf(query) !== -1 ||
      n.folder.toLowerCase().indexOf(query) !== -1
    )
  })
  notes.sort((a, b) => a.stem.localeCompare(b.stem))
  const shown = notes.slice(0, 6)
  wikiRows = shown.map((n) => ({
    type: 'note',
    target: n.rel.replace(/\.html$/i, ''),
    stem: n.stem,
    folder: n.folder,
  }))
  if (q.query.trim()) {
    wikiRows.push({ type: 'create', target: q.query.trim() })
  }
  if (!wikiRows.length) {
    hideWikiPopup()
    return
  }
  if (wikiIndex >= wikiRows.length) wikiIndex = 0
  el.replaceChildren()
  wikiRows.forEach((row, i) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className =
      'ps-popover__row' + (row.type === 'create' ? ' ps-popover__row--create' : '')
    btn.setAttribute('aria-selected', i === wikiIndex ? 'true' : 'false')
    if (row.type === 'create') {
      btn.textContent = 'Create "' + row.target + '"'
    } else {
      const name = document.createElement('span')
      name.textContent = row.stem
      btn.appendChild(name)
      if (row.folder) {
        const folder = document.createElement('span')
        folder.className = 'ps-popover__folder'
        folder.textContent = row.folder
        btn.appendChild(folder)
      }
    }
    btn.addEventListener('mousedown', (event) => {
      event.preventDefault()
      wikiIndex = i
      wikiPick()
    })
    el.appendChild(btn)
  })
  const coords = cm.cursorCoords(true, 'page')
  el.hidden = false
  el.style.left = coords.left + 'px'
  el.style.top = coords.bottom + 4 + 'px'
}

async function refreshUnresolved() {
  const result = await window.api.scanWikilinks()
  unresolvedTargets = result.items || []
  renderUnresolved()
  void refreshInspect()
}

function renderUnresolved() {
  const wrap = document.getElementById('unresolved-wrap')
  const list = document.getElementById('unresolved')
  if (!wrap || !list) return
  list.replaceChildren()
  if (!unresolvedTargets.length) {
    wrap.hidden = true
    return
  }
  wrap.hidden = false
  for (const target of unresolvedTargets) {
    const li = document.createElement('li')
    li.className = 'ps-tree__row ps-tree__row--unresolved'
    li.textContent = target
    li.addEventListener('click', () => {
      void openWiki(target)
    })
    list.appendChild(li)
  }
}

async function refreshFiles() {
  const result = await window.api.readDir()
  const list = document.getElementById('files')
  list.replaceChildren()
  if (result.error) {
    treeItems = []
    list.textContent = result.error
    return
  }
  treeItems = result.items
  renderTree()
  void refreshUnresolved()
}

function pathUnder(parent, child) {
  if (!parent || !child) return false
  return child === parent || child.startsWith(parent + '/') || child.startsWith(parent + '\\')
}

function parentOf(filePath) {
  if (!filePath) return undefined
  const cut = filePath.replace(/[/\\][^/\\]+$/, '')
  if (cut === filePath) return undefined
  return cut
}

function createParent() {
  if (selectedIsDir && selectedPath) return selectedPath
  return parentOf(selectedPath || currentPath)
}

function retarget(from, to) {
  if (!from || !to) return
  if (currentPath && pathUnder(from, currentPath)) {
    currentPath = to + currentPath.slice(from.length)
  }
  if (selectedPath && pathUnder(from, selectedPath)) {
    selectedPath = to + selectedPath.slice(from.length)
  }
  const next = new Set()
  for (const p of expandedPaths) {
    if (pathUnder(from, p)) next.add(to + p.slice(from.length))
    else next.add(p)
  }
  expandedPaths = next
}

function expandTo(filePath) {
  let dir = parentOf(filePath)
  const root = vaultFolder
  while (dir && root && dir.length > root.length) {
    expandedPaths.add(dir)
    const next = parentOf(dir)
    if (!next || next === dir) break
    dir = next
  }
}

function clearDropMarks() {
  for (const el of document.querySelectorAll('.ps-tree__row.is-drop')) {
    el.classList.remove('is-drop')
  }
}

function selectRow(item) {
  selectedPath = item.path
  selectedIsDir = !!item.isDir
}

function appendTree(items, depth, into) {
  const active = selectedPath || currentPath
  for (const item of items) {
    const li = document.createElement('li')
    li.className = 'ps-tree__row' + (item.isDir ? ' ps-tree__row--folder' : '')
    li.style.paddingLeft = 6 + depth * 16 + 'px'
    li.draggable = true
    if (item.path === active) li.setAttribute('aria-current', 'true')
    li.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', item.path)
    })
    li.addEventListener('dragend', clearDropMarks)
    if (item.isDir) {
      const open = expandedPaths.has(item.path)
      const twist = document.createElement('button')
      twist.type = 'button'
      twist.className = 'ps-tree__twist'
      twist.textContent = open ? 'v' : '>'
      twist.setAttribute('aria-label', open ? 'Collapse' : 'Expand')
      twist.addEventListener('click', (event) => {
        event.stopPropagation()
        if (expandedPaths.has(item.path)) expandedPaths.delete(item.path)
        else expandedPaths.add(item.path)
        renderTree()
      })
      const label = document.createElement('span')
      label.textContent = item.name
      li.appendChild(twist)
      li.appendChild(label)
      if (!open) {
        const count = document.createElement('span')
        count.className = 'ps-count'
        count.textContent = String(item.children.length)
        li.appendChild(count)
      }
      li.addEventListener('click', () => {
        selectRow(item)
        renderTree()
      })
      li.addEventListener('dragover', (event) => {
        event.preventDefault()
        event.stopPropagation()
        clearDropMarks()
        li.classList.add('is-drop')
      })
      li.addEventListener('drop', (event) => {
        event.preventDefault()
        event.stopPropagation()
        clearDropMarks()
        const from = event.dataTransfer.getData('text/plain')
        if (from) void moveInto(from, item.path)
      })
      into.appendChild(li)
      if (open) appendTree(item.children, depth + 1, into)
    } else {
      const label = document.createElement('span')
      label.textContent = item.name
      li.appendChild(label)
      li.addEventListener('click', () => {
        selectRow(item)
        void openListedFile(item)
      })
      li.addEventListener('dragover', (event) => {
        event.preventDefault()
        event.stopPropagation()
      })
      li.addEventListener('drop', (event) => {
        event.preventDefault()
        event.stopPropagation()
        clearDropMarks()
        const from = event.dataTransfer.getData('text/plain')
        if (from) void moveInto(from, parentOf(item.path))
      })
      into.appendChild(li)
    }
  }
}

function renderTree() {
  const list = document.getElementById('files')
  list.replaceChildren()
  appendTree(treeItems, 0, list)
  renderUnresolved()
}

async function moveInto(from, dirPath) {
  if (!from || from === dirPath) return
  const dest = dirPath || (await window.api.getVault())
  if (!dest) return
  const result = await window.api.moveFile(from, dest)
  if (result.error) {
    setStatus(result.error)
    return
  }
  retarget(from, result.path)
  updateChrome()
  await refreshFiles()
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
  selectedPath = item.path
  selectedIsDir = false
  expandTo(item.path)
  dirty = false
  clearTimeout(saveTimer)
  loadNote(file.content)
  showTab('markdown')
  setStatus('Saved')
  updateChrome()
  await refreshFiles()
}

async function showVault(folder) {
  currentPath = null
  selectedPath = null
  selectedIsDir = false
  expandedPaths = new Set()
  treeItems = []
  dirty = false
  clearTimeout(saveTimer)
  buffers.markdown = ''
  buffers.html = ''
  buffers.cssjs = ''
  lastBody = 'markdown'
  showTab('markdown')
  setVaultPath(folder)
  setEmptyVault(false)
  setStatus('')
  updateChrome()
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

document.getElementById('files').addEventListener('dragover', (event) => {
  event.preventDefault()
})
document.getElementById('files').addEventListener('drop', (event) => {
  event.preventDefault()
  clearDropMarks()
  const from = event.dataTransfer.getData('text/plain')
  if (from) void moveInto(from, null)
})

document.getElementById('new-file').addEventListener('click', async () => {
  const folder = await window.api.getVault()
  if (!folder) {
    setStatus('Open a vault first.')
    return
  }
  const name = await askName('Note name')
  if (name == null || !name.trim()) return
  const result = await window.api.createFile(name, createParent())
  if (result.error) {
    setStatus(result.error)
    return
  }
  currentPath = result.path
  selectedPath = result.path
  selectedIsDir = false
  expandTo(result.path)
  dirty = false
  loadNote(
    '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n</head>\n<body>\n</body>\n</html>\n'
  )
  showTab('markdown')
  setStatus('Saved')
  updateChrome()
  await refreshFiles()
})

document.getElementById('new-folder').addEventListener('click', async () => {
  const folder = await window.api.getVault()
  if (!folder) {
    setStatus('Open a vault first.')
    return
  }
  const name = await askName('Folder name')
  if (name == null || !name.trim()) return
  const result = await window.api.createDir(name, createParent())
  if (result.error) {
    setStatus(result.error)
    return
  }
  selectedPath = result.path
  selectedIsDir = true
  expandTo(result.path)
  await refreshFiles()
})

document.getElementById('rename-file').addEventListener('click', async () => {
  const target = selectedPath || currentPath
  if (!target) {
    setStatus('Select a file first.')
    return
  }
  const leaf = target.split(/[/\\]/).pop()
  const initial = selectedIsDir ? leaf : leaf.replace(/\.html$/i, '')
  const name = await askName('Rename to', initial)
  if (name == null || !name.trim()) return
  const result = await window.api.renameFile(target, name)
  if (result.error) {
    setStatus(result.error)
    return
  }
  retarget(target, result.path)
  if (!selectedIsDir) setStatus('Saved')
  updateChrome()
  await refreshFiles()
})

document.getElementById('delete-file').addEventListener('click', async () => {
  const target = selectedPath || currentPath
  if (!target) {
    setStatus('Select a file first.')
    return
  }
  const msg = selectedIsDir
    ? 'Delete this folder and its contents?'
    : 'Delete this note?'
  if (!(await askConfirm(msg))) return
  const result = await window.api.deleteFile(target)
  if (result.error) {
    setStatus(result.error)
    return
  }
  if (currentPath && pathUnder(target, currentPath)) {
    currentPath = null
    dirty = false
    clearTimeout(saveTimer)
    buffers.markdown = ''
    buffers.html = ''
    buffers.cssjs = ''
    lastBody = 'markdown'
    showTab('markdown')
  }
  if (selectedPath && pathUnder(target, selectedPath)) {
    selectedPath = null
    selectedIsDir = false
  }
  setStatus('Deleted')
  updateChrome()
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
  updateChrome()
  void refreshUnresolved()
  markWikilinks()
}

document.getElementById('save').addEventListener('click', () => {
  void saveFile()
})

function markdownForExport() {
  buffers[activeTab] = cm.getValue()
  if (activeTab === 'markdown') return cm.getValue()
  if (activeTab === 'html') {
    const html = cm.getValue()
    return html.trim() ? turndown.turndown(html) : ''
  }
  if (buffers.html.trim()) return turndown.turndown(buffers.html)
  return buffers.markdown
}

document.getElementById('export-md').addEventListener('click', async () => {
  const leaf = currentPath ? currentPath.split(/[/\\]/).pop() : 'untitled'
  const result = await window.api.exportMarkdown(markdownForExport(), leaf)
  if (result.canceled) return
  if (result.error) {
    setStatus(result.error)
    return
  }
  setStatus('Exported')
})

const PALETTE_COMMANDS = [
  { id: 'open', label: 'Open vault' },
  { id: 'new', label: 'New note' },
  { id: 'folder', label: 'New folder' },
  { id: 'save', label: 'Save' },
  { id: 'export', label: 'Export Markdown' },
  { id: 'theme', label: 'Toggle theme' },
  { id: 'shell-vault', label: 'Shell: Vault' },
  { id: 'shell-ide', label: 'Shell: Code' },
  { id: 'graph', label: 'Show graph' },
  { id: 'files', label: 'Show files' },
  { id: 'agent', label: 'Show agent' },
]

function paletteOpen() {
  const scrim = document.getElementById('palette-scrim')
  return scrim && !scrim.hidden
}

function closePalette() {
  const scrim = document.getElementById('palette-scrim')
  if (scrim) scrim.hidden = true
  clearTimeout(paletteTimer)
}

function openPalette(notesOnly) {
  hideWikiPopup()
  paletteNotesOnly = !!notesOnly
  paletteIndex = 0
  const scrim = document.getElementById('palette-scrim')
  const input = document.getElementById('palette-input')
  scrim.hidden = false
  input.value = ''
  input.focus()
  void fillPalette()
}

function highlightText(text, query) {
  const wrap = document.createElement('span')
  if (!query) {
    wrap.textContent = text
    return wrap
  }
  const i = text.toLowerCase().indexOf(query.toLowerCase())
  if (i === -1) {
    wrap.textContent = text
    return wrap
  }
  wrap.appendChild(document.createTextNode(text.slice(0, i)))
  const mark = document.createElement('span')
  mark.className = 'ps-match'
  mark.textContent = text.slice(i, i + query.length)
  wrap.appendChild(mark)
  wrap.appendChild(document.createTextNode(text.slice(i + query.length)))
  return wrap
}

function noteFolder(rel) {
  const i = rel.lastIndexOf('/')
  return i === -1 ? '' : rel.slice(0, i)
}

function filterCommands(query) {
  const q = query.toLowerCase()
  return PALETTE_COMMANDS.filter((c) => !q || c.label.toLowerCase().indexOf(q) !== -1)
}

function selectablePalette() {
  return paletteRows.filter((r) => r.type !== 'group')
}

async function fillPalette() {
  const gen = ++paletteGen
  const input = document.getElementById('palette-input')
  const raw = input ? input.value : ''
  const rows = []
  const pushGroup = (label) => {
    rows.push({ type: 'group', label })
  }
  const pushNote = (n, extra) => {
    rows.push({
      type: 'note',
      path: n.path,
      stem: n.stem,
      folder: n.folder || noteFolder(n.rel || ''),
      extra,
    })
  }

  if (raw.startsWith('>')) {
    pushGroup('COMMANDS')
    for (const c of filterCommands(raw.slice(1).trim())) {
      rows.push({ type: 'cmd', id: c.id, label: c.label })
    }
  } else if (raw.startsWith('[[')) {
    const q = raw.slice(2).replace(/\]\]$/, '').toLowerCase()
    pushGroup('NOTES')
    for (const n of allNotes()) {
      if (
        q &&
        n.stem.toLowerCase().indexOf(q) === -1 &&
        n.rel.toLowerCase().indexOf(q) === -1
      ) {
        continue
      }
      pushNote(n)
    }
  } else if (raw.startsWith('#')) {
    const q = raw.slice(1).trim()
    if (q) {
      const result = await window.api.searchVault(q)
      if (gen !== paletteGen) return
      pushGroup('HEADINGS')
      for (const h of result.headings || []) {
        rows.push({
          type: 'note',
          path: h.path,
          stem: h.text,
          folder: h.stem,
          extra: 'H' + h.level,
        })
      }
    }
  } else if (!raw.trim()) {
    if (!paletteNotesOnly) {
      pushGroup('COMMANDS')
      for (const c of PALETTE_COMMANDS) {
        rows.push({ type: 'cmd', id: c.id, label: c.label })
      }
    }
    pushGroup('NOTES')
    for (const n of allNotes().slice(0, 8)) pushNote(n)
  } else {
    const result = await window.api.searchVault(raw.trim())
    if (gen !== paletteGen) return
    if (result.error) setStatus(result.error)
    const notes = result.notes || []
    const hits = result.hits || []
    if (notes.length) {
      pushGroup('NOTES')
      for (const n of notes) pushNote(n)
    }
    if (!paletteNotesOnly && hits.length) {
      pushGroup('FULL TEXT')
      for (const h of hits) {
        rows.push({
          type: 'note',
          path: h.path,
          stem: h.stem,
          folder: 'L' + h.line,
          extra: h.preview,
        })
      }
    }
    if (!paletteNotesOnly) {
      const cmds = filterCommands(raw.trim())
      if (cmds.length) {
        pushGroup('COMMANDS')
        for (const c of cmds) rows.push({ type: 'cmd', id: c.id, label: c.label })
      }
    }
  }

  if (gen !== paletteGen) return
  paletteRows = rows
  paletteQuery = raw.startsWith('>') || raw.startsWith('#') || raw.startsWith('[[')
    ? raw.replace(/^>|^#|^\[\[/, '').replace(/\]\]$/, '')
    : raw.trim()
  const sel = selectablePalette()
  if (paletteIndex >= sel.length) paletteIndex = Math.max(0, sel.length - 1)
  drawPalette(paletteQuery)
}

function drawPalette(query) {
  const box = document.getElementById('palette-results')
  box.replaceChildren()
  const sel = selectablePalette()
  let selAt = 0
  for (const row of paletteRows) {
    if (row.type === 'group') {
      const g = document.createElement('div')
      g.className = 'ps-palette__group'
      g.textContent = row.label
      box.appendChild(g)
      continue
    }
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ps-palette__row'
    btn.setAttribute('aria-selected', selAt === paletteIndex ? 'true' : 'false')
    const i = selAt
    if (row.type === 'cmd') {
      btn.appendChild(highlightText(row.label, query))
    } else {
      btn.appendChild(highlightText(row.stem, query))
      if (row.extra) {
        const extra = document.createElement('span')
        extra.className = 'ps-popover__folder'
        extra.textContent = row.extra
        extra.style.overflow = 'hidden'
        extra.style.textOverflow = 'ellipsis'
        extra.style.whiteSpace = 'nowrap'
        extra.style.maxWidth = '240px'
        btn.appendChild(extra)
      } else if (row.folder) {
        const folder = document.createElement('span')
        folder.className = 'ps-popover__folder'
        folder.textContent = row.folder
        btn.appendChild(folder)
      }
    }
    btn.addEventListener('mousedown', (event) => {
      event.preventDefault()
      paletteIndex = i
      palettePick()
    })
    box.appendChild(btn)
    selAt += 1
  }
  const chosen = box.querySelector('[aria-selected="true"]')
  if (chosen) chosen.scrollIntoView({ block: 'nearest' })
}

function paletteMove(delta) {
  const sel = selectablePalette()
  if (!sel.length) return
  paletteIndex = (paletteIndex + delta + sel.length) % sel.length
  drawPalette(paletteQuery)
}

function runPaletteCommand(id) {
  closePalette()
  if (id === 'open') document.getElementById('open').click()
  else if (id === 'new') document.getElementById('new-file').click()
  else if (id === 'folder') document.getElementById('new-folder').click()
  else if (id === 'save') void saveFile()
  else if (id === 'export') document.getElementById('export-md').click()
  else if (id === 'theme') {
    document.getElementById('theme-toggle').click()
  } else if (id === 'shell-vault') applyShell('vault')
  else if (id === 'shell-ide') applyShell('ide')
  else if (id === 'graph') setNavView('graph')
  else if (id === 'files') setNavView('files')
  else if (id === 'agent') showAgent()
}

function palettePick() {
  const row = selectablePalette()[paletteIndex]
  if (!row) return
  if (row.type === 'cmd') {
    runPaletteCommand(row.id)
    return
  }
  closePalette()
  if (row.path) {
    expandTo(row.path)
    void openListedFile({ path: row.path })
  }
}

document.getElementById('agent-open').addEventListener('click', () => {
  showAgent()
})

document.getElementById('files-open').addEventListener('click', () => {
  setNavView('files')
})

document.getElementById('graph-open').addEventListener('click', () => {
  setNavView('graph')
})

document.getElementById('search-open').addEventListener('click', () => {
  openPalette(false)
})

document.getElementById('palette-scrim').addEventListener('mousedown', (event) => {
  if (event.target.id === 'palette-scrim') closePalette()
})

document.getElementById('palette-input').addEventListener('input', () => {
  clearTimeout(paletteTimer)
  paletteTimer = setTimeout(() => {
    void fillPalette()
  }, 80)
})

document.getElementById('palette-input').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    paletteMove(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    paletteMove(-1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    palettePick()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    closePalette()
  }
})

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && paletteOpen()) {
    event.preventDefault()
    closePalette()
    return
  }
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return
  const key = event.key.toLowerCase()
  const mac = document.documentElement.dataset.platform === 'mac'
  if (key === 'k') {
    if (mac) return
    event.preventDefault()
    openPalette(false)
    return
  }
  if (key === 'o') {
    if (mac) return
    event.preventDefault()
    document.getElementById('open').click()
    return
  }
  if (key === 'n') {
    if (mac) return
    event.preventDefault()
    document.getElementById('new-file').click()
    return
  }
  if (key === 'p') {
    event.preventDefault()
    openPalette(true)
    return
  }
  if (key === 's') {
    if (mac) return
    event.preventDefault()
    void saveFile()
  } else if (event.key === '1') {
    event.preventDefault()
    setTab('markdown')
  } else if (event.key === '2') {
    event.preventDefault()
    setTab('html')
  } else if (event.key === '3') {
    event.preventDefault()
    setTab('cssjs')
  }
})

document.getElementById('theme-toggle').addEventListener('click', () => {
  applyTheme(!document.documentElement.classList.contains('dark'))
})

document.getElementById('shell-toggle').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-shell]')
  if (!btn) return
  applyShell(btn.dataset.shell)
})

document.querySelector('.ps-utility-hdr').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-util]')
  if (!btn) return
  for (const el of document.querySelectorAll('.ps-utility-hdr [data-util]')) {
    el.setAttribute('aria-selected', el === btn ? 'true' : 'false')
  }
  renderUtility()
})

document.querySelector('.ps-dock__tabs').addEventListener('click', (event) => {
  const fold = event.target.closest('#dock-fold')
  if (fold) {
    const dock = document.getElementById('dock')
    const collapsed = dock.classList.toggle('is-collapsed')
    fold.textContent = collapsed ? '^' : 'v'
    fold.setAttribute('aria-label', collapsed ? 'Expand dock' : 'Collapse dock')
    requestAnimationFrame(() => cm.refresh())
    return
  }
  const btn = event.target.closest('[data-dock]')
  if (!btn) return
  for (const el of document.querySelectorAll('.ps-dock__tab[data-dock]')) {
    el.setAttribute('aria-selected', el === btn ? 'true' : 'false')
  }
  renderDock()
})

document.getElementById('empty-open').addEventListener('click', () => {
  document.getElementById('open').click()
})

const AGENT_PRESETS = {
  acp: '',
  claude: 'claude --acp',
  gemini: 'gemini --acp',
  cursor: 'agent acp',
  opencode: 'opencode acp',
  json: '',
  http: '',
}
let agentBusy = false
let agentLive = null
let agentThought = null
const agentTools = new Map()

function persistAgentConfig() {
  const kind = document.getElementById('agent-kind')
  const target = document.getElementById('agent-target')
  if (!kind || !target) return Promise.resolve()
  return window.api.agentConfigSet({ kind: kind.value, target: target.value.trim() })
}

async function loadAgentConfig() {
  const cfg = await window.api.agentConfigGet()
  const kind = document.getElementById('agent-kind')
  const target = document.getElementById('agent-target')
  let value = cfg.kind || 'acp'
  if (value === 'stdio' || value === 'pi') value = 'acp'
  if (kind) kind.value = value
  if (target) target.value = cfg.target || ''
  syncAgentChrome('idle', 'idle · ACP session, vault is cwd')
}

function agentIsAcp() {
  const kind = document.getElementById('agent-kind')
  return kind && kind.value !== 'json' && kind.value !== 'http'
}

function syncAgentChrome(status, text) {
  const line = document.getElementById('agent-status')
  if (line && text) line.textContent = text
  const running = status === 'ready' || status === 'busy' || status === 'starting'
  const start = document.getElementById('agent-start')
  const stop = document.getElementById('agent-stop')
  const cancel = document.getElementById('agent-cancel')
  const send = document.getElementById('agent-send')
  if (start) start.hidden = !agentIsAcp() || running
  if (stop) stop.hidden = !agentIsAcp() || !running
  if (cancel) cancel.hidden = status !== 'busy'
  if (send) send.disabled = agentBusy && status === 'busy'
  agentBusy = status === 'busy' || status === 'starting'
}

function agentScroll() {
  const log = document.getElementById('agent-log')
  if (log) log.scrollTop = log.scrollHeight
}

function agentLog(role, text, edits) {
  const log = document.getElementById('agent-log')
  if (!log) return
  const wrap = document.createElement('div')
  wrap.className =
    'ps-agent__msg' +
    (role === 'user'
      ? ' ps-agent__msg--user'
      : role === 'error'
        ? ' ps-agent__msg--error'
        : role === 'thought'
          ? ' ps-agent__msg--thought'
          : '')
  const who = document.createElement('span')
  who.className = 'ps-agent__who'
  who.textContent =
    role === 'user' ? 'YOU' : role === 'error' ? 'ERROR' : role === 'thought' ? 'THINK' : 'AGENT'
  const body = document.createElement('span')
  body.textContent = text || ''
  wrap.appendChild(who)
  wrap.appendChild(body)
  if (edits && edits.length) {
    for (const edit of edits) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'ps-agent__edit'
      btn.textContent = 'Apply ' + (edit.rel || 'edit')
      btn.addEventListener('click', () => {
        void applyAgentEdit(edit)
      })
      wrap.appendChild(btn)
    }
  }
  log.appendChild(wrap)
  agentScroll()
  return { wrap, body }
}

function hideAgentPerm() {
  const bar = document.getElementById('agent-perm')
  if (bar) bar.hidden = true
}

function showAgentPerm(event) {
  const bar = document.getElementById('agent-perm')
  const title = document.getElementById('agent-perm-title')
  const actions = document.getElementById('agent-perm-actions')
  if (!bar || !title || !actions) return
  title.textContent = event.title || 'Allow this tool?'
  actions.replaceChildren()
  for (const opt of event.options || []) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className =
      opt.kind && opt.kind.indexOf('reject') === 0
        ? 'bcs-btn bcs-btn-outline bcs-btn-sm'
        : 'bcs-btn bcs-btn-primary bcs-btn-sm'
    btn.textContent = opt.name
    btn.addEventListener('click', () => {
      hideAgentPerm()
      void window.api.agentPermission({ optionId: opt.optionId, kind: opt.kind })
    })
    actions.appendChild(btn)
  }
  bar.hidden = false
}

function onAgentEvent(event) {
  if (!event || !event.type) return
  if (event.type === 'status') {
    const label =
      event.status === 'ready'
        ? 'ready · ' + (event.text || 'session')
        : event.status === 'busy'
          ? 'running'
          : event.status === 'starting'
            ? 'starting · ' + (event.text || '')
            : event.status === 'idle'
              ? 'idle · ' + (event.text || 'stopped')
              : String(event.text || event.status)
    syncAgentChrome(event.status, label)
    if (event.status === 'idle' || event.status === 'ready') {
      agentLive = null
      agentThought = null
    }
  } else if (event.type === 'chunk') {
    if (!agentLive) agentLive = agentLog('assistant', '')
    agentLive.body.textContent += event.text || ''
    agentScroll()
  } else if (event.type === 'thought') {
    if (!agentThought) agentThought = agentLog('thought', '')
    agentThought.body.textContent += event.text || ''
    agentScroll()
  } else if (event.type === 'tool') {
    const log = document.getElementById('agent-log')
    if (!log) return
    let el = agentTools.get(event.toolCallId)
    if (!el) {
      el = document.createElement('div')
      el.className = 'ps-agent__tool'
      log.appendChild(el)
      agentTools.set(event.toolCallId, el)
    }
    if (event.status) el.dataset.status = event.status
    const bits = [event.title || event.kind || 'tool']
    if (event.status) bits.push(event.status)
    if (event.path) bits.push(event.path.replace(/^.*[/\\]/, ''))
    if (event.detail) bits.push(event.detail)
    el.textContent = bits.filter(Boolean).join(' · ')
    agentScroll()
  } else if (event.type === 'permission') {
    showAgentPerm(event)
  } else if (event.type === 'turn') {
    agentLive = null
    agentThought = null
    hideAgentPerm()
    syncAgentChrome('ready', 'ready · session')
  } else if (event.type === 'error') {
    agentLog('error', event.text || 'Agent error')
    hideAgentPerm()
  } else if (event.type === 'wrote' && event.path) {
    void onAgentWrote(event.path)
  }
}

async function onAgentWrote(filePath) {
  await refreshFiles()
  if (filePath === currentPath) {
    const file = await window.api.readFile(filePath)
    if (!file.error) {
      dirty = false
      loadNote(file.content)
      showTab(activeTab)
      setStatus('Saved')
      updateChrome()
      updatePreview()
      void refreshInspect()
    }
  }
}

async function applyAgentEdit(edit) {
  const result = await window.api.writeFile(edit.path, edit.html)
  if (result.error) {
    setStatus(result.error)
    return
  }
  if (edit.path === currentPath) {
    dirty = false
    loadNote(edit.html)
    showTab(activeTab)
    setStatus('Saved')
    updateChrome()
    updatePreview()
    void refreshInspect()
  } else {
    setStatus('Saved')
    await refreshFiles()
  }
}

document.getElementById('agent-kind').addEventListener('change', () => {
  const kind = document.getElementById('agent-kind').value
  const target = document.getElementById('agent-target')
  const preset = AGENT_PRESETS[kind]
  if (preset != null && (preset || kind !== 'acp')) {
    if (preset) target.value = preset
  }
  persistAgentConfig()
  syncAgentChrome('idle', 'idle · ACP session, vault is cwd')
})

document.getElementById('agent-target').addEventListener('change', persistAgentConfig)

document.getElementById('agent-start').addEventListener('click', async () => {
  await persistAgentConfig()
  const result = await window.api.agentStart()
  if (result.error) agentLog('error', result.error)
})

document.getElementById('agent-stop').addEventListener('click', () => {
  hideAgentPerm()
  void window.api.agentStop()
})

document.getElementById('agent-cancel').addEventListener('click', () => {
  hideAgentPerm()
  void window.api.agentCancel()
})

document.getElementById('agent-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  if (agentBusy) return
  const input = document.getElementById('agent-input')
  const message = input.value.trim()
  if (!message) return
  await persistAgentConfig()
  input.value = ''
  agentLog('user', message)
  agentLive = null
  agentThought = null
  agentBusy = true
  document.getElementById('agent-send').disabled = true
  const note = currentPath ? { path: currentPath, html: noteToHtmlFile() } : null
  const reply = await window.api.agentPrompt({ message, note })
  agentBusy = false
  document.getElementById('agent-send').disabled = false
  if (reply.error) {
    agentLog('error', reply.error)
    syncAgentChrome('idle', 'idle · ' + reply.error)
    return
  }
  if (reply.mode === 'json') {
    agentLog('assistant', reply.text || '(no text)', reply.edits)
  }
})

document.getElementById('agent-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    document.getElementById('agent-form').requestSubmit()
  }
})

if (window.api.onAgentEvent) window.api.onAgentEvent(onAgentEvent)

window.api.onMenuAction((id) => {
  if (id === 'open') document.getElementById('open').click()
  else if (id === 'new') document.getElementById('new-file').click()
  else if (id === 'folder') document.getElementById('new-folder').click()
  else if (id === 'save') void saveFile()
  else if (id === 'export') document.getElementById('export-md').click()
  else if (id === 'rename') document.getElementById('rename-file').click()
  else if (id === 'delete') document.getElementById('delete-file').click()
  else if (id === 'theme') document.getElementById('theme-toggle').click()
  else if (id === 'shell-vault') applyShell('vault')
  else if (id === 'shell-ide') applyShell('ide')
  else if (id === 'search') openPalette(false)
  else if (id === 'graph') setNavView('graph')
  else if (id === 'files') setNavView('files')
  else if (id === 'agent') showAgent()
})

function initPlatform() {
  const p = window.api && window.api.platform
  if (p === 'darwin') document.documentElement.dataset.platform = 'mac'
  else if (p === 'win32') document.documentElement.dataset.platform = 'win'
  else if (p) document.documentElement.dataset.platform = 'linux'
  const overlay = navigator.windowControlsOverlay
  const syncWco = () => {
    document.documentElement.classList.toggle('wco', !!(overlay && overlay.visible))
  }
  syncWco()
  if (overlay && overlay.addEventListener) {
    overlay.addEventListener('geometrychange', syncWco)
  }
  if (window.api.onFullscreen) {
    window.api.onFullscreen((on) => {
      if (on) document.documentElement.dataset.fullscreen = ''
      else delete document.documentElement.dataset.fullscreen
    })
  }
}

initPlatform()
initTheme()
initShell()
updateChrome()
void loadAgentConfig()

window.addEventListener('message', (event) => {
  if (event.source !== preview.contentWindow) return
  if (!event.data || event.data.pitchstone !== 'wiki') return
  const href = String(event.data.href || '')
    .replace(/\\/g, '/')
    .replace(/\.html$/i, '')
  if (href) void openWiki(href)
})

document.addEventListener('mousedown', (event) => {
  const el = document.getElementById('wiki-popup')
  if (!el || el.hidden) return
  if (el.contains(event.target) || cm.getWrapperElement().contains(event.target)) {
    return
  }
  hideWikiPopup()
})

void (async () => {
  const folder = await window.api.getVault()
  if (folder) await showVault(folder)
  else setEmptyVault(true)
})()

updatePreview()
requestAnimationFrame(() => cm.refresh())
