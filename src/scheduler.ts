// -----------------------------------------------------------------------------
// 作者：钟智强
// -----------------------------------------------------------------------------
// Cron 调度引擎（scheduler.ts）
//
// 职责：
//   提供精确的 cron 表达式调度能力，包含并发锁、指数退避重试、
//   执行计时与结构化日志。所有函数均为纯函数式设计，无 class。
//
// 核心特性：
//   - 基于 cron 表达式的精确调度（支持时区配置）
//   - 进程级互斥锁，防止同一实例内并发执行
//   - 指数退避重试（可配置最大重试次数与基础延迟）
//   - 每次执行记录开始时间、结束时间、耗时、状态
//   - 优雅退出支持（SIGINT / SIGTERM）
// -----------------------------------------------------------------------------

import { createLogger } from './logger'

const log = createLogger('scheduler')

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 调度器配置。 */
export interface SchedulerConfig {
  // Cron 表达式（如 "* /30 * * * *" 去掉空格，表示每 30 分钟）。
  readonly cronExpression: string
  /** 时区标识（IANA 格式，如 "Asia/Shanghai"）。默认 "UTC"。 */
  readonly timezone: string
  /** 最大重试次数（针对瞬态失败）。默认 3。 */
  readonly maxRetries: number
  /** 重试基础延迟（毫秒），实际延迟 = baseRetryDelayMs * 2^attempt。默认 1000。 */
  readonly baseRetryDelayMs: number
  /** 任务名称，用于日志标识。 */
  readonly jobName: string
}

/** 单次执行的结果记录。 */
export interface ExecutionRecord {
  /** 任务名称。 */
  readonly jobName: string
  /** 执行开始时间（ISO 8601）。 */
  readonly startTime: string
  /** 执行结束时间（ISO 8601）。 */
  readonly endTime: string
  /** 执行耗时（毫秒）。 */
  readonly durationMs: number
  /** 执行状态。 */
  readonly status: 'success' | 'failure'
  /** 重试次数（0 表示首次即成功）。 */
  readonly attempts: number
  /** 失败时的错误信息。 */
  readonly error?: string
  /** 任务返回的结果数据。 */
  readonly result?: unknown
}

/** 调度器状态快照（只读）。 */
export interface SchedulerState {
  /** 调度器是否正在运行。 */
  readonly running: boolean
  /** 是否有任务正在执行（并发锁状态）。 */
  readonly locked: boolean
  /** 累计成功执行次数。 */
  readonly successCount: number
  /** 累计失败执行次数。 */
  readonly failureCount: number
  /** 最近一次执行记录。 */
  readonly lastExecution: ExecutionRecord | null
  /** 下次预计执行时间（ISO 8601）。 */
  readonly nextRunTime: string | null
}

// ---------------------------------------------------------------------------
// Cron 表达式解析（轻量级实现，不引入外部依赖）
// ---------------------------------------------------------------------------

/** Cron 字段定义（分 时 日 月 周）。 */
interface CronFields {
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly daysOfMonth: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  readonly daysOfWeek: ReadonlySet<number>
}

/** 解析单个 cron 字段为数值集合。 */
export const parseCronField = (
  field: string,
  min: number,
  max: number,
): ReadonlySet<number> => {
  const values = new Set<number>()

  for (const part of field.split(',')) {
    const trimmed = part.trim()

    // 处理步进值：*/N 或 M-N/S
    const stepMatch = trimmed.match(/^(.+)\/(\d+)$/)
    if (stepMatch) {
      const [, range, stepStr] = stepMatch
      const step = Number(stepStr)
      if (step <= 0) throw new Error(`Cron 步进值必须为正整数：${trimmed}`)

      let start = min
      let end = max
      if (range !== '*') {
        const dashMatch = range!.match(/^(\d+)-(\d+)$/)
        if (dashMatch) {
          start = Number(dashMatch[1])
          end = Number(dashMatch[2])
        } else {
          start = Number(range)
          end = max
        }
      }

      for (let i = start; i <= end; i += step) {
        values.add(i)
      }
      continue
    }

    // 通配符
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) values.add(i)
      continue
    }

    // 范围：M-N
    const dashMatch = trimmed.match(/^(\d+)-(\d+)$/)
    if (dashMatch) {
      const start = Number(dashMatch[1])
      const end = Number(dashMatch[2])
      if (start < min || end > max || start > end) {
        throw new Error(`Cron 范围越界：${trimmed}（允许 ${min}-${max}）`)
      }
      for (let i = start; i <= end; i++) values.add(i)
      continue
    }

    // 单个数值
    const num = Number(trimmed)
    if (Number.isNaN(num) || num < min || num > max) {
      throw new Error(`Cron 字段值无效：${trimmed}（允许 ${min}-${max}）`)
    }
    values.add(num)
  }

  return values
}

