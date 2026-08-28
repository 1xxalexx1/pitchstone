const { spawn } = require('child_process')
const http = require('http')
const https = require('https')

const PRESETS = {
  pi: { kind: 'stdio', target: 'pi' },
  claude: { kind: 'stdio', target: 'claude' },
  cursor: { kind: 'stdio', target: 'cursor' },
  opencode: { kind: 'stdio', target: 'opencode' },
}

function splitArgs(line) {
  const out = []
  let cur = ''
  let q = ''
  for (const ch of String(line || '')) {
    if (q) {
      if (ch === q) q = ''
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      q = ch
    } else if (/\s/.test(ch)) {
      if (cur) out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur) out.push(cur)
  return out
}

function resolveKind(kind, target) {
  const preset = PRESETS[kind]
  if (preset) return { kind: preset.kind, target: target || preset.target }
  if (kind === 'http') return { kind: 'http', target }
  return { kind: 'stdio', target }
}

function parseAgentResponse(raw) {
  const text = String(raw || '').trim()
  if (!text) return { text: '', edits: [] }
  try {
    const data = JSON.parse(text)
    return normalizeReply(data, text)
  } catch {
    /* fall through */
  }
  const start = text.lastIndexOf('{')
  if (start >= 0) {
    try {
      return normalizeReply(JSON.parse(text.slice(start)), text)
    } catch {
      /* plain text */
    }
  }
  return { text, edits: [] }
}

function normalizeReply(data, fallback) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { text: fallback, edits: [] }
  }
  const text = data.text != null ? String(data.text) : fallback
  const edits = []
  const list = Array.isArray(data.edits) ? data.edits : []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const p = String(item.path || '').trim()
    if (!p) continue
    edits.push({
      path: p,
      html: item.html != null ? String(item.html) : String(item.content || ''),
    })
  }
  return { text, edits }
}

function runStdio(command, payload, cwd, timeoutMs) {
  const args = splitArgs(command)
  const file = args.shift()
  if (!file) return Promise.reject(new Error('No command.'))
  const body = JSON.stringify(payload) + '\n'
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(file, args, {
        cwd: cwd || undefined,
        env: process.env,
        shell: false,
        windowsHide: true,
      })
    } catch (err) {
      reject(err)
      return
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Agent timed out.'))
    }, timeoutMs || 120000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e.code === 'ENOENT' ? new Error('Command not found: ' + file) : e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code && !out.trim()) {
        reject(new Error(err.trim() || 'Agent exited ' + code))
        return
      }
      const reply = parseAgentResponse(out)
      if (!reply.text && err.trim()) reply.text = err.trim()
      resolve(reply)
    })
    child.stdin.on('error', () => {
      /* closed early */
    })
    child.stdin.end(body)
  })
}

function runHttp(urlStr, payload, timeoutMs) {
  let u
  try {
    u = new URL(urlStr)
  } catch {
    return Promise.reject(new Error('Invalid URL.'))
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return Promise.reject(new Error('URL must be http(s).'))
  }
  const body = JSON.stringify(payload)
  const lib = u.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs || 120000,
      },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          raw += chunk
        })
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error('HTTP ' + res.statusCode + (raw ? ': ' + raw.slice(0, 180) : '')))
            return
          }
          resolve(parseAgentResponse(raw))
        })
      }
    )
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Agent timed out.'))
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function runAgent(cfg, payload, cwd) {
  const resolved = resolveKind(cfg.kind, cfg.target)
  if (!resolved.target) {
    throw new Error(resolved.kind === 'http' ? 'Set an http URL.' : 'Set a command.')
  }
  if (resolved.kind === 'http') return runHttp(resolved.target, payload, 120000)
  return runStdio(resolved.target, payload, cwd, 120000)
}

module.exports = {
  PRESETS,
  splitArgs,
  resolveKind,
  parseAgentResponse,
  runAgent,
}
