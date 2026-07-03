// -----------------------------------------------------------------------------
// 作者：钟智强
// -----------------------------------------------------------------------------
// 通知聚合（notify.ts）
//
// 职责：把 SNS 与 Telegram 两个通道"同时"发出。
// 关键点：使用 Promise.allSettled，保证其中一个失败不会影响另一个；
//         最后统一汇总失败情况，全部失败才抛错（便于 Lambda 重试/告警）。
// -----------------------------------------------------------------------------

import type { Env } from './config'
import { createLogger } from './logger'
import { publishSns } from './sns'
import { sendTelegram } from './telegram'

const log = createLogger('notify')

/**
 * 通过 SNS 和 Telegram 同时发送告警。
 * SNS 使用纯文本，Telegram 使用 HTML 富文本。
 * 全部通道失败时抛错；部分失败时记录警告但不阻断流程。
 */
export const notifyAll = async (
  env: Env,
  subject: string,
  snsMessage: string,
  telegramHtml: string,
): Promise<void> => {
  log.info('开始向 SNS 和 Telegram 双通道发送告警通知')

  const results = await Promise.allSettled([
    publishSns(env.snsTopicArn, subject, snsMessage),
    sendTelegram(env.telegramBotToken, env.telegramChatId, telegramHtml, 'HTML'),
  ])

  const channelNames = ['SNS', 'Telegram'] as const

  const failures: Array<{ channel: string; reason: unknown }> = []
  const successes: string[] = []

  results.forEach((result, index) => {
    const channel = channelNames[index]!
    if (result.status === 'rejected') {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
      log.error(`${channel} 通道发送失败`, { channel, error: reason })
      failures.push({ channel, reason })
    } else {
      log.debug(`${channel} 通道发送成功`, { channel })
      successes.push(channel)
    }
  })

  if (successes.length === 0) {
    log.error('所有通知通道均发送失败，将抛出异常以触发重试', {
      failedChannels: failures.map((f) => f.channel),
    })
    throw new Error('所有通知通道均发送失败')
  }

  if (failures.length > 0) {
    log.warn('部分通知通道发送失败，但至少有一个通道成功', {
      succeeded: successes,
      failed: failures.map((f) => f.channel),
    })
  } else {
    log.info('所有通知通道发送成功', { channels: successes })
  }
}
