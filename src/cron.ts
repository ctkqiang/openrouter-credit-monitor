// -----------------------------------------------------------------------------
// 作者：钟智强
// -----------------------------------------------------------------------------
// Cron 调度入口（cron.ts）
//
// 以真正的 cron 表达式驱动额度检查，每 30 分钟执行一次。
// 每次执行后将结果通过 Telegram 发送格式化汇报消息。
//
// 与 local.ts 的区别：
//   local.ts 使用简单的 setInterval 轮询，适合快速调试。
//   cron.ts 使用精确的 cron 表达式调度，支持时区、并发锁、重试、
//   详细汇报，适合生产环境长期运行。
//
// 运行：npm run cron
// 停止：Ctrl+C（优雅退出）
// -----------------------------------------------------------------------------

import 'dotenv/config'
import { loadEnv } from './config'
import { createLogger, initLogger, refreshCorrelationId } from './logger'
import { fetchKeyStatus } from './openrouter'
import {
  computeRemaining,
  shouldAlert,
  buildAlertMessage,
  buildAlertSubject,
  buildTelegramMessage,
  type AppContext,
} from './credit'
import { notifyAll } from './notify'
import { sendTelegram } from './telegram'
import {
  startScheduler,
  createDefaultConfig,
  type ExecutionRecord,
  type SchedulerState,
} from './scheduler'
import { buildScheduledReport, buildErrorReport, type ReportContext } from './report'

const log = createLogger('cron')

/** 跟踪是否已经发送过告警，避免重复通知。 */
let alertSent = false

/**
 * 单次额度检查任务（复用 handler.ts 的核心逻辑）。
 * 返回检查结果摘要，供汇报消息使用。
 */
const checkCredit = async (): Promise<{
  alerted: boolean
  remaining: number | null
  status: Awaited<ReturnType<typeof fetchKeyStatus>>
}> => {
  const env = loadEnv()

  // 每次执行刷新关联 ID
  const correlationId = refreshCorrelationId()
  initLogger({
    appName: env.appName,
    appEnv: env.appEnv,
    level: env.logLevel,
    correlationId,
  })

  log.info('开始执行额度检查')

  const status = await fetchKeyStatus(env.openRouterApiKey, env.proxyUrl)
  const remaining = computeRemaining(status)

  log.info('额度查询完成', {
    keyLabel: status.label,
    used: status.usage,
    limit: status.limit,
    remaining,
    threshold: env.threshold,
    alertSent,
    isFreeTier: status.isFreeTier,
  })

  if (remaining === null) {
    log.warn('该密钥未设置消费上限，无法推算剩余额度')
    return { alerted: false, remaining, status }
  }

  // 余额恢复到阈值以上 -> 重置告警状态
  if (!shouldAlert(remaining, env.threshold)) {
    if (alertSent) {
      log.info('额度已恢复至阈值以上，告警状态已重置', { remaining, threshold: env.threshold })
      alertSent = false
    }
    return { alerted: false, remaining, status }
  }

  // 已经发送过告警 -> 不重复发送
  if (alertSent) {
    log.debug('告警已发送，跳过重复通知', { remaining, threshold: env.threshold })
    return { alerted: false, remaining, status }
  }

  // 首次触达阈值 -> 双通道告警
  log.warn('余额低于告警阈值，准备发送通知', { remaining, threshold: env.threshold })

  const ctx: AppContext = { appName: env.appName, appEnv: env.appEnv }
  const snsMessage = buildAlertMessage(ctx, status, remaining, env.threshold)
  const subject = buildAlertSubject(ctx, remaining)
  const telegramHtml = buildTelegramMessage(ctx, status, remaining, env.threshold)

  await notifyAll(env, subject, snsMessage, telegramHtml)

  alertSent = true
  log.info('告警通知已发送（SNS + Telegram）')
  return { alerted: true, remaining, status }
}

/**
 * 执行后回调：发送 Telegram 汇报消息。
 */
const onExecution = async (
  record: ExecutionRecord,
  getState: () => SchedulerState,
): Promise<void> => {
  const env = loadEnv()

  try {
    // 获取最新的额度状态用于汇报
    // 如果执行成功，result 中包含检查结果
    const checkResult = record.result as {
      remaining: number | null
      status: Awaited<ReturnType<typeof fetchKeyStatus>>
    } | undefined

    if (!checkResult) {
      log.warn('执行结果为空，跳过汇报消息发送')
      return
    }

    const reportCtx: ReportContext = {
      appName: env.appName,
      appEnv: env.appEnv,
      threshold: env.threshold,
      remaining: checkResult.remaining,
      status: checkResult.status,
      execution: record,
      schedulerState: getState(),
    }

    const reportHtml = buildScheduledReport(reportCtx)

    await sendTelegram(env.telegramBotToken, env.telegramChatId, reportHtml, 'HTML')
    log.info('定时汇报消息已发送至 Telegram')
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    log.error('发送定时汇报消息失败', { error: message })
  }
}

/**
 * 执行异常回调：发送错误告警至 Telegram。
 */
const onError = async (error: Error): Promise<void> => {
  const env = loadEnv()

  try {
    const errorHtml = buildErrorReport(env.appName, env.appEnv, error)
    await sendTelegram(env.telegramBotToken, env.telegramChatId, errorHtml, 'HTML')
    log.info('错误告警已发送至 Telegram')
  } catch (sendError: unknown) {
    const message = sendError instanceof Error ? sendError.message : String(sendError)
    log.error('发送错误告警失败', { error: message })
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

const main = (): void => {
  const env = loadEnv()

  initLogger({
    appName: env.appName,
    appEnv: env.appEnv,
    level: env.logLevel,
  })

  // 从环境变量读取 cron 配置，默认每 30 分钟
  const cronExpression = process.env.CRON_EXPRESSION ?? '*/30 * * * *'
  const timezone = process.env.CRON_TIMEZONE ?? 'UTC'
  const maxRetries = Number(process.env.CRON_MAX_RETRIES ?? '3')
  const baseRetryDelayMs = Number(process.env.CRON_RETRY_DELAY_MS ?? '1000')

  const config = createDefaultConfig({
    cronExpression,
    timezone,
    maxRetries,
    baseRetryDelayMs,
    jobName: 'credit-check',
  })

  log.info('Cron 调度服务启动', {
    cronExpression: config.cronExpression,
    timezone: config.timezone,
    maxRetries: config.maxRetries,
    threshold: env.threshold,
    logLevel: env.logLevel,
  })

  const { stop, getState } = startScheduler(checkCredit, config, {
    onExecution: (record) => onExecution(record, getState),
    onError,
  })

  // 优雅退出
  const shutdown = (): void => {
    log.info('收到终止信号，正在优雅关闭 Cron 调度服务……')
    stop()
    const state = getState()
    log.info('Cron 调度服务已停止', {
      totalSuccess: state.successCount,
      totalFailure: state.failureCount,
    })
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  log.info('Cron 调度服务已就绪，等待下次触发……')
}

main()
