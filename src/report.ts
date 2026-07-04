// -----------------------------------------------------------------------------
// 作者：钟智强
// -----------------------------------------------------------------------------
// 定时汇报消息构造（report.ts）
//
// 职责：
//   构造每 30 分钟定时发送的 Telegram 汇报消息（HTML 格式）。
//   与 credit.ts 中的告警消息不同，汇报消息包含：
//     - 执行状态摘要（成功/失败、耗时、重试次数）
//     - 额度快照（已用、上限、剩余、阈值）
//     - 异常检测结果
//     - 调度器运行统计
//
// 设计原则：纯函数，无副作用，便于单元测试。
// -----------------------------------------------------------------------------

import type { KeyStatus } from './openrouter'
import type { ExecutionRecord, SchedulerState } from './scheduler'

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 汇报所需的完整上下文。 */
export interface ReportContext {
  readonly appName: string
  readonly appEnv: string
  readonly threshold: number
  readonly remaining: number | null
  readonly status: KeyStatus
  readonly execution: ExecutionRecord
  readonly schedulerState: SchedulerState
}

/** 异常检测结果。 */
export interface AnomalyResult {
  readonly detected: boolean
  readonly anomalies: readonly string[]
}

// ---------------------------------------------------------------------------
// 异常检测
// ---------------------------------------------------------------------------

/** 检测额度使用中的异常情况。 */
export const detectAnomalies = (
  status: KeyStatus,
  remaining: number | null,
  threshold: number,
): AnomalyResult => {
  const anomalies: string[] = []

  // 余额低于阈值
  if (remaining !== null && remaining <= threshold) {
    anomalies.push(`Remaining balance ($${remaining.toFixed(2)}) is at or below threshold ($${threshold})`)
  }

  // 余额极低（低于阈值的 25%）
  if (remaining !== null && remaining <= threshold * 0.25) {
    anomalies.push(`CRITICAL: Balance is critically low ($${remaining.toFixed(2)})`)
  }

  // 无消费上限
  if (status.limit === null) {
    anomalies.push('No spending limit configured on this key')
  }

  // 免费额度
  if (status.isFreeTier) {
    anomalies.push('Key is on free tier with limited capacity')
  }

  // 使用率超过 90%
  if (status.limit !== null && status.limit > 0) {
    const usagePercent = (status.usage / status.limit) * 100
    if (usagePercent >= 90) {
      anomalies.push(`Usage is at ${usagePercent.toFixed(1)}% of limit`)
    }
  }

  return {
    detected: anomalies.length > 0,
    anomalies,
  }
}

// ---------------------------------------------------------------------------
// HTML 转义
// ---------------------------------------------------------------------------

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

// ---------------------------------------------------------------------------
// 汇报消息构造
// ---------------------------------------------------------------------------

/** 格式化持续时间为人类可读格式。 */
export const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

