// -----------------------------------------------------------------------------
// 作者：钟智强
// -----------------------------------------------------------------------------
// 主流程与 Lambda 入口（handler.ts）
//
// 编排顺序：
//   加载配置 -> 初始化日志 -> 查询额度 -> 计算剩余 -> 判断阈值 -> 双通道告警
//
// 告警策略：
//   - 仅在余额首次降至阈值以下时发送通知（不重复发送）。
//   - 余额恢复到阈值以上后，重置告警状态，下次再降时重新触发。
// -----------------------------------------------------------------------------

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

const log = createLogger('handler')

/** 跟踪是否已经发送过告警，避免重复通知。 */
let alertSent = false

/** 单次检查：查询额度并在低于阈值时发送告警。返回是否发送了告警。 */
export const run = async (): Promise<boolean> => {
  const env = loadEnv()

  // 每次执行刷新关联 ID，便于追踪单次检查的完整链路。
  const correlationId = refreshCorrelationId()

  // 初始化日志器全局配置（幂等操作）。
  initLogger({
    appName: env.appName,
    appEnv: env.appEnv,
    level: env.logLevel,
    correlationId,
  })

  log.info('开始执行额度检查')

  // 查询密钥额度状态。
  const status = await fetchKeyStatus(env.openRouterApiKey, env.proxyUrl)

  // 计算剩余额度。
  const remaining = computeRemaining(status)

  // 结构化日志：额度快照，便于 CloudWatch Logs Insights 检索。
  log.info('额度查询完成', {
    keyLabel: status.label,
    used: status.usage,
    limit: status.limit,
    remaining,
    threshold: env.threshold,
    alertSent,
    isFreeTier: status.isFreeTier,
  })

  // 若密钥未设上限，无法判断"剩余"，提示改用 /credits 接口。
  if (remaining === null) {
    log.warn('该密钥未设置消费上限，无法推算剩余额度；建议改用账户级接口 GET /api/v1/credits')
    return false
  }

  // 余额恢复到阈值以上 -> 重置告警状态。
  if (!shouldAlert(remaining, env.threshold)) {
    if (alertSent) {
      log.info('额度已恢复至阈值以上，告警状态已重置', {
        remaining,
        threshold: env.threshold,
      })
      alertSent = false
    } else {
      log.info('剩余额度高于阈值，无需告警', {
        remaining,
        threshold: env.threshold,
      })
    }
    return false
  }

  // 已经发送过告警且余额仍低于阈值 -> 不重复发送。
  if (alertSent) {
    log.debug('告警已发送，余额仍低于阈值，跳过重复通知', {
      remaining,
      threshold: env.threshold,
    })
    return false
  }

  // 首次触达阈值 -> 双通道告警（SNS 纯文本 + Telegram HTML）。
  log.warn('余额低于告警阈值，准备发送通知', {
    remaining,
    threshold: env.threshold,
  })

  const ctx: AppContext = { appName: env.appName, appEnv: env.appEnv }
  const snsMessage = buildAlertMessage(ctx, status, remaining, env.threshold)
  const subject = buildAlertSubject(ctx, remaining)
  const telegramHtml = buildTelegramMessage(ctx, status, remaining, env.threshold)

  await notifyAll(env, subject, snsMessage, telegramHtml)

  alertSent = true
  log.info('告警通知已发送（SNS + Telegram）', {
    remaining,
    threshold: env.threshold,
  })
  return true
}

/**
 * AWS Lambda 入口。
 * 建议用 EventBridge Scheduler 定时触发（例如每小时一次 rate(1 hour)）。
 * Lambda 每次冷启动 alertSent 会重置，因此每次调用都会独立判断。
 */
export const handler = async (): Promise<void> => {
  await run()
}
