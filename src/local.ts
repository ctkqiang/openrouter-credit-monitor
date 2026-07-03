// -----------------------------------------------------------------------------
// 作者：钟智强
// -----------------------------------------------------------------------------
// 本地监控守护进程（local.ts）
//
// 以可配置的间隔持续轮询 OpenRouter 额度，仅在余额触达阈值时发送告警。
// 不会每次轮询都发通知——只在首次触达时告警，恢复后重置。
//
// 运行：npm start
// 停止：Ctrl+C（优雅退出）
// -----------------------------------------------------------------------------

import 'dotenv/config'
import { loadEnv } from './config'
import { createLogger, initLogger } from './logger'
import { run } from './handler'

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const main = async (): Promise<void> => {
  const env = loadEnv()

  // 初始化日志器全局配置。
  initLogger({
    appName: env.appName,
    appEnv: env.appEnv,
    level: env.logLevel,
  })

  const log = createLogger('monitor')
  const intervalMs = env.checkIntervalMinutes * 60 * 1000

  log.info('监控服务启动', {
    checkIntervalMinutes: env.checkIntervalMinutes,
    threshold: env.threshold,
    logLevel: env.logLevel,
  })

  // 优雅退出：捕获 SIGINT / SIGTERM 信号。
  let running = true
  const shutdown = () => {
    log.info('收到终止信号，正在优雅关闭监控服务……')
    running = false
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  while (running) {
    try {
      const alerted = await run()
      if (alerted) {
        log.info('本轮检查已触发告警通知，后续不再重复发送，直至额度恢复')
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('本轮额度检查执行失败', {
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
      })
    }

    if (!running) break

    log.debug('等待下一轮检查', { nextCheckInMinutes: env.checkIntervalMinutes })
    await sleep(intervalMs)
  }

  log.info('监控服务已停止')
  process.exit(0)
}

main()
