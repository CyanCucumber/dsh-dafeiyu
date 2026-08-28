// Test helper that answers every non-idle state it receives with an approval
// decision, exercising the approval-decision reply path of the companion
// protocol. Usage: node approval-helper.js
import { createInterface } from 'node:readline'

process.stdout.write(`${JSON.stringify({ protocolVersion: 1, kind: 'ready' })}\n`)

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.kind === 'state' && message.state !== 'IDLE') {
    process.stdout.write(`${JSON.stringify({
      protocolVersion: 1,
      kind: 'approval-decision',
      approvalId: 'approval-test-1',
      decision: 'yes',
    })}\n`)
  }
  if (message.kind === 'shutdown') process.exit(0)
})
