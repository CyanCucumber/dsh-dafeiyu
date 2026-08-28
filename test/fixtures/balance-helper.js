// Test helper that requests a balance snapshot and records everything it
// receives, exercising the balance-request reply path of the companion
// protocol. Usage: node balance-helper.js <received-lines-file>
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const receivedPath = process.argv[2]

process.stdout.write(`${JSON.stringify({ protocolVersion: 1, kind: 'ready' })}\n`)

let requested = false
createInterface({ input: process.stdin }).on('line', (line) => {
  if (receivedPath) appendFileSync(receivedPath, `${line}\n`)
  const message = JSON.parse(line)
  if (!requested && message.kind === 'state') {
    requested = true
    process.stdout.write(`${JSON.stringify({ protocolVersion: 1, kind: 'balance-request' })}\n`)
  }
  if (message.kind === 'shutdown') process.exit(0)
})
