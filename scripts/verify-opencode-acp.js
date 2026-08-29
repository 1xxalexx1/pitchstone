const assert = require('assert')
const { execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const agent = require('../agent-bridge')

function findOpenCode() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN
  try {
    const found = execSync('command -v opencode', { encoding: 'utf8' }).trim()
    if (found) return found
  } catch {
    /* not on PATH */
  }
  return ''
}

const bin = findOpenCode()
if (!bin) {
  console.log('skip: no opencode binary (set OPENCODE_BIN to run live ACP)')
  process.exit(0)
}

const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-oc-live-'))
const events = []
const host = new agent.AcpHost({
  command: bin + ' acp',
  cwd: vault,
  readFile: async (filePath) => fs.promises.readFile(filePath, 'utf8'),
  writeFile: async (filePath, content) => fs.promises.writeFile(filePath, content),
  askPermission: async (payload) => {
    const allow = (payload.options || []).find((o) =>
      String(o.kind || '').startsWith('allow')
    )
    return allow
      ? { optionId: allow.optionId, kind: allow.kind }
      : { cancelled: true }
  },
  onEvent: (ev) => events.push(ev),
})

const timer = setTimeout(() => {
  host.dispose()
  fs.rmSync(vault, { recursive: true, force: true })
  console.error('opencode ACP timed out')
  process.exit(1)
}, 60000)

;(async () => {
  const info = await host.start()
  assert.ok(info.sessionId)
  await host.prompt([
    {
      type: 'text',
      text: 'Reply with exactly the word pong and nothing else. Do not use tools.',
    },
  ])
  const text = events
    .filter((e) => e.type === 'chunk')
    .map((e) => e.text)
    .join('')
  assert.match(text, /pong/i)
  clearTimeout(timer)
  host.dispose()
  fs.rmSync(vault, { recursive: true, force: true })
  console.log('ok opencode acp', info.agent && info.agent.agentInfo && info.agent.agentInfo.version)
})().catch((err) => {
  clearTimeout(timer)
  try {
    host.dispose()
  } catch {
    /* */
  }
  fs.rmSync(vault, { recursive: true, force: true })
  console.error(err)
  process.exit(1)
})
