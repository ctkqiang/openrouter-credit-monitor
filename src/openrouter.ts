// -----------------------------------------------------------------------------
// 作者：钟智强
// -----------------------------------------------------------------------------
// OpenRouter 客户端（openrouter.ts）
//
// 职责：调用 GET https://openrouter.ai/api/v1/key，获取当前 API 密钥的
//       额度使用情况（已用多少、上限多少、还剩多少）。
//
// 说明：/key 接口只有在"密钥本身设置了消费上限"时才会返回 limit_remaining；
//       否则需要用 limit - usage 推算，或改用账户级的 /api/v1/credits 接口。
// -----------------------------------------------------------------------------

import { fetch, ProxyAgent, type RequestInit } from 'undici'
import { createLogger } from './logger'

const log = createLogger('openrouter')

/** 我们关心的密钥状态（对原始响应做了规整）。 */
export interface KeyStatus {
  /** 密钥标签（脱敏后的名称）。 */
  readonly label: string
  /** 该密钥已消费的额度。 */
  readonly usage: number
  /** 该密钥设置的消费上限；未设置则为 null。 */
  readonly limit: number | null
  /** 该上限下的剩余额度；未设置上限则为 null。 */
  readonly limitRemaining: number | null
  /** 是否为免费额度。 */
  readonly isFreeTier: boolean
}

/** OpenRouter /key 的原始响应结构（字段类型未知，需在运行期校验）。 */
interface RawKeyResponse {
  readonly data?: {
    readonly label?: unknown
    readonly usage?: unknown
    readonly limit?: unknown
    readonly limit_remaining?: unknown
    readonly is_free_tier?: unknown
  }
}

/** 断言某个值为数字，否则抛出带字段名的错误（避免 as 强制转换隐藏问题）。 */
const asNumber = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`响应字段 "${field}" 期望为数字类型，实际值为：${JSON.stringify(value)}`)
  }
  return value
}

/** 允许为空的数字：null/undefined 归一化为 null，其余按数字校验。 */
const asNullableNumber = (value: unknown, field: string): number | null =>
  value === null || value === undefined ? null : asNumber(value, field)

const API_URL = 'https://openrouter.ai/api/v1/key'

/**
 * 查询密钥额度状态。
 * @param apiKey   OpenRouter API 密钥
 * @param proxyUrl 可选代理地址（对应 curl 的 -x），本地调试用；Lambda 中留空
 */
export const fetchKeyStatus = async (
  apiKey: string,
  proxyUrl?: string,
): Promise<KeyStatus> => {
  log.debug('正在请求 OpenRouter 密钥状态接口', {
    endpoint: API_URL,
    proxyConfigured: proxyUrl !== undefined,
  })

  const init: RequestInit = {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  }

  if (proxyUrl !== undefined) {
    init.dispatcher = new ProxyAgent(proxyUrl)
    log.debug('已配置 HTTP 代理', { proxyUrl })
  }

  const response = await fetch(API_URL, init)

  if (!response.ok) {
    const body = await response.text()
    log.error('OpenRouter 接口返回非成功状态码', {
      statusCode: response.status,
      responseBody: body.slice(0, 500),
    })
    throw new Error(`OpenRouter 接口返回 HTTP ${response.status}：${body}`)
  }

  const payload = (await response.json()) as RawKeyResponse
  const data = payload.data
  if (data === undefined) {
    log.error('OpenRouter 响应缺少 "data" 字段', { payload })
    throw new Error('OpenRouter 响应格式异常：缺少 "data" 字段')
  }

  const status: KeyStatus = {
    label: typeof data.label === 'string' ? data.label : 'unknown',
    usage: asNumber(data.usage, 'usage'),
    limit: asNullableNumber(data.limit, 'limit'),
    limitRemaining: asNullableNumber(data.limit_remaining, 'limit_remaining'),
    isFreeTier: data.is_free_tier === true,
  }

  log.debug('密钥状态解析完成', {
    label: status.label,
    usage: status.usage,
    limit: status.limit,
    limitRemaining: status.limitRemaining,
    isFreeTier: status.isFreeTier,
  })

  return status
}
