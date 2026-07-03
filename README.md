# OpenRouter 额度监控（openrouter-credit-monitor）

定时检查 [OpenRouter](https://openrouter.ai) API 密钥的**额度余额**（已用多少、还剩多少）。
当**剩余额度 ≤ 阈值**（默认 `100`）时，同时通过 **AWS SNS** 和 **Telegram** 发送告警。

- 纯 **TypeScript**，**函数式实现，不使用 class**（满足 “NO OOP”）。
- 严格模式（`strict` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax`）。
- 可作为 **AWS Lambda** 部署，也可本地运行。
- 自带单元测试、CI（GitHub Actions）、MIT 开源协议。

---

## ⚠️ 安全提醒（务必先做）

如果你的密钥曾经明文出现在聊天、截图或仓库里，请**立即到 OpenRouter 控制台吊销并重新生成**。
OpenRouter 是 GitHub 的密钥扫描合作方，会检测泄露的密钥并邮件通知。
本项目**不会**把密钥写进代码，一律通过环境变量注入，生产环境建议用 **AWS Secrets Manager**。

---

## 目录结构

```
openrouter-credit-monitor/
├─ src/
│  ├─ config.ts       # 读取并校验环境变量（纯函数）
│  ├─ openrouter.ts   # 调用 /api/v1/key，并对响应做运行期校验
│  ├─ credit.ts       # 纯逻辑：计算剩余、判断阈值、构造消息（可单测）
│  ├─ telegram.ts     # Telegram sendMessage
│  ├─ sns.ts          # AWS SNS Publish
│  ├─ notify.ts       # 双通道聚合发送（Promise.allSettled）
│  ├─ handler.ts      # 主流程编排 + Lambda handler
│  └─ local.ts        # 本地运行入口
├─ test/
│  └─ credit.test.ts  # 纯函数单元测试（node:test）
├─ .github/workflows/ci.yml
├─ .env.example
├─ package.json
├─ tsconfig.json
└─ LICENSE
```

---

## 工作原理

对应最初的 curl：

```bash
curl -X GET 'https://openrouter.ai/api/v1/key' \
  -H 'Authorization: Bearer <你的密钥>' \
  -x 127.0.0.1:9000        # 可选代理，映射为 OPENROUTER_PROXY
```

流程：

1. 调用 `GET /api/v1/key`，得到 `usage`（已用）、`limit`（上限）、`limit_remaining`（剩余）。
2. 计算剩余额度：优先用 `limit_remaining`；没有则用 `limit - usage`；两者都没有则返回 `null`。
3. 若剩余 ≤ 阈值 → 同时发 **SNS** 与 **Telegram**（任一失败不影响另一个）。

> 注意：`/key` 只有在**密钥设置了消费上限**时才返回 `limit_remaining`。
> 若你的账户是按余额扣费、没有为密钥单独设上限，请改用账户级接口
> `GET https://openrouter.ai/api/v1/credits`（`total_credits - total_usage` 即为剩余）。

---

## 环境变量

| 变量 | 必填 | 说明 |
|---|:---:|---|
| `OPENROUTER_API_KEY` | ✅ | OpenRouter 密钥。建议用 Secrets Manager 注入。 |
| `TELEGRAM_BOT_TOKEN` | ✅ | Telegram 机器人 Token（@BotFather）。 |
| `TELEGRAM_CHAT_ID` | ✅ | 目标会话 ID。 |
| `SNS_TOPIC_ARN` | ✅ | 告警发布的 SNS 主题 ARN。 |
| `CREDIT_THRESHOLD` | ❌ | 告警阈值，默认 `100`。 |
| `OPENROUTER_PROXY` | ❌ | HTTP 代理（对应 `-x`），仅本地调试；Lambda 中留空。 |

---

## 本地运行

```bash
npm install
cp .env.example .env          # 填入真实值
export OPENROUTER_API_KEY=sk-or-...
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_CHAT_ID=...
export SNS_TOPIC_ARN=arn:aws:sns:...

npm run typecheck   # 类型检查
npm test            # 单元测试
npm start           # 执行一次完整流程
```

---

## 构建与部署到 AWS Lambda

```bash
npm run package     # 生成 function.zip（dist/handler.js，AWS SDK 作为外部依赖）
```

- **运行时**：`nodejs20.x` 或 `nodejs22.x`（两者都内置 AWS SDK v3，因此打包时用 `--external` 排除）。
- **Handler**：`handler.handler`
- **触发器**：EventBridge Scheduler 定时规则，例如 `rate(1 hour)`。
- **执行角色 IAM**：仅需对目标主题的 `sns:Publish` 权限：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "sns:Publish",
      "Resource": "arn:aws:sns:REGION:ACCOUNT_ID:openrouter-alerts"
    }
  ]
}
```

> 如果目标运行时不内置 AWS SDK，请把 `package.json` 里 `build` 脚本的
> `--external:@aws-sdk/*` 去掉，让 SDK 一起打进包内。

---

## 设计取舍

- **不使用 class**：全部为纯函数 + 显式依赖传递；`SNSClient` / `PublishCommand`
  属于官方 SDK 的用法，不算业务层的面向对象。
- **纯逻辑与 IO 分离**：`credit.ts` 只做计算，方便单测；网络与 AWS 调用集中在各自模块。
- **双通道容错**：`Promise.allSettled` 保证一个通道挂掉不拖累另一个，最后汇总失败并抛错。
- **不盲信外部数据**：对 `/key` 响应逐字段做类型校验，而非 `as` 强转。

---

## 许可证

[MIT](./LICENSE)
