// -----------------------------------------------------------------------------
// 作者：钟智强
// -----------------------------------------------------------------------------
// 企业级结构化日志模块（logger.ts）
//
// 职责：提供统一的、CloudWatch 兼容的 JSON 结构化日志输出。
// 设计原则：
//   采用纯函数式 API，无 class，无全局可变状态（除日志级别配置）。
//   每条日志包含时间戳、级别、模块标识、关联 ID 及应用上下文。
//   以 JSON 单行格式输出，直接兼容 CloudWatch Logs Insights 查询语法。
//   中文消息采用专业术语，标点规范，表述清晰。
//
// CloudWatch Logs Insights 查询示例：
//   fields @timestamp, level, module, message
//   | filter level = "ERROR"
//   | sort @timestamp desc
//   | limit 50
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 日志级别枚举，数值越大优先级越高。 */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

/** 日志级别对应的数值权重，用于过滤判断。 */
const LOG_LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}

/** 结构化日志条目的完整字段定义。 */
interface LogEntry {
  readonly timestamp: string
  readonly level: LogLevel
  readonly module: string
  readonly message: string
  readonly correlationId: string
  readonly app: string
  readonly env: string
  readonly pid: number
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** 创建 Logger 实例时的配置参数。 */
export interface LoggerConfig {
  readonly appName: string
  readonly appEnv: string
  readonly level?: LogLevel
  readonly correlationId?: string
}

// ---------------------------------------------------------------------------
// 模块级状态
// ---------------------------------------------------------------------------

let globalLevel: LogLevel = 'INFO'
let globalAppName = 'unknown'
let globalAppEnv = 'unknown'
let globalCorrelationId: string = randomUUID()

// ---------------------------------------------------------------------------
// 初始化与配置
// ---------------------------------------------------------------------------

/** 解析日志级别字符串，无效值回退为 INFO。 */
export const parseLogLevel = (raw: string | undefined): LogLevel => {
  if (raw === undefined) return 'INFO'
  const upper = raw.toUpperCase()
  if (upper in LOG_LEVEL_WEIGHT) return upper as LogLevel
  return 'INFO'
}

/** 初始化全局日志配置。应在应用启动时调用一次。 */
export const initLogger = (config: LoggerConfig): void => {
  globalAppName = config.appName
  globalAppEnv = config.appEnv
  globalLevel = config.level ?? 'INFO'
  globalCorrelationId = config.correlationId ?? randomUUID()
}

/** 获取当前关联 ID（用于跨模块追踪同一次执行）。 */
export const getCorrelationId = (): string => globalCorrelationId

/** 为新一轮执行生成新的关联 ID（每次轮询/Lambda 调用时刷新）。 */
export const refreshCorrelationId = (): string => {
  globalCorrelationId = randomUUID()
  return globalCorrelationId
}

// ---------------------------------------------------------------------------
// 核心日志输出
// ---------------------------------------------------------------------------

/** 判断给定级别是否应当输出。 */
const shouldLog = (level: LogLevel): boolean =>
  LOG_LEVEL_WEIGHT[level] >= LOG_LEVEL_WEIGHT[globalLevel]

/** 构造并输出一条结构化日志。 */
const emit = (
  level: LogLevel,
  module: string,
  message: string,
  metadata?: Readonly<Record<string, unknown>>,
): void => {
  if (!shouldLog(level)) return

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    module,
    message,
    correlationId: globalCorrelationId,
    app: globalAppName,
    env: globalAppEnv,
    pid: process.pid,
    ...(metadata !== undefined ? { metadata } : {}),
  }

  const line = JSON.stringify(entry)

  switch (level) {
    case 'ERROR':
      process.stderr.write(line + '\n')
      break
    case 'WARN':
      process.stderr.write(line + '\n')
      break
    default:
      process.stdout.write(line + '\n')
      break
  }
}

// ---------------------------------------------------------------------------
// 公开的日志函数（按模块创建子日志器）
// ---------------------------------------------------------------------------

/** 模块级日志器接口。 */
export interface Logger {
  readonly debug: (message: string, metadata?: Readonly<Record<string, unknown>>) => void
  readonly info: (message: string, metadata?: Readonly<Record<string, unknown>>) => void
  readonly warn: (message: string, metadata?: Readonly<Record<string, unknown>>) => void
  readonly error: (message: string, metadata?: Readonly<Record<string, unknown>>) => void
}

/**
 * 创建指定模块的日志器。
 * 每个模块文件在顶部调用一次，后续使用返回的 logger 对象输出日志。
 *
 * @example
 * const log = createLogger('handler')
 * log.info('额度检查完成', { remaining: 42.5 })
 */
export const createLogger = (module: string): Logger => ({
  debug: (message, metadata) => emit('DEBUG', module, message, metadata),
  info: (message, metadata) => emit('INFO', module, message, metadata),
  warn: (message, metadata) => emit('WARN', module, message, metadata),
  error: (message, metadata) => emit('ERROR', module, message, metadata),
})
