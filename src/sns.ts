// -----------------------------------------------------------------------------
// 作者：钟智强
// -----------------------------------------------------------------------------
// AWS SNS 通知（sns.ts）
//
// 职责：向指定 SNS 主题发布一条消息。
// 说明：SNSClient / PublishCommand 是 AWS SDK v3 的官方构造，属于"库的用法"，
//       并非我们自己实现的面向对象代码，业务代码本身仍保持函数式。
// -----------------------------------------------------------------------------

import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'
import { createLogger } from './logger'

const log = createLogger('sns')

// 客户端在模块加载时创建一次，供 Lambda 热调用复用（减少冷启动开销）。
const client = new SNSClient({})

/**
 * 发布 SNS 消息。
 * @param topicArn SNS 主题 ARN
 * @param subject  标题（SNS 限制最长 100 字符，超出会被截断）
 * @param message  正文
 */
export const publishSns = async (
  topicArn: string,
  subject: string,
  message: string,
): Promise<void> => {
  const truncatedSubject = subject.slice(0, 100)

  log.debug('正在发布 SNS 消息', {
    topicArn,
    subjectLength: truncatedSubject.length,
    messageLength: message.length,
  })

  await client.send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject: truncatedSubject,
      Message: message,
    }),
  )

  log.info('SNS 消息发布成功', { topicArn })
}
