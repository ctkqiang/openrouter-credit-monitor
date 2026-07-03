// -----------------------------------------------------------------------------
// 作者：钟智强
// -----------------------------------------------------------------------------
// 额度计算与消息构造（credit.ts）
//
// 本模块只包含“纯函数”：给定输入必得相同输出、无副作用（不发网络、不读环境）。
// 这样便于单元测试，也把“判断逻辑”与“IO 逻辑”清晰隔离。
// -----------------------------------------------------------------------------

import type { KeyStatus } from './openrouter'

/**
 * 计算剩余额度。
 * 优先使用密钥自带的 limitRemaining；若不存在则用 limit - usage 推算；
 * 若密钥没有任何上限，则无法判断"剩余"，返回 null。
 */
export const computeRemaining = (status: KeyStatus): number | null => {
  if (status.limitRemaining !== null) return status.limitRemaining
  if (status.limit !== null) return status.limit - status.usage
  return null
}

/** 判断是否应当告警：剩余额度小于等于阈值时告警。 */
export const shouldAlert = (remaining: number, threshold: number): boolean =>
  remaining <= threshold

/** 应用来源上下文，用于在通知中标明告警来自哪个应用和环境。 */
export interface AppContext {
  readonly appName: string
  readonly appEnv: string
}

/** 构造 SNS 告警正文（纯文本，适合邮件/短信通道）。 */
export const buildAlertMessage = (
  ctx: AppContext,
  status: KeyStatus,
  remaining: number,
  threshold: number,
): string =>
  [
    `[${ctx.appName}] OpenRouter Credit Alert`,
    '',
    `Application: ${ctx.appName}`,
    `Environment: ${ctx.appEnv}`,
    '',
    `Key:         ${status.label}`,
    `Used:        $${status.usage.toFixed(4)}`,
    `Limit:       ${status.limit === null ? 'Not set' : '$' + status.limit.toFixed(4)}`,
    `Remaining:   $${remaining.toFixed(4)}`,
    `Threshold:   $${threshold}`,
    '',
    `Time: ${new Date().toISOString()}`,
  ].join('\n')

/** 构造告警标题（用于 SNS 的 Subject，注意 SNS 限制 100 字符）。 */
export const buildAlertSubject = (ctx: AppContext, remaining: number): string =>
  `[${ctx.appName}] Credit Alert: $${remaining.toFixed(2)} remaining`

/** 计算使用百分比（用于进度条展示）。 */
const usagePercent = (used: number, limit: number | null): number => {
  if (limit === null || limit <= 0) return 0
  return Math.min(100, (used / limit) * 100)
}

/** 生成文本进度条。 */
const progressBar = (percent: number, width: number = 20): string => {
  const filled = Math.round((percent / 100) * width)
  const empty = width - filled
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty)
}

/** 选择告警级别标识。 */
const severityBadge = (remaining: number, threshold: number): string => {
  const ratio = remaining / threshold
  if (ratio <= 0.25) return 'CRITICAL'
  if (ratio <= 0.5) return 'HIGH'
  if (ratio <= 1.0) return 'WARNING'
  return 'INFO'
}

/**
 * 构造 Telegram 告警消息（HTML 格式）。
 * 结构化、美观、包含所有关键信息及应用来源上下文。
 */
export const buildTelegramMessage = (
  ctx: AppContext,
  status: KeyStatus,
  remaining: number,
  threshold: number,
): string => {
  const percent = usagePercent(status.usage, status.limit)
  const bar = progressBar(percent)
  const severity = severityBadge(remaining, threshold)
  const limitStr = status.limit === null ? 'Not set' : `$${status.limit.toFixed(2)}`
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'

  return [
    `<b>[${escapeHtml(ctx.appName)}] OpenRouter Credit Alert</b>`,
    `<b>${severity}</b>`,
    ``,
    `<b>Source</b>`,
    `  Application:  <code>${escapeHtml(ctx.appName)}</code>`,
    `  Environment:  <code>${escapeHtml(ctx.appEnv)}</code>`,
    ``,
    `<b>Key:</b>  <code>${escapeHtml(status.label)}</code>`,
    ``,
    `<b>Usage Breakdown</b>`,
    `<code>${bar}</code> ${percent.toFixed(1)}%`,
    ``,
    `  Used:       <b>$${status.usage.toFixed(4)}</b>`,
    `  Limit:      ${limitStr}`,
    `  Remaining:  <b>$${remaining.toFixed(4)}</b>`,
    `  Threshold:  $${threshold}`,
    ``,
    `<b>Status:</b> ${status.isFreeTier ? 'Free Tier' : 'Paid'}`,
    `<b>Time:</b>   ${now}`,
    ``,
    `<i>Automated alert from ${escapeHtml(ctx.appName)} (${escapeHtml(ctx.appEnv)})</i>`,
  ].join('\n')
}

/** HTML 特殊字符转义（Telegram HTML parse_mode 要求）。 */
const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
