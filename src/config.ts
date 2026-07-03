// -----------------------------------------------------------------------------
// 作者：钟智强
// -----------------------------------------------------------------------------
// 配置加载模块（config.ts）
//
// 职责：从环境变量读取并校验运行所需的全部配置。
// 设计原则：
//   仅在此模块读取 process.env，其它模块通过参数拿到配置（依赖显式传递）。
//   全部使用纯函数，不使用 class（遵循 "NO OOP" 要求）。
//   返回只读对象，避免运行期被意外修改。
// -----------------------------------------------------------------------------

import { createLogger, parseLogLevel, type LogLevel } from './logger'

const log = createLogger('config')

export interface Env {
  /** 应用标识名称，用于在通知和日志中标明来源。 */
  readonly appName: string
  /** 运行环境标识（如 local / staging / production / lambda）。 */
  readonly appEnv: string
  /** 日志输出级别。默认 INFO。 */
  readonly logLevel: LogLevel
  /** OpenRouter API 密钥（形如 sk-or-v1-...）。请务必通过密钥管理服务注入。 */
  readonly openRouterApiKey: string
  /** 余额告警阈值：剩余额度 <= 该值时触发通知。默认 100。 */
  readonly threshold: number
  /** 可选的 HTTP 代理地址，对应 curl 的 -x 参数（如 http://127.0.0.1:9000）。 */
  readonly proxyUrl: string | undefined
  /** Telegram 机器人 Token（由 @BotFather 获取）。 */
  readonly telegramBotToken: string
  /** Telegram 目标会话 ID（chat_id）。 */
  readonly telegramChatId: string
  /** AWS SNS 主题 ARN，用于发布告警消息。 */
  readonly snsTopicArn: string
  /** 本地监控轮询间隔（分钟）。默认 5 分钟。 */
  readonly checkIntervalMinutes: number
}

/** 读取必填环境变量；缺失或为空则直接抛错，避免带着错误配置运行。 */
const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`缺少必填环境变量：${name}`)
  }
  return value
}

/** 读取可选环境变量；不存在时返回 undefined。 */
const optional = (name: string): string | undefined => {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

/** 加载并校验全部配置，返回只读的 Env 对象。 */
export const loadEnv = (): Env => {
  const threshold = Number(process.env.CREDIT_THRESHOLD ?? '100')
  if (Number.isNaN(threshold)) {
    throw new Error('环境变量 CREDIT_THRESHOLD 必须为有效数字')
  }

  const checkIntervalMinutes = Number(process.env.CHECK_INTERVAL_MINUTES ?? '5')
  if (Number.isNaN(checkIntervalMinutes) || checkIntervalMinutes < 1) {
    throw new Error('环境变量 CHECK_INTERVAL_MINUTES 必须为 >= 1 的有效数字')
  }

  const logLevel = parseLogLevel(process.env.LOG_LEVEL)

  const env: Env = {
    appName: required('APP_NAME'),
    appEnv: process.env.APP_ENV ?? 'local',
    logLevel,
    openRouterApiKey: required('OPENROUTER_API_KEY'),
    threshold,
    proxyUrl: optional('OPENROUTER_PROXY'),
    telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
    telegramChatId: required('TELEGRAM_CHAT_ID'),
    snsTopicArn: required('SNS_TOPIC_ARN'),
    checkIntervalMinutes,
  }

  log.debug('配置加载完成', {
    appName: env.appName,
    appEnv: env.appEnv,
    logLevel: env.logLevel,
    threshold: env.threshold,
    checkIntervalMinutes: env.checkIntervalMinutes,
    proxyConfigured: env.proxyUrl !== undefined,
  })

  return env
}
