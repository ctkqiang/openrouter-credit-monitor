// -----------------------------------------------------------------------------
// 作者：钟智强
// -----------------------------------------------------------------------------
// 单元测试（credit.test.ts）
//
// 使用 Node 内置测试运行器 node:test，只测试纯函数，无需网络与 AWS。
// 运行：npm test
// -----------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  computeRemaining,
  shouldAlert,
  buildAlertMessage,
  buildAlertSubject,
  type AppContext,
} from '../src/credit'
import type { KeyStatus } from '../src/openrouter'

const testCtx: AppContext = { appName: 'TEST_APP', appEnv: 'test' }

/** 构造测试用的 KeyStatus，允许按需覆盖字段。 */
const makeStatus = (overrides: Partial<KeyStatus>): KeyStatus => ({
  label: 'test-key',
  usage: 0,
  limit: null,
  limitRemaining: null,
  isFreeTier: false,
  ...overrides,
})

test('computeRemaining 优先使用 limitRemaining', () => {
  const status = makeStatus({ limitRemaining: 42, limit: 100, usage: 30 })
  assert.equal(computeRemaining(status), 42)
})

test('computeRemaining 在无 limitRemaining 时用 limit - usage 推算', () => {
  const status = makeStatus({ limitRemaining: null, limit: 100, usage: 70 })
  assert.equal(computeRemaining(status), 30)
})

test('computeRemaining 在无任何上限时返回 null', () => {
  const status = makeStatus({ limitRemaining: null, limit: null })
  assert.equal(computeRemaining(status), null)
})

test('shouldAlert 在剩余 <= 阈值时为 true', () => {
  assert.equal(shouldAlert(100, 100), true) // 等于阈值也告警
  assert.equal(shouldAlert(50, 100), true)
  assert.equal(shouldAlert(100.01, 100), false)
})

test('buildAlertSubject 不超过 SNS 100 字符限制', () => {
  const subject = buildAlertSubject(testCtx, 12.3456)
  assert.ok(subject.length <= 100)
  assert.match(subject, /12\.35/)
  assert.match(subject, /TEST_APP/)
})

test('buildAlertMessage 包含关键字段和应用来源', () => {
  const status = makeStatus({ label: 'k', usage: 88.5, limit: 100 })
  const msg = buildAlertMessage(testCtx, status, 11.5, 100)
  assert.match(msg, /Used/)
  assert.match(msg, /Remaining/)
  assert.match(msg, /11\.5000/)
  assert.match(msg, /TEST_APP/)
  assert.match(msg, /test/)
})
