// -----------------------------------------------------------------------------
// 作者：钟智强
// -----------------------------------------------------------------------------
// 调度器与汇报模块单元测试（scheduler.test.ts）
//
// 使用 Node 内置测试运行器 node:test，只测试纯函数与同步逻辑。
// 运行：npm test
// -----------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseCronField,
  parseCronExpression,
  matchesCron,
  nextCronTime,
  acquireLock,
  releaseLock,
  isLocked,
  resetLock,
  computeRetryDelay,
  executeWithRetry,
  executeScheduledJob,
  createDefaultConfig,
} from '../src/scheduler'

import {
  detectAnomalies,
  formatDuration,
  buildScheduledReport,
  buildErrorReport,
  type ReportContext,
} from '../src/report'

import type { KeyStatus } from '../src/openrouter'
import type { ExecutionRecord, SchedulerState } from '../src/scheduler'

// ---------------------------------------------------------------------------
// 辅助工具
// ---------------------------------------------------------------------------

const makeStatus = (overrides: Partial<KeyStatus> = {}): KeyStatus => ({
  label: 'test-key',
  usage: 50,
  limit: 100,
  limitRemaining: 50,
  isFreeTier: false,
  ...overrides,
})

const makeExecution = (overrides: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
  jobName: 'test-job',
  startTime: '2026-01-01T00:00:00.000Z',
  endTime: '2026-01-01T00:00:01.500Z',
  durationMs: 1500,
  status: 'success',
  attempts: 0,
  ...overrides,
})

const makeSchedulerState = (overrides: Partial<SchedulerState> = {}): SchedulerState => ({
  running: true,
  locked: false,
  successCount: 10,
  failureCount: 1,
  lastExecution: null,
  nextRunTime: '2026-01-01T00:30:00.000Z',
  ...overrides,
})

// ===========================================================================
// Cron 表达式解析测试
// ===========================================================================

test('parseCronField: 通配符 * 生成完整范围', () => {
  const result = parseCronField('*', 0, 59)
  assert.equal(result.size, 60)
  assert.ok(result.has(0))
  assert.ok(result.has(59))
})

test('parseCronField: 步进值 */30 正确解析', () => {
  const result = parseCronField('*/30', 0, 59)
  assert.equal(result.size, 2)
  assert.ok(result.has(0))
  assert.ok(result.has(30))
})

test('parseCronField: 步进值 */15 正确解析', () => {
  const result = parseCronField('*/15', 0, 59)
  assert.equal(result.size, 4)
  assert.ok(result.has(0))
  assert.ok(result.has(15))
  assert.ok(result.has(30))
  assert.ok(result.has(45))
})

test('parseCronField: 范围 1-5 正确解析', () => {
  const result = parseCronField('1-5', 1, 31)
  assert.equal(result.size, 5)
  for (let i = 1; i <= 5; i++) {
    assert.ok(result.has(i))
  }
})

test('parseCronField: 逗号分隔列表 1,15,30 正确解析', () => {
  const result = parseCronField('1,15,30', 0, 59)
  assert.equal(result.size, 3)
  assert.ok(result.has(1))
  assert.ok(result.has(15))
  assert.ok(result.has(30))
})

test('parseCronField: 范围步进 1-10/3 正确解析', () => {
  const result = parseCronField('1-10/3', 0, 59)
  assert.ok(result.has(1))
  assert.ok(result.has(4))
  assert.ok(result.has(7))
  assert.ok(result.has(10))
  assert.equal(result.size, 4)
})

test('parseCronField: 单个数值正确解析', () => {
  const result = parseCronField('5', 0, 59)
  assert.equal(result.size, 1)
  assert.ok(result.has(5))
})

test('parseCronField: 无效值抛出错误', () => {
  assert.throws(() => parseCronField('abc', 0, 59), /Cron 字段值无效/)
})

test('parseCronField: 越界范围抛出错误', () => {
  assert.throws(() => parseCronField('0-60', 0, 59), /Cron 范围越界/)
})

test('parseCronExpression: 每 30 分钟表达式正确解析', () => {
  const fields = parseCronExpression('*/30 * * * *')
  assert.equal(fields.minutes.size, 2)
  assert.ok(fields.minutes.has(0))
  assert.ok(fields.minutes.has(30))
  assert.equal(fields.hours.size, 24)
  assert.equal(fields.daysOfMonth.size, 31)
  assert.equal(fields.months.size, 12)
  assert.equal(fields.daysOfWeek.size, 7)
})

test('parseCronExpression: 字段数量不足抛出错误', () => {
  assert.throws(() => parseCronExpression('*/30 *'), /必须包含 5 个字段/)
})

test('parseCronExpression: 字段数量过多抛出错误', () => {
  assert.throws(() => parseCronExpression('*/30 * * * * *'), /必须包含 5 个字段/)
})

