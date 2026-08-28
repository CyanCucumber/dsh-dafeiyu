/**
 * DeepSeek account-balance lookup for the desktop pet.
 *
 * The balance feature lives on the DSH Host side so the API key never has to
 * travel into the pet helper process: the pet only asks for a snapshot and
 * displays whatever payload comes back. The key is resolved the same way
 * `dsh-llm-deepseek` resolves it — the `llm-deepseek` settings section names a
 * credential reference (default `DEEPSEEK_API_KEY`), which the credentials
 * service resolves, falling back to the ambient process environment.
 */

const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const BALANCE_TIMEOUT_MS = 10000

function stripTrailingSlash(value) {
  return String(value ?? '').replace(/\/+$/u, '')
}

/**
 * Resolve the DeepSeek connection facts the balance endpoint needs.
 * @param ctx - the plugin context; may expose `get('settings')` and
 *   `get('credentials')` services (both optional).
 * @returns the API key (may be empty) and normalized base URL.
 */
export async function resolveDeepSeekConnection(ctx) {
  const settingsService = typeof ctx?.get === 'function' ? ctx.get('settings') : undefined
  const section = settingsService?.get?.('llm-deepseek')
  const apiKeyEnv = typeof section?.apiKeyEnv === 'string' && section.apiKeyEnv.length > 0
    ? section.apiKeyEnv
    : DEFAULT_API_KEY_ENV
  const baseURL = stripTrailingSlash(
    typeof section?.baseURL === 'string' && section.baseURL.length > 0
      ? section.baseURL
      : process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL,
  )

  let apiKey = ''
  const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(apiKeyEnv)
      apiKey = typeof hit?.value === 'string' ? hit.value : ''
    } catch {
      // A failing credential provider must not block the environment fallback.
    }
  }
  if (!apiKey) apiKey = typeof process.env[apiKeyEnv] === 'string' ? process.env[apiKeyEnv] : ''
  return { apiKey, baseURL, apiKeyEnv }
}

function currencySymbol(currency) {
  const upper = String(currency ?? '').toUpperCase()
  if (upper === 'CNY') return '¥'
  if (upper === 'USD') return '$'
  return upper ? `${upper} ` : ''
}

/**
 * Turn a DeepSeek `/user/balance` response into the companion BALANCE payload.
 * @param data - the parsed JSON response body.
 * @returns a BALANCE payload ready for `createMessage(CompanionMessageKind.BALANCE, ...)`.
 */
export function formatBalancePayload(data) {
  const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : []
  if (infos.length === 0) {
    return { status: 'error', message: '余额查询失败', detail: '账户暂无余额信息' }
  }
  const lines = infos.map((info) => {
    const symbol = currencySymbol(info?.currency)
    const total = String(info?.total_balance ?? '')
    const granted = String(info?.granted_balance ?? '')
    const toppedUp = String(info?.topped_up_balance ?? '')
    const breakdown = []
    if (toppedUp) breakdown.push(`充值 ${symbol}${toppedUp}`)
    if (granted) breakdown.push(`赠送 ${symbol}${granted}`)
    const totalLine = total ? `总余额 ${symbol}${total}` : ''
    const suffix = breakdown.length > 0 ? `（${breakdown.join(' + ')}）` : ''
    return `${totalLine}${suffix}` || '暂无余额'
  })
  return {
    status: 'ok',
    message: 'API 余额',
    detail: lines.join('；'),
    isAvailable: data?.is_available === true,
    infos: infos.map((info) => ({
      currency: info?.currency,
      totalBalance: info?.total_balance,
      grantedBalance: info?.granted_balance,
      toppedUpBalance: info?.topped_up_balance,
    })),
  }
}

/**
 * Query the DeepSeek balance endpoint and shape a companion BALANCE payload.
 * Never throws: every failure becomes an error payload the pet can display.
 * @param ctx - plugin context used to resolve the credential.
 * @param logger - optional logger for diagnostics.
 * @returns a BALANCE payload.
 */
export async function fetchDeepSeekBalance(ctx, logger) {
  let connection
  try {
    connection = await resolveDeepSeekConnection(ctx)
  } catch (error) {
    logger?.warn?.(`dsh-dafeiyu failed to resolve DeepSeek credentials: ${error instanceof Error ? error.message : String(error)}`)
    return { status: 'error', message: '余额查询失败', detail: '无法读取 DeepSeek 配置' }
  }
  if (!connection.apiKey) {
    return {
      status: 'error',
      message: '未配置 API Key',
      detail: '在 DSH 模型设置中配置 DeepSeek API Key，或设置环境变量后重试',
    }
  }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS)
    timer.unref?.()
    let response
    try {
      response = await fetch(`${connection.baseURL}/user/balance`, {
        headers: {
          authorization: `Bearer ${connection.apiKey}`,
          accept: 'application/json',
        },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      const statusText = response.statusText ? ` ${response.statusText}` : ''
      return { status: 'error', message: '余额查询失败', detail: `HTTP ${response.status}${statusText}` }
    }
    const payload = formatBalancePayload(await response.json())
    if (payload.status === 'ok' && payload.isAvailable === false) {
      payload.detail = `${payload.detail}（账户暂不可用）`
    }
    return payload
  } catch (error) {
    logger?.warn?.(`dsh-dafeiyu balance query failed: ${error instanceof Error ? error.message : String(error)}`)
    return { status: 'error', message: '余额查询失败', detail: '网络请求失败，请稍后重试' }
  }
}

export {
  BALANCE_TIMEOUT_MS,
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  currencySymbol,
  stripTrailingSlash,
}
