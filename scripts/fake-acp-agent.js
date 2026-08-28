#!/usr/bin/env node
const readline = require('readline')

const mode = process.env.FAKE_ACP || 'chat'
const rl = readline.createInterface({ input: process.stdin })
const sessionId = 'sess-fake'

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function update(kind, extra) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: Object.assign({ sessionUpdate: kind }, extra),
    },
  })
}

function nextLine() {
  return new Promise((resolve) => {
    rl.once('line', resolve)
  })
}

async function main() {
  for (;;) {
    const line = await nextLine()
    if (line == null) return
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.method === 'initialize') {
      reply(msg.id, {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { embeddedContext: true } },
        agentInfo: { name: 'fake-acp', title: 'Fake ACP' },
        authMethods: [],
      })
    } else if (msg.method === 'session/new') {
      reply(msg.id, { sessionId })
    } else if (msg.method === 'session/prompt') {
      await turn(msg)
    } else if (msg.method === 'session/cancel') {
      /* ignored */
    }
  }
}

async function turn(msg) {
  if (mode === 'fs') {
    update('tool_call', {
      toolCallId: 'call-1',
      title: 'Write note',
      kind: 'edit',
      status: 'pending',
    })
    const reqId = 'write-1'
    send({
      jsonrpc: '2.0',
      id: reqId,
      method: 'fs/write_text_file',
      params: {
        sessionId,
        path: process.env.FAKE_ACP_PATH,
        content: '<p>from-agent</p>',
      },
    })
    await nextLine()
    update('tool_call_update', { toolCallId: 'call-1', status: 'completed' })
    update('agent_message_chunk', { content: { type: 'text', text: 'wrote it' } })
    reply(msg.id, { stopReason: 'end_turn' })
    return
  }
  if (mode === 'perm') {
    send({
      jsonrpc: '2.0',
      id: 'perm-1',
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: 'call-p', title: 'Run tests' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    })
    const line = await nextLine()
    let decided = 'allow-once'
    try {
      const res = JSON.parse(line)
      decided = res.result && res.result.outcome && res.result.outcome.optionId
    } catch {
      /* default */
    }
    update('agent_message_chunk', {
      content: { type: 'text', text: 'choice:' + decided },
    })
    reply(msg.id, { stopReason: 'end_turn' })
    return
  }
  update('agent_message_chunk', { content: { type: 'text', text: 'hello ' } })
  update('agent_message_chunk', { content: { type: 'text', text: 'vault' } })
  reply(msg.id, { stopReason: 'end_turn' })
}

main()