// ===========================================================================
// Cron 匹配测试
// ===========================================================================

test('matchesCron: 匹配每 30 分钟表达式', () => {
  const fields = parseCronExpression('*/30 * * * *')
  // 2026-01-01 00:00 UTC 是周四
  const date0 = new Date('2026-01-01T00:00:00.000Z')
  const date30 = new Date('2026-01-01T00:30:00.000Z')
  const date15 = new Date('2026-01-01T00:15:00.000Z')

  assert.equal(matchesCron(fields, date0, 'UTC'), true)
  assert.equal(matchesCron(fields, date30, 'UTC'), true)
  assert.equal(matchesCron(fields, date15, 'UTC'), false)
})

test('matchesCron: 特定时间表达式', () => {
  const fields = parseCronExpression('0 9 * * 1')  // 每周一 09:00
  // 2026-01-05 是周一
  const monday9am = new Date('2026-01-05T09:00:00.000Z')
  const monday10am = new Date('2026-01-05T10:00:00.000Z')
  const tuesday9am = new Date('2026-01-06T09:00:00.000Z')

  assert.equal(matchesCron(fields, monday9am, 'UTC'), true)
  assert.equal(matchesCron(fields, monday10am, 'UTC'), false)
  assert.equal(matchesCron(fields, tuesday9am, 'UTC'), false)
})

// ===========================================================================
// 下次执行时间计算测试
// ===========================================================================

test('nextCronTime: 计算每 30 分钟的下次执行时间', () => {
  const fields = parseCronExpression('*/30 * * * *')
  const now = new Date('2026-01-01T00:05:00.000Z')
  const next = nextCronTime(fields, now, 'UTC')

  assert.ok(next !== null)
  assert.equal(next!.getUTCMinutes(), 30)
  assert.equal(next!.getUTCHours(), 0)
})

test('nextCronTime: 从 :29 分开始应找到 :30', () => {
  const fields = parseCronExpression('*/30 * * * *')
  const now = new Date('2026-01-01T00:29:00.000Z')
  const next = nextCronTime(fields, now, 'UTC')

  assert.ok(next !== null)
  assert.equal(next!.getUTCMinutes(), 30)
})

test('nextCronTime: 从 :30 分开始应找到下一个小时的 :00', () => {
  const fields = parseCronExpression('*/30 * * * *')
  const now = new Date('2026-01-01T00:30:00.000Z')
  const next = nextCronTime(fields, now, 'UTC')

  assert.ok(next !== null)
  // 下一个匹配是 01:00
  assert.equal(next!.getUTCMinutes(), 0)
  assert.equal(next!.getUTCHours(), 1)
})

// ===========================================================================
// 并发锁测试
// ===========================================================================

test('acquireLock / releaseLock: 基本锁定与释放', () => {
  resetLock()
  assert.equal(isLocked(), false)

  assert.equal(acquireLock('job-a'), true)
  assert.equal(isLocked(), true)

  // 同一任务再次获取应失败
  assert.equal(acquireLock('job-b'), false)

  releaseLock('job-a')
  assert.equal(isLocked(), false)
})

test('acquireLock: 释放后可重新获取', () => {
  resetLock()
  assert.equal(acquireLock('job-a'), true)
  releaseLock('job-a')
  assert.equal(acquireLock('job-b'), true)
  releaseLock('job-b')
})

test('releaseLock: 只有持有者能释放', () => {
  resetLock()
  acquireLock('job-a')
  releaseLock('job-b')  // 非持有者释放无效
  assert.equal(isLocked(), true)
  releaseLock('job-a')  // 持有者释放
  assert.equal(isLocked(), false)
})

test('resetLock: 强制重置锁状态', () => {
  resetLock()
  acquireLock('job-a')
  assert.equal(isLocked(), true)
  resetLock()
  assert.equal(isLocked(), false)
})

// ===========================================================================
// 重试逻辑测试
// ===========================================================================

test('computeRetryDelay: 指数增长', () => {
  const delay0 = computeRetryDelay(0, 1000)
  const delay1 = computeRetryDelay(1, 1000)
  const delay2 = computeRetryDelay(2, 1000)

  // 基础延迟 + 最多 25% 抖动
  assert.ok(delay0 >= 1000 && delay0 <= 1250)
  assert.ok(delay1 >= 2000 && delay1 <= 2500)
  assert.ok(delay2 >= 4000 && delay2 <= 5000)
})

test('executeWithRetry: 首次成功不重试', async () => {
  let callCount = 0
  const result = await executeWithRetry(
    async () => {
      callCount++
      return 'ok'
    },
    { maxRetries: 3, baseRetryDelayMs: 10, jobName: 'test' },
  )

  assert.equal(result.result, 'ok')
  assert.equal(result.attempts, 0)
  assert.equal(callCount, 1)
})

