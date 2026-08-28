const assert = require('assert')
const agent = require('../agent-bridge')

assert.deepStrictEqual(agent.splitArgs('pi --foo bar'), ['pi', '--foo', 'bar'])
assert.deepStrictEqual(agent.splitArgs('claude -p "a b"'), ['claude', '-p', 'a b'])
assert.deepStrictEqual(agent.splitArgs("  "), [])

assert.deepStrictEqual(agent.resolveKind('pi', ''), { kind: 'stdio', target: 'pi' })
assert.deepStrictEqual(agent.resolveKind('http', 'http://127.0.0.1:9'), {
  kind: 'http',
  target: 'http://127.0.0.1:9',
})
assert.deepStrictEqual(agent.resolveKind('stdio', 'my-agent'), {
  kind: 'stdio',
  target: 'my-agent',
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

console.log('ok')
