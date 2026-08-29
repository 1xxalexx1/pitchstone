const { spawn } = require('child_process')
const http = require('http')
const https = require('https')

const PROTOCOL_VERSION = 1

const PRESETS = {
  acp: { kind: 'acp', target: '' },
  claude: { kind: 'acp', target: 'claude --acp' },
  gemini: { kind: 'acp', target: 'gemini --acp' },
  cursor: { kind: 'acp', target: 'agent acp' },
  opencode: { kind: 'acp', target: 'opencode acp' },
  pi: { kind: 'acp', target: 'pi' },
  stdio: { kind: 'acp', target: '' },
  json: { kind: 'json', target: '' },
  http: { kind: 'http', target: '' },
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
  if (preset) {
    return { kind: preset.kind, target: target || preset.target }
  }
  if (kind === 'http') return { kind: 'http', target }
  if (kind === 'json') return { kind: 'json', target }
  return { kind: 'acp', target }
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
  if (resolved.kind === 'json') return runStdio(resolved.target, payload, cwd, 120000)
  throw new Error('Use an ACP session for this adapter.')
}

function contentText(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join('')
  if (typeof content !== 'object') return String(content)
  if (content.type === 'text') return String(content.text || '')
  if (content.content) return contentText(content.content)
  if (content.text) return String(content.text)
  return ''
}

function toolTitle(params) {
  const tool = params && params.toolCall
  if (!tool || typeof tool !== 'object') return 'Tool'
  return String(tool.title || tool.kind || 'Tool')
}

function pickAllow(options) {
  const list = Array.isArray(options) ? options : []
  const always = list.find((o) => o && o.kind === 'allow_always')
  if (always) return String(always.optionId)
  const once = list.find((o) => o && o.kind === 'allow_once')
  if (once) return String(once.optionId)
  return list[0] ? String(list[0].optionId) : ''
}

function pickReject(options) {
  const list = Array.isArray(options) ? options : []
  const always = list.find((o) => o && o.kind === 'reject_always')
  if (always) return String(always.optionId)
  const once = list.find((o) => o && o.kind === 'reject_once')
  if (once) return String(once.optionId)
  return ''
}

class AcpHost {
  constructor(opts) {
    this.command = String((opts && opts.command) || '')
    this.cwd = opts && opts.cwd
    this.readFile = opts && opts.readFile
    this.writeFile = opts && opts.writeFile
    this.askPermission = opts && opts.askPermission
    this.onEvent = (opts && opts.onEvent) || function () {}
    this.child = null
    this.buf = ''
    this.nextId = 1
    this.pending = new Map()
    this.sessionId = null
    this.busy = false
    this.autoAllow = false
    this.alive = false
    this.permWait = null
  }

  emit(event) {
    try {
      this.onEvent(event)
    } catch {
      /* renderer errors stay in renderer */
    }
  }

  state() {
    if (!this.alive) return 'idle'
    if (this.busy) return 'busy'
    return 'ready'
  }

  send(obj) {
    if (!this.child || !this.child.stdin.writable) {
      return Promise.reject(new Error('Agent is not running.'))
    }
    this.child.stdin.write(JSON.stringify(obj) + '\n')
  }

  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  reply(id, result) {
    this.send({ jsonrpc: '2.0', id, result })
  }

  replyError(id, message, code) {
    this.send({
      jsonrpc: '2.0',
      id,
      error: { code: code || -32000, message: String(message || 'Error') },
    })
  }

