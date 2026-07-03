// -----------------------------------------------------------------------------
// 作者：钟智强
// -----------------------------------------------------------------------------
// Telegram 通知（telegram.ts）
//
// 职责：调用 Telegram Bot API 的 sendMessage 发送一条文本消息。
// 单一函数，无 class。
// -----------------------------------------------------------------------------

import { fetch } from 'undici'
import { createLogger } from './logger'

const log = createLogger('telegram')

/**
 * 发送 Telegram 消息。
 * @param botToken  机器人 Token
 * @param chatId    目标会话 ID
 * @param text      消息正文
 * @param parseMode 解析模式：'HTML' | 'MarkdownV2' | undefined（纯文本）
 */
export const sendTelegram = async (
  botToken: string,
  chatId: string,
  text: string,
  parseMode?: 'HTML' | 'MarkdownV2',
): Promise<void> => {
  log.debug('正在发送 Telegram 消息', {
    chatId,
    parseMode: parseMode ?? 'plain',
    messageLength: text.length,
  })

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  }

  if (parseMode !== undefined) {
    payload.parse_mode = parseMode
  }

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  )

  if (!response.ok) {
    const body = await response.text()
    log.error('Telegram 接口返回非成功状态码', {
      statusCode: response.status,
      responseBody: body.slice(0, 500),
    })
    throw new Error(`Telegram 接口返回 HTTP ${response.status}：${body}`)
  }

  log.info('Telegram 消息发送成功', { chatId })
}
