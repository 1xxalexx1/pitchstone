const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const agent = require('../agent-bridge')

assert.deepStrictEqual(agent.splitArgs('pi --foo bar'), ['pi', '--foo', 'bar'])
assert.deepStrictEqual(agent.splitArgs('claude -p "a b"'), ['claude', '-p', 'a b'])
assert.deepStrictEqual(agent.splitArgs('  '), [])

assert.deepStrictEqual(agent.resolveKind('claude', ''), {
  kind: 'acp',
  target: 'claude --acp',
})
assert.deepStrictEqual(agent.resolveKind('http', 'http://127.0.0.1:9'), {
  kind: 'http',
  target: 'http://127.0.0.1:9',
})
assert.deepStrictEqual(agent.resolveKind('json', 'my-agent'), {
  kind: 'json',
  target: 'my-agent',
})
assert.deepStrictEqual(agent.resolveKind('stdio', 'agent acp'), {
  kind: 'acp',
  target: 'agent acp',
})

assert.deepStrictEqual(agent.parseAgentResponse('plain reply'), {
  text: 'plain reply',
  edits: [],
})
assert.deepStrictEqual(
  agent.parseAgentResponse(
    JSON.stringify({
      text: 'ok',
      edits: [{ path: 'a.html', html: '<p>x</p>' }],
    })
  ),
  { text: 'ok', edits: [{ path: 'a.html', html: '<p>x</p>' }] }
)
assert.equal(agent.parseAgentResponse('noise {"text":"hi","edits":[]}').text, 'hi')
assert.deepStrictEqual(agent.parseAgentResponse(''), { text: '', edits: [] })

assert.equal(agent.contentText({ type: 'text', text: 'hi' }), 'hi')
assert.equal(
  agent.pickAllow([
    { optionId: 'no', kind: 'reject_once' },
    { optionId: 'yes', kind: 'allow_once' },
  ]),
  'yes'
)
assert.deepStrictEqual(agent.promptBlocks('go', { path: '/vault/a.html', html: '<p>x</p>' })[0], {
  type: 'text',
  text: 'go',
})
assert.equal(agent.promptBlocks('go', { path: '/vault/a.html' })[1].type, 'resource_link')

const fake = path.join(__dirname, 'fake-acp-agent.js')

async function withHost(extra, fn) {
  const events = []
  const host = new agent.AcpHost(
    Object.assign(
      {
        command: process.execPath + ' ' + fake,
        cwd: __dirname,
        onEvent: (ev) => events.push(ev),
      },
      extra
    )
  )
  try {
    await fn(host, events)
  } finally {
    host.dispose()
  }
}

async function run() {
  await withHost({}, async (host, events) => {
    await host.start()
    assert.ok(host.sessionId)
    await host.prompt([{ type: 'text', text: 'hi' }])
    const text = events
      .filter((e) => e.type === 'chunk')
      .map((e) => e.text)
      .join('')
    assert.equal(text, 'hello vault')
    assert.equal(events.filter((e) => e.type === 'turn')[0].stopReason, 'end_turn')
  })

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-acp-'))
  const note = path.join(dir, 'note.html')
  process.env.FAKE_ACP = 'fs'
  process.env.FAKE_ACP_PATH = note
  try {
    await withHost(
      {
        writeFile: async (p, content) => {
          assert.equal(p, note)
          fs.writeFileSync(p, content)
        },
      },
      async (host) => {
        await host.prompt([{ type: 'text', text: 'write' }])
        assert.equal(fs.readFileSync(note, 'utf8'), '<p>from-agent</p>')
      }
    )
  } finally {
    delete process.env.FAKE_ACP
    delete process.env.FAKE_ACP_PATH
    fs.rmSync(dir, { recursive: true, force: true })
  }

  process.env.FAKE_ACP = 'perm'
  try {
    await withHost(
      {
        askPermission: async () => ({ optionId: 'reject-once', kind: 'reject_once' }),
      },
      async (host, events) => {
        await host.prompt([{ type: 'text', text: 'ok?' }])
        const text = events
          .filter((e) => e.type === 'chunk')
          .map((e) => e.text)
          .join('')
        assert.equal(text, 'choice:reject-once')
      }
    )
  } finally {
    delete process.env.FAKE_ACP
  }

  console.log('ok')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
