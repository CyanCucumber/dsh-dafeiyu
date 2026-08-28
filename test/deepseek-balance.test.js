import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_API_KEY_ENV,
  formatBalancePayload,
  resolveDeepSeekConnection,
} from '../src/deepseek-balance.js'

test('balance payload formats a typical DeepSeek account response', () => {
  const payload = formatBalancePayload({
    is_available: true,
    balance_infos: [
      {
        currency: 'CNY',
        total_balance: '110.00',
        granted_balance: '10.00',
        topped_up_balance: '100.00',
      },
    ],
  })
  assert.equal(payload.status, 'ok')
  assert.equal(payload.message, 'API 余额')
  assert.equal(payload.detail, '总余额 ¥110.00（充值 ¥100.00 + 赠送 ¥10.00）')
  assert.equal(payload.isAvailable, true)
})

test('balance payload joins multiple currencies and handles missing breakdown', () => {
  const payload = formatBalancePayload({
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '88.50', granted_balance: '0.00', topped_up_balance: '88.50' },
      { currency: 'USD', total_balance: '5.00' },
    ],
  })
  assert.equal(payload.status, 'ok')
  assert.equal(payload.detail, '总余额 ¥88.50（充值 ¥88.50 + 赠送 ¥0.00）；总余额 $5.00')
})

test('balance payload reports an error without balance info', () => {
  const payload = formatBalancePayload({ is_available: true, balance_infos: [] })
  assert.equal(payload.status, 'error')
  assert.equal(payload.message, '余额查询失败')
})

test('connection resolution prefers settings then the ambient environment', async () => {
  const settingsService = {
    get(namespace) {
      assert.equal(namespace, 'llm-deepseek')
      return { apiKeyEnv: 'CUSTOM_DSK_KEY', baseURL: 'https://gateway.example.com/' }
    },
  }
  const credentials = { resolve: async () => ({ value: 'stored-key' }) }
  const ctx = { get: (name) => name === 'settings' ? settingsService : credentials }
  const connection = await resolveDeepSeekConnection(ctx)
  assert.equal(connection.apiKey, 'stored-key')
  assert.equal(connection.baseURL, 'https://gateway.example.com')
  assert.equal(connection.apiKeyEnv, 'CUSTOM_DSK_KEY')
})

test('connection resolution falls back to the process environment', async () => {
  const previous = process.env[DEFAULT_API_KEY_ENV]
  process.env[DEFAULT_API_KEY_ENV] = 'env-key'
  try {
    const ctx = { get: () => undefined }
    const connection = await resolveDeepSeekConnection(ctx)
    assert.equal(connection.apiKey, 'env-key')
    assert.equal(connection.baseURL, 'https://api.deepseek.com')
  } finally {
    if (previous === undefined) delete process.env[DEFAULT_API_KEY_ENV]
    else process.env[DEFAULT_API_KEY_ENV] = previous
  }
})

test('connection resolution stays usable without any credential source', async () => {
  const connection = await resolveDeepSeekConnection({})
  assert.equal(connection.apiKey, '')
  assert.equal(connection.baseURL, 'https://api.deepseek.com')
  assert.equal(connection.apiKeyEnv, DEFAULT_API_KEY_ENV)
})