test('executeWithRetry: 失败后重试成功', async () => {
  let callCount = 0
  const result = await executeWithRetry(
    async () => {
      callCount++
      if (callCount < 3) throw new Error('transient')
      return 'recovered'
    },
    { maxRetries: 3, baseRetryDelayMs: 10, jobName: 'test' },
  )

  assert.equal(result.result, 'recovered')
  assert.equal(result.attempts, 2)
  assert.equal(callCount, 3)
})

test('executeWithRetry: 超过最大重试次数后抛出', async () => {
  await assert.rejects(
    () =>
      executeWithRetry(
        async () => {
          throw new Error('permanent')
        },
        { maxRetries: 2, baseRetryDelayMs: 10, jobName: 'test' },
      ),
    { message: 'permanent' },
  )
})

// ===========================================================================
// 调度任务执行测试
// ===========================================================================

test('executeScheduledJob: 成功执行记录完整信息', async () => {
  resetLock()
  const config = createDefaultConfig({
    maxRetries: 1,
    baseRetryDelayMs: 10,
    jobName: 'test-job',
  })

  const record = await executeScheduledJob(async () => 'done', config)

  assert.equal(record.status, 'success')
  assert.equal(record.jobName, 'test-job')
  assert.equal(record.attempts, 0)
  assert.ok(record.durationMs >= 0)
  assert.ok(record.startTime.length > 0)
  assert.ok(record.endTime.length > 0)
  assert.equal(record.result, 'done')
  assert.equal(record.error, undefined)
})

test('executeScheduledJob: 失败执行记录错误信息', async () => {
  resetLock()
  const config = createDefaultConfig({
    maxRetries: 0,
    baseRetryDelayMs: 10,
    jobName: 'fail-job',
  })

  const record = await executeScheduledJob(
    async () => {
      throw new Error('boom')
    },
    config,
  )

  assert.equal(record.status, 'failure')
  assert.equal(record.jobName, 'fail-job')
  assert.equal(record.error, 'boom')
})

test('executeScheduledJob: 并发锁阻止重复执行', async () => {
  resetLock()
  const config = createDefaultConfig({
    maxRetries: 0,
    baseRetryDelayMs: 10,
    jobName: 'locked-job',
  })

  // 手动占用锁
  acquireLock('locked-job')

  const record = await executeScheduledJob(async () => 'should-not-run', config)

  assert.equal(record.status, 'failure')
  assert.match(record.error!, /锁已被占用/)

  releaseLock('locked-job')
})

test('executeScheduledJob: 执行完成后自动释放锁', async () => {
  resetLock()
  const config = createDefaultConfig({
    maxRetries: 0,
    baseRetryDelayMs: 10,
    jobName: 'auto-release',
  })

  await executeScheduledJob(async () => 'ok', config)
  assert.equal(isLocked(), false)

  // 失败后也应释放
  await executeScheduledJob(
    async () => {
      throw new Error('fail')
    },
    config,
  )
  assert.equal(isLocked(), false)
})

// ===========================================================================
// 默认配置测试
// ===========================================================================

test('createDefaultConfig: 默认值正确', () => {
  const config = createDefaultConfig()
  assert.equal(config.cronExpression, '*/30 * * * *')
  assert.equal(config.timezone, 'UTC')
  assert.equal(config.maxRetries, 3)
  assert.equal(config.baseRetryDelayMs, 1000)
  assert.equal(config.jobName, 'credit-check')
})

test('createDefaultConfig: 允许覆盖', () => {
  const config = createDefaultConfig({
    cronExpression: '0 * * * *',
    timezone: 'Asia/Shanghai',
    maxRetries: 5,
  })
  assert.equal(config.cronExpression, '0 * * * *')
  assert.equal(config.timezone, 'Asia/Shanghai')
  assert.equal(config.maxRetries, 5)
  assert.equal(config.baseRetryDelayMs, 1000) // 未覆盖的保持默认
})

// ===========================================================================
// 异常检测测试
// ===========================================================================

test('detectAnomalies: 余额低于阈值', () => {
  const result = detectAnomalies(makeStatus({ limitRemaining: 50 }), 50, 100)
  assert.equal(result.detected, true)
  assert.ok(result.anomalies.some((a) => a.includes('below threshold')))
})

test('detectAnomalies: 余额极低（CRITICAL）', () => {
  const result = detectAnomalies(makeStatus({ limitRemaining: 10 }), 10, 100)
  assert.equal(result.detected, true)
  assert.ok(result.anomalies.some((a) => a.includes('CRITICAL')))
})

test('detectAnomalies: 无消费上限', () => {
  const result = detectAnomalies(makeStatus({ limit: null }), null, 100)
  assert.equal(result.detected, true)
  assert.ok(result.anomalies.some((a) => a.includes('No spending limit')))
})

