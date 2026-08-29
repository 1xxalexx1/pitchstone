function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function previewLine(line) {
  return String(line)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
}

function flattenFiles(items, folder, into) {
  for (const item of items) {
    if (item.isDir) {
      flattenFiles(
        item.children,
        folder ? folder + '/' + item.name : item.name,
        into
      )
    } else if (/\.(html|md)$/i.test(item.name)) {
      into.push({
        path: item.path,
        rel: (folder ? folder + '/' + item.name : item.name).replace(/\\/g, '/'),
        stem: item.name.replace(/\.(html|md)$/i, ''),
      })
    }
  }
}

function cleanTarget(raw) {
  return String(raw || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\.html$/i, '')
}

function wikiMentions(text) {
  const out = []
  const src = String(text || '')
  let m
  const wiki = /\[\[([^\]|\n#]+)(?:\|[^\]]*)?\]\]/g
  while ((m = wiki.exec(src))) {
    out.push({ target: cleanTarget(m[1]), index: m.index })
  }
  const anchors = /<a\b([^>]+)>/gi
  while ((m = anchors.exec(src))) {
    if (!/\bwikilink\b/.test(m[1])) continue
    const href = /\bhref="([^"]+)"/.exec(m[1])
    if (href) out.push({ target: cleanTarget(href[1]), index: m.index })
  }
  return out
}

function extractWikiTargets(text) {
  const seen = {}
  for (const m of wikiMentions(text)) {
    if (m.target) seen[m.target] = true
  }
  return Object.keys(seen)
}

function matchWikiFile(target, files) {
  const t = cleanTarget(target).toLowerCase()
  if (!t) return null
  const rel = files.find(
    (f) => f.rel.replace(/\.(html|md)$/i, '').toLowerCase() === t
  )
  if (rel) return rel
  const stem = t.split('/').pop()
  const hits = files.filter((f) => f.stem.toLowerCase() === stem)
  return hits.length === 1 ? hits[0] : null
}

function extractHeadings(text) {
  const out = []
  const src = String(text || '')
  const html = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi
  let m
  while ((m = html.exec(src))) {
    const title = m[2].replace(/<[^>]+>/g, '').trim()
    if (title) out.push({ level: Number(m[1]), text: title })
  }
  if (out.length) return out
  const md = /^(#{1,3})\s+(.+)$/gm
  while ((m = md.exec(src))) out.push({ level: m[1].length, text: m[2].trim() })
  return out
}

function snippetAt(text, index) {
  const src = String(text || '')
  let start = src.lastIndexOf('\n', Math.max(0, index) - 1)
  let end = src.indexOf('\n', index)
  if (start < 0) start = 0
  else start += 1
  if (end < 0) end = src.length
  return previewLine(src.slice(start, end))
}

function stripWiki(text) {
  return String(text || '')
    .replace(/\[\[[^\]]+\]\]/g, ' ')
    .replace(/<a\b[^>]*\bwikilink\b[^>]*>[\s\S]*?<\/a>/gi, ' ')
}

function emptyContext() {
  return {
    outline: [],
    linked: [],
    unlinked: [],
    outgoing: [],
    graph: { current: null, out: [], incoming: [], unresolved: [] },
  }
}

function noteContext(currentPath, files) {
  const empty = emptyContext()
  const me = files.find((f) => f.path === currentPath)
  if (!me) return empty
  const outgoing = []
  const seenOut = {}
  for (const m of wikiMentions(me.text)) {
    if (!m.target || seenOut[m.target]) continue
    seenOut[m.target] = true
    const dest = matchWikiFile(m.target, files)
    outgoing.push({
      target: m.target,
      path: dest ? dest.path : null,
      rel: dest ? dest.rel : '',
      stem: dest ? dest.stem : m.target.split('/').pop(),
    })
  }
  const linked = []
  const unlinked = []
  const stemRe = me.stem ? new RegExp('\\b' + escapeRe(me.stem) + '\\b', 'i') : null
  for (const file of files) {
    if (file.path === me.path) continue
    let hit = null
    for (const m of wikiMentions(file.text)) {
      const dest = matchWikiFile(m.target, files)
      if (dest && dest.path === me.path) {
        hit = snippetAt(file.text, m.index)
        break
      }
    }
    if (hit) {
      linked.push({
        path: file.path,
        rel: file.rel,
        stem: file.stem,
        snippet: hit,
      })
      continue
    }
    if (!stemRe) continue
    const stripped = stripWiki(file.text)
    const um = stemRe.exec(stripped)
    if (um) {
      unlinked.push({
        path: file.path,
        rel: file.rel,
        stem: file.stem,
        snippet: snippetAt(stripped, um.index),
      })
    }
  }
  return {
    outline: extractHeadings(me.text),
    linked,
    unlinked,
    outgoing,
    graph: {
      current: { path: me.path, stem: me.stem, rel: me.rel },
      out: outgoing
        .filter((o) => o.path)
        .map((o) => ({ path: o.path, stem: o.stem, rel: o.rel })),
      incoming: linked.map((l) => ({
        path: l.path,
        stem: l.stem,
        rel: l.rel,
      })),
      unresolved: outgoing
        .filter((o) => !o.path)
        .map((o) => ({ target: o.target })),
    },
  }
}

module.exports = {
  flattenFiles,
  extractWikiTargets,
  matchWikiFile,
  extractHeadings,
  previewLine,
  wikiMentions,
  noteContext,
  emptyContext,
  cleanTarget,
}