  onLine(line) {
    if (!line) return
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg && msg.method && msg.id != null) {
      void this.onRequest(msg)
      return
    }
    if (msg && msg.method && msg.id == null) {
      this.onNotice(msg)
      return
    }
    if (msg && msg.id != null && this.pending.has(msg.id)) {
      const wait = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) wait.reject(new Error(msg.error.message || 'Agent error'))
      else wait.resolve(msg.result)
    }
  }

  onNotice(msg) {
    if (msg.method !== 'session/update') return
    const params = msg.params || {}
    const update = params.update || {}
    const kind = update.sessionUpdate
    if (kind === 'agent_message_chunk') {
      this.emit({ type: 'chunk', text: contentText(update.content) })
    } else if (kind === 'agent_thought_chunk') {
      this.emit({ type: 'thought', text: contentText(update.content) })
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.emit({
        type: 'tool',
        toolCallId: String(update.toolCallId || ''),
        title: String(update.title || ''),
        kind: String(update.kind || ''),
        status: String(update.status || (kind === 'tool_call' ? 'pending' : '')),
        detail: contentText(update.content),
        path: toolPath(update),
      })
    }
  }

  async onRequest(msg) {
    const method = msg.method
    const params = msg.params || {}
    try {
      if (method === 'session/request_permission') {
        const result = await this.handlePermission(params)
        this.reply(msg.id, result)
        return
      }
      if (method === 'fs/read_text_file') {
        if (!this.readFile) {
          this.replyError(msg.id, 'File read is not available.', -32601)
          return
        }
        const file = await this.readFile(String(params.path || ''))
        this.reply(msg.id, { content: file })
        return
      }
      if (method === 'fs/write_text_file') {
        if (!this.writeFile) {
          this.replyError(msg.id, 'File write is not available.', -32601)
          return
        }
        await this.writeFile(String(params.path || ''), String(params.content || ''))
        this.emit({ type: 'wrote', path: String(params.path || '') })
        this.reply(msg.id, {})
        return
      }
      this.replyError(msg.id, 'Method not found: ' + method, -32601)
    } catch (err) {
      this.replyError(msg.id, err.message)
    }
  }

  async handlePermission(params) {
    const options = Array.isArray(params.options) ? params.options : []
    if (this.autoAllow) {
      const id = pickAllow(options)
      if (id) return { outcome: { outcome: 'selected', optionId: id } }
    }
    if (!this.askPermission) {
      const id = pickAllow(options)
      if (!id) return { outcome: { outcome: 'cancelled' } }
      return { outcome: { outcome: 'selected', optionId: id } }
    }
    const payload = {
      title: toolTitle(params),
      options: options.map((o) => ({
        optionId: String(o.optionId || ''),
        name: String(o.name || o.optionId || ''),
        kind: String(o.kind || ''),
      })),
    }
    const choice = await new Promise((resolve) => {
      let done = false
      const finish = (value) => {
        if (done) return
        done = true
        this.permWait = null
        resolve(value)
      }
      this.permWait = finish
      Promise.resolve(this.askPermission(payload)).then(finish, () =>
        finish({ cancelled: true })
      )
    })
    if (!choice || choice.cancelled) return { outcome: { outcome: 'cancelled' } }
    if (choice.kind === 'allow_always') this.autoAllow = true
    return { outcome: { outcome: 'selected', optionId: String(choice.optionId) } }
  }

  start() {
    if (this.alive) return Promise.resolve({ sessionId: this.sessionId })
    const args = splitArgs(this.command)
    const file = args.shift()
    if (!file) return Promise.reject(new Error('Set a command.'))
    this.emit({ type: 'status', status: 'starting', text: this.command })
    return new Promise((resolve, reject) => {
      let opened = false
      try {
        this.child = spawn(file, args, {
          cwd: this.cwd || undefined,
          env: process.env,
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (err) {
        reject(err)
        return
      }
      this.alive = true
      this.buf = ''
      this.child.stdout.setEncoding('utf8')
      this.child.stderr.setEncoding('utf8')
      this.child.stdout.on('data', (chunk) => {
        this.buf += chunk
        let nl
        while ((nl = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, nl).replace(/\r$/, '')
          this.buf = this.buf.slice(nl + 1)
          this.onLine(line)
        }
      })
      this.child.stderr.on('data', () => {
        /* agent logs stay off the thread */
      })
      this.child.on('error', (e) => {
        this.alive = false
        const err = e.code === 'ENOENT' ? new Error('Command not found: ' + file) : e
        this.failAll(err)
        this.emit({ type: 'error', text: err.message })
        this.emit({ type: 'status', status: 'idle', text: err.message })
        if (!opened) reject(err)
      })
      this.child.on('close', (code) => {
        const was = this.alive
        this.alive = false
        this.busy = false
        this.sessionId = null
        this.failAll(new Error(code ? 'Agent exited ' + code : 'Agent stopped.'))
        if (was) {
          this.emit({
            type: 'status',
            status: 'idle',
            text: code ? 'exited ' + code : 'stopped',
          })
        }
      })
      this.handshake().then(
        (info) => {
          opened = true
          resolve(info)
        },
        (err) => {
          this.dispose()
          reject(err)
        }
      )
    })
  }

  async handshake() {
    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
      clientInfo: { name: 'pitchstone', title: 'Pitchstone', version: '1.0.0' },
    })
    if (init && init.protocolVersion != null && Number(init.protocolVersion) !== PROTOCOL_VERSION) {
      throw new Error('Agent protocol ' + init.protocolVersion + ' is not supported.')
    }
    const created = await this.request('session/new', {
      cwd: this.cwd || process.cwd(),
      mcpServers: [],
    })
    this.sessionId = created && created.sessionId
    if (!this.sessionId) throw new Error('Agent did not return a session.')
    const name =
      (init && init.agentInfo && (init.agentInfo.title || init.agentInfo.name)) || this.command
    this.emit({ type: 'status', status: 'ready', text: String(name) })
    return { sessionId: this.sessionId, agent: init }
  }

  async prompt(blocks) {
    if (!this.alive) await this.start()
    if (this.busy) throw new Error('Agent is busy.')
    this.busy = true
    this.emit({ type: 'status', status: 'busy', text: 'running' })
    try {
      const result = await this.request('session/prompt', {
        sessionId: this.sessionId,
        prompt: blocks,
      })
      this.emit({
        type: 'turn',
        stopReason: String((result && result.stopReason) || 'end_turn'),
      })
      return result
    } finally {
      this.busy = false
      if (this.alive) this.emit({ type: 'status', status: 'ready', text: 'ready' })
    }
  }

  cancel() {
    if (!this.alive || !this.sessionId) return
    this.send({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: this.sessionId },
    })
    if (this.permWait) this.permWait({ cancelled: true })
  }

  failAll(err) {
    for (const wait of this.pending.values()) wait.reject(err)
    this.pending.clear()
    if (this.permWait) this.permWait({ cancelled: true })
  }

  dispose() {
    this.alive = false
    this.busy = false
    this.sessionId = null
    this.failAll(new Error('Agent stopped.'))
    if (this.child) {
      try {
        this.child.kill()
      } catch {
        /* already gone */
      }
      this.child = null
    }
    this.emit({ type: 'status', status: 'idle', text: 'stopped' })
  }
}

function toolPath(update) {
  if (update && update.path) return String(update.path)
  const loc = Array.isArray(update && update.locations) ? update.locations[0] : null
  if (loc && loc.path) return String(loc.path)
  const content = Array.isArray(update && update.content) ? update.content : []
  for (const item of content) {
    if (item && item.type === 'diff' && item.path) return String(item.path)
  }
  return ''
}

function promptBlocks(message, note) {
  const blocks = [{ type: 'text', text: String(message || '') }]
  if (!note || !note.path) return blocks
  const uri = 'file://' + String(note.path).replace(/\\/g, '/')
  const name = String(note.path).replace(/^.*[/\\]/, '') || 'note.html'
  blocks.push({
    type: 'resource_link',
    uri,
    name,
    mimeType: 'text/html',
  })
  if (note.html) {
    blocks.push({
      type: 'resource',
      resource: {
        uri,
        mimeType: 'text/html',
        text: String(note.html).slice(0, 200000),
      },
    })
  }
  return blocks
}

module.exports = {
  PROTOCOL_VERSION,
  PRESETS,
  splitArgs,
  resolveKind,
  parseAgentResponse,
  runAgent,
  contentText,
  pickAllow,
  pickReject,
  promptBlocks,
  AcpHost,
}