test('detectAnomalies: 免费额度', () => {
  const result = detectAnomalies(makeStatus({ isFreeTier: true }), 50, 10)
  assert.equal(result.detected, true)
  assert.ok(result.anomalies.some((a) => a.includes('free tier')))
})

test('detectAnomalies: 使用率超过 90%', () => {
  const result = detectAnomalies(makeStatus({ usage: 95, limit: 100 }), 5, 1)
  assert.equal(result.detected, true)
  assert.ok(result.anomalies.some((a) => a.includes('95.0%')))
})

test('detectAnomalies: 正常状态无异常', () => {
  const result = detectAnomalies(makeStatus({ usage: 30, limit: 100 }), 70, 50)
  assert.equal(result.detected, false)
  assert.equal(result.anomalies.length, 0)
})

// ===========================================================================
// 格式化工具测试
// ===========================================================================

test('formatDuration: 毫秒级', () => {
  assert.equal(formatDuration(500), '500ms')
})

test('formatDuration: 秒级', () => {
  assert.equal(formatDuration(1500), '1.5s')
})

test('formatDuration: 分钟级', () => {
  assert.equal(formatDuration(90000), '1m 30s')
})

// ===========================================================================
// 汇报消息构造测试
// ===========================================================================

test('buildScheduledReport: 包含所有关键字段', () => {
  const ctx: ReportContext = {
    appName: 'TEST_APP',
    appEnv: 'test',
    threshold: 100,
    remaining: 42.5,
    status: makeStatus({ label: 'my-key', usage: 57.5, limit: 100 }),
    execution: makeExecution(),
    schedulerState: makeSchedulerState(),
  }

  const html = buildScheduledReport(ctx)

  assert.match(html, /TEST_APP/)
  assert.match(html, /Scheduled Report/)
  assert.match(html, /my-key/)
  assert.match(html, /57\.5000/)
  assert.match(html, /42\.5000/)
  assert.match(html, /Success/)
  assert.match(html, /Total Success: 10/)
  assert.match(html, /Total Failure: 1/)
  assert.match(html, /every 30 minutes/)
})

test('buildScheduledReport: 失败执行包含错误信息', () => {
  const ctx: ReportContext = {
    appName: 'TEST_APP',
    appEnv: 'test',
    threshold: 100,
    remaining: 42.5,
    status: makeStatus(),
    execution: makeExecution({ status: 'failure', error: 'Connection timeout' }),
    schedulerState: makeSchedulerState(),
  }

  const html = buildScheduledReport(ctx)

  assert.match(html, /FAIL/)
  assert.match(html, /Connection timeout/)
})

test('buildScheduledReport: HTML 特殊字符被转义', () => {
  const ctx: ReportContext = {
    appName: '<script>alert(1)</script>',
    appEnv: 'test',
    threshold: 100,
    remaining: 50,
    status: makeStatus(),
    execution: makeExecution(),
    schedulerState: makeSchedulerState(),
  }

  const html = buildScheduledReport(ctx)

  assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('&lt;script&gt;'))
})

// ===========================================================================
// 错误报告测试
// ===========================================================================

test('buildErrorReport: 包含错误信息和堆栈', () => {
  const error = new Error('Something went wrong')
  const html = buildErrorReport('TEST_APP', 'test', error)

  assert.match(html, /EXECUTION ERROR/)
  assert.match(html, /Something went wrong/)
  assert.match(html, /Stack Trace/)
  assert.match(html, /TEST_APP/)
})

test('buildErrorReport: 包含执行详情', () => {
  const error = new Error('Timeout')
  const execution = makeExecution({ status: 'failure', durationMs: 5000, attempts: 3 })
  const html = buildErrorReport('TEST_APP', 'test', error, execution)

  assert.match(html, /Timeout/)
  assert.match(html, /5\.0s/)
  assert.match(html, /Attempts/)
})

// ===========================================================================
// 日志准确性测试（通过 ExecutionRecord 验证）
// ===========================================================================

test('ExecutionRecord: 时间戳格式为 ISO 8601', async () => {
  resetLock()
  const config = createDefaultConfig({ maxRetries: 0, baseRetryDelayMs: 10 })
  const record = await executeScheduledJob(async () => 'ok', config)

  // ISO 8601 格式验证
  const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
  assert.match(record.startTime, isoRegex)
  assert.match(record.endTime, isoRegex)
})

test('ExecutionRecord: 耗时计算准确', async () => {
  resetLock()
  const config = createDefaultConfig({ maxRetries: 0, baseRetryDelayMs: 10 })

  const record = await executeScheduledJob(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    return 'ok'
  }, config)

  // 至少 50ms（允许一些调度误差）
  assert.ok(record.durationMs >= 40, `Duration ${record.durationMs}ms should be >= 40ms`)
})