/** 解析完整的 5 字段 cron 表达式。 */
export const parseCronExpression = (expression: string): CronFields => {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(
      `Cron 表达式必须包含 5 个字段（分 时 日 月 周），实际为 ${parts.length} 个：${expression}`,
    )
  }

  return {
    minutes: parseCronField(parts[0]!, 0, 59),
    hours: parseCronField(parts[1]!, 0, 23),
    daysOfMonth: parseCronField(parts[2]!, 1, 31),
    months: parseCronField(parts[3]!, 1, 12),
    daysOfWeek: parseCronField(parts[4]!, 0, 6),
  }
}

/** 判断给定时间是否匹配 cron 表达式。 */
export const matchesCron = (fields: CronFields, date: Date, timezone: string): boolean => {
  // 将 UTC 时间转换为目标时区的各分量
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  })

  const parts = formatter.formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type)
    return part ? Number(part.value) : 0
  }

  const minute = get('minute')
  const hour = get('hour') === 24 ? 0 : get('hour')

  // 获取目标时区的星期几（0=周日）
  const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  })
  const weekdayStr = weekdayFormatter.format(date)
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  }
  const dayOfWeek = weekdayMap[weekdayStr] ?? 0

  return (
    fields.minutes.has(minute) &&
    fields.hours.has(hour) &&
    fields.daysOfMonth.has(get('day')) &&
    fields.months.has(get('month')) &&
    fields.daysOfWeek.has(dayOfWeek)
  )
}

/** 计算下一次匹配 cron 表达式的时间（最多向前搜索 366 天）。 */
export const nextCronTime = (
  fields: CronFields,
  after: Date,
  timezone: string,
): Date | null => {
  // 从下一分钟开始搜索
  const candidate = new Date(after.getTime())
  candidate.setSeconds(0, 0)
  candidate.setMinutes(candidate.getMinutes() + 1)

  const maxIterations = 366 * 24 * 60 // 最多搜索一年
  for (let i = 0; i < maxIterations; i++) {
    if (matchesCron(fields, candidate, timezone)) {
      return candidate
    }
    candidate.setMinutes(candidate.getMinutes() + 1)
  }

  return null
}

// ---------------------------------------------------------------------------
// 并发锁（进程级互斥）
// ---------------------------------------------------------------------------

let lockHolder: string | null = null

/** 尝试获取执行锁。成功返回 true，已被占用返回 false。 */
export const acquireLock = (jobName: string): boolean => {
  if (lockHolder !== null) {
    log.warn('任务执行锁已被占用，跳过本次调度', {
      jobName,
      currentHolder: lockHolder,
    })
    return false
  }
  lockHolder = jobName
  log.debug('已获取执行锁', { jobName })
  return true
}

/** 释放执行锁。 */
export const releaseLock = (jobName: string): void => {
  if (lockHolder === jobName) {
    lockHolder = null
    log.debug('已释放执行锁', { jobName })
  }
}

/** 查询锁状态（用于测试和状态查询）。 */
export const isLocked = (): boolean => lockHolder !== null

/** 重置锁状态（仅用于测试）。 */
export const resetLock = (): void => {
  lockHolder = null
}

// ---------------------------------------------------------------------------
// 指数退避重试
// ---------------------------------------------------------------------------

/** 计算指数退避延迟（含抖动）。 */
export const computeRetryDelay = (attempt: number, baseDelayMs: number): number => {
  const exponential = baseDelayMs * Math.pow(2, attempt)
  // 添加 0-25% 的随机抖动，避免多实例同时重试
  const jitter = exponential * Math.random() * 0.25
  return Math.floor(exponential + jitter)
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** 带指数退避重试的任务执行器。 */
export const executeWithRetry = async <T>(
  task: () => Promise<T>,
  config: Pick<SchedulerConfig, 'maxRetries' | 'baseRetryDelayMs' | 'jobName'>,
): Promise<{ result: T; attempts: number }> => {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const result = await task()
      if (attempt > 0) {
        log.info('任务重试成功', {
          jobName: config.jobName,
          attempt,
          totalAttempts: attempt + 1,
        })
      }
      return { result, attempts: attempt }
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt < config.maxRetries) {
        const delay = computeRetryDelay(attempt, config.baseRetryDelayMs)
        log.warn('任务执行失败，准备重试', {
          jobName: config.jobName,
          attempt: attempt + 1,
          maxRetries: config.maxRetries,
          nextRetryDelayMs: delay,
          error: lastError.message,
        })
        await sleep(delay)
      }
    }
  }

  log.error('任务在所有重试后仍然失败', {
    jobName: config.jobName,
    totalAttempts: config.maxRetries + 1,
    error: lastError!.message,
  })

  throw lastError!
}

// ---------------------------------------------------------------------------
// 调度器核心
// ---------------------------------------------------------------------------

/**
 * 执行一次带完整生命周期管理的任务调度。
 * 包含：并发锁检查 -> 计时开始 -> 重试执行 -> 计时结束 -> 记录结果 -> 释放锁。
 */