/** 构造定时汇报的 Telegram HTML 消息。 */
export const buildScheduledReport = (ctx: ReportContext): string => {
  const { appName, appEnv, threshold, remaining, status, execution, schedulerState } = ctx
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'

  // 执行状态图标
  const statusIcon = execution.status === 'success' ? 'OK' : 'FAIL'
  const statusLabel = execution.status === 'success' ? 'Success' : 'Failed'

  // 额度信息
  const limitStr = status.limit === null ? 'Not set' : `$${status.limit.toFixed(2)}`
  const remainingStr = remaining === null ? 'N/A' : `$${remaining.toFixed(4)}`

  // 使用率进度条
  let usageBar = ''
  if (status.limit !== null && status.limit > 0) {
    const percent = Math.min(100, (status.usage / status.limit) * 100)
    const filled = Math.round((percent / 100) * 20)
    const empty = 20 - filled
    usageBar = `<code>${'\u2588'.repeat(filled)}${'\u2591'.repeat(empty)}</code> ${percent.toFixed(1)}%`
  }

  // 异常检测
  const anomalyResult = detectAnomalies(status, remaining, threshold)

  // 构造消息
  const lines: string[] = [
    `<b>[${escapeHtml(appName)}] Scheduled Report</b>`,
    ``,
    `<b>Execution Summary</b>`,
    `  Status:    <b>${statusIcon} ${statusLabel}</b>`,
    `  Duration:  ${formatDuration(execution.durationMs)}`,
    `  Attempts:  ${execution.attempts + 1}`,
    `  Job:       <code>${escapeHtml(execution.jobName)}</code>`,
    ``,
    `<b>Credit Snapshot</b>`,
    `  Key:        <code>${escapeHtml(status.label)}</code>`,
    `  Used:       <b>$${status.usage.toFixed(4)}</b>`,
    `  Limit:      ${limitStr}`,
    `  Remaining:  <b>${remainingStr}</b>`,
    `  Threshold:  $${threshold}`,
    `  Tier:       ${status.isFreeTier ? 'Free' : 'Paid'}`,
  ]

  if (usageBar) {
    lines.push(`  Usage:      ${usageBar}`)
  }

  lines.push(``)

  // 异常部分
  if (anomalyResult.detected) {
    lines.push(`<b>Anomalies Detected</b>`)
    for (const anomaly of anomalyResult.anomalies) {
      lines.push(`  - ${escapeHtml(anomaly)}`)
    }
  } else {
    lines.push(`<b>Anomalies:</b> None detected`)
  }

  lines.push(``)

  // 调度器统计
  lines.push(`<b>Scheduler Stats</b>`)
  lines.push(`  Total Success: ${schedulerState.successCount}`)
  lines.push(`  Total Failure: ${schedulerState.failureCount}`)
  if (schedulerState.nextRunTime) {
    const nextRun = schedulerState.nextRunTime.replace('T', ' ').slice(0, 19) + ' UTC'
    lines.push(`  Next Run:      ${nextRun}`)
  }

  lines.push(``)

  // 错误信息（如果有）
  if (execution.error) {
    lines.push(`<b>Error Details</b>`)
    lines.push(`<code>${escapeHtml(execution.error.slice(0, 500))}</code>`)
    lines.push(``)
  }

  lines.push(`<b>Source:</b> ${escapeHtml(appName)} (${escapeHtml(appEnv)})`)
  lines.push(`<b>Time:</b>   ${now}`)
  lines.push(``)
  lines.push(`<i>Automated scheduled report - runs every 30 minutes</i>`)

  return lines.join('\n')
}

/** 构造执行失败时的紧急告警消息。 */
export const buildErrorReport = (
  appName: string,
  appEnv: string,
  error: Error,
  execution?: ExecutionRecord,
): string => {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'

  const lines: string[] = [
    `<b>[${escapeHtml(appName)}] EXECUTION ERROR</b>`,
    ``,
    `<b>Error:</b> <code>${escapeHtml(error.message.slice(0, 500))}</code>`,
    ``,
  ]

  if (execution) {
    lines.push(`<b>Execution Details</b>`)
    lines.push(`  Job:       <code>${escapeHtml(execution.jobName)}</code>`)
    lines.push(`  Duration:  ${formatDuration(execution.durationMs)}`)
    lines.push(`  Attempts:  ${execution.attempts}`)
    lines.push(``)
  }

  if (error.stack) {
    lines.push(`<b>Stack Trace</b>`)
    lines.push(`<code>${escapeHtml(error.stack.slice(0, 800))}</code>`)
    lines.push(``)
  }

  lines.push(`<b>Source:</b> ${escapeHtml(appName)} (${escapeHtml(appEnv)})`)
  lines.push(`<b>Time:</b>   ${now}`)
  lines.push(``)
  lines.push(`<i>This is a critical error notification. Immediate attention required.</i>`)

  return lines.join('\n')
}