export const executeScheduledJob = async <T>(
  task: () => Promise<T>,
  config: SchedulerConfig,
): Promise<ExecutionRecord> => {
  const startTime = new Date()

  // 并发锁检查
  if (!acquireLock(config.jobName)) {
    return {
      jobName: config.jobName,
      startTime: startTime.toISOString(),
      endTime: startTime.toISOString(),
      durationMs: 0,
      status: 'failure',
      attempts: 0,
      error: '任务执行锁已被占用，跳过本次调度',
    }
  }

  log.info('调度任务开始执行', {
    jobName: config.jobName,
    startTime: startTime.toISOString(),
  })

  try {
    const { result, attempts } = await executeWithRetry(task, config)
    const endTime = new Date()
    const durationMs = endTime.getTime() - startTime.getTime()

    const record: ExecutionRecord = {
      jobName: config.jobName,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      durationMs,
      status: 'success',
      attempts,
      result,
    }

    log.info('调度任务执行成功', {
      jobName: config.jobName,
      durationMs,
      attempts,
    })

    return record
  } catch (error: unknown) {
    const endTime = new Date()
    const durationMs = endTime.getTime() - startTime.getTime()
    const errorMessage = error instanceof Error ? error.message : String(error)

    const record: ExecutionRecord = {
      jobName: config.jobName,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      durationMs,
      status: 'failure',
      attempts: config.maxRetries + 1,
      error: errorMessage,
    }

    log.error('调度任务执行失败', {
      jobName: config.jobName,
      durationMs,
      attempts: config.maxRetries + 1,
      error: errorMessage,
    })

    return record
  } finally {
    releaseLock(config.jobName)
  }
}

/**
 * 启动 cron 调度循环。
 * 每分钟检查一次当前时间是否匹配 cron 表达式，匹配时执行任务。
 * 返回停止函数，调用后优雅退出。
 */
export const startScheduler = (
  task: () => Promise<unknown>,
  config: SchedulerConfig,
  callbacks?: {
    readonly onExecution?: (record: ExecutionRecord) => void | Promise<void>
    readonly onError?: (error: Error) => void | Promise<void>
  },
): { stop: () => void; getState: () => SchedulerState } => {
  const fields = parseCronExpression(config.cronExpression)

  let running = true
  let successCount = 0
  let failureCount = 0
  let lastExecution: ExecutionRecord | null = null
  let intervalId: ReturnType<typeof setInterval> | null = null

  log.info('Cron 调度器启动', {
    jobName: config.jobName,
    cronExpression: config.cronExpression,
    timezone: config.timezone,
    maxRetries: config.maxRetries,
  })

  const getNextRunTime = (): string | null => {
    const next = nextCronTime(fields, new Date(), config.timezone)
    return next ? next.toISOString() : null
  }

  // 记录下次执行时间
  const nextRun = getNextRunTime()
  if (nextRun) {
    log.info('下次调度执行时间', { nextRunTime: nextRun, timezone: config.timezone })
  }

  // 上一次触发的分钟时间戳，防止同一分钟内重复触发
  let lastTriggeredMinute = -1

  const tick = async (): Promise<void> => {
    if (!running) return

    const now = new Date()
    const currentMinute = now.getFullYear() * 1000000 +
      (now.getMonth() + 1) * 10000 +
      now.getDate() * 100 +
      now.getHours() * 60 +
      now.getMinutes()

    if (currentMinute === lastTriggeredMinute) return

    if (!matchesCron(fields, now, config.timezone)) return

    lastTriggeredMinute = currentMinute

    log.info('Cron 表达式匹配，触发任务执行', {
      jobName: config.jobName,
      triggerTime: now.toISOString(),
    })

    try {
      const record = await executeScheduledJob(task, config)
      lastExecution = record

      if (record.status === 'success') {
        successCount++
      } else {
        failureCount++
      }

      if (callbacks?.onExecution) {
        await callbacks.onExecution(record)
      }

      // 记录下次执行时间
      const nextRun = getNextRunTime()
      if (nextRun) {
        log.info('下次调度执行时间', { nextRunTime: nextRun, timezone: config.timezone })
      }
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error))
      log.error('调度器回调执行异常', {
        jobName: config.jobName,
        error: err.message,
      })
      if (callbacks?.onError) {
        await callbacks.onError(err)
      }
    }
  }

  // 每 15 秒检查一次（比每分钟更精确，避免错过边界）
  intervalId = setInterval(() => void tick(), 15_000)

  // 立即执行一次检查（处理启动时恰好匹配的情况）
  void tick()

  const getState = (): SchedulerState => ({
    running,
    locked: isLocked(),
    successCount,
    failureCount,
    lastExecution,
    nextRunTime: running ? getNextRunTime() : null,
  })

  const stop = (): void => {
    if (!running) return
    running = false
    if (intervalId !== null) {
      clearInterval(intervalId)
      intervalId = null
    }
    log.info('Cron 调度器已停止', {
      jobName: config.jobName,
      totalSuccess: successCount,
      totalFailure: failureCount,
    })
  }

  return { stop, getState }
}

/** 创建默认的调度器配置。 */
export const createDefaultConfig = (
  overrides?: Partial<SchedulerConfig>,
): SchedulerConfig => ({
  cronExpression: '*/30 * * * *',
  timezone: 'UTC',
  maxRetries: 3,
  baseRetryDelayMs: 1000,
  jobName: 'credit-check',
  ...overrides,
})
