# Kimi Thin Proxy

一个面向小团队内部使用的 Kimi Code 薄代理和管理面板。它的目标是权限收敛、额度分配、并发控制和审计，不做客户端伪装，不做账号池调度。

## 功能

- 多个内部 proxy key，每个人一个 key
- 账号总池配置：5 小时、7 天、30 天请求/token 上限
- 每个 proxy key 按百分比分配总池，默认 45%
- 到达 key 的 5 小时、7 天或 30 天占比上限后返回 429
- 每个 key 并发上限和全局并发上限
- 管理面板查看总览、key、审计日志、代理设置
- 透传客户端原始 `User-Agent`，只替换上游 `Authorization`
- 真实 Kimi Key 只放在服务端环境变量，不在前端展示

## 本地运行

```bash
npm install
cp .env.example .env
```

编辑 `.env`：

```bash
PORT=8787
ADMIN_TOKEN=change-this-admin-token
KIMI_API_KEY=sk-your-kimi-code-key
KIMI_UPSTREAM_BASE_URL=https://api.kimi.com/coding/v1
GLOBAL_CONCURRENCY_LIMIT=2
DATA_FILE=./data/store.json
```

启动：

```bash
npm run build
npm start
```

打开：

```text
http://127.0.0.1:8787
```

面板登录使用 `ADMIN_TOKEN`。

## 客户端配置

在 Roo Code、OpenCode 或其他 OpenAI-compatible 客户端里配置：

```text
Base URL: http://YOUR_SERVER:8787/v1
API Key: 管理面板创建出来的 proxy key
Model: kimi-for-coding
```

代理会把上游请求转发到：

```text
https://api.kimi.com/coding/v1
```

也就是客户端请求 `/v1/chat/completions` 会被转发到 Kimi 的 `/chat/completions`。

## 配额模型

在设置页先填账号总池。项目默认使用
[mahonzhan/awesome-coding-plan](https://github.com/mahonzhan/awesome-coding-plan)
中整理的 Kimi Code Allegretto 估算值：

```text
5h 总请求：1,307
5h 总 Token：65,000,000
7d 总请求：9,073
7d 总 Token：357,000,000
30d 总请求：36,292
30d 总 Token：1,428,000,000
```

每个 proxy key 再设置占比。两个人平分时建议：

```text
A：45%
B：45%
缓冲：10%
```

如果 A 的 5h 请求上限为 `1,307 × 45% = 588` 次，A 在 5 小时滚动窗口内用到 588 次后，代理会对 A 返回 `429`，不会继续消耗上游账号。Token 上限同理。

Allegretto 下按 45% 计算，每人约为：

```text
5h：588 次 / 29,250,000 tokens
7d：4,082 次 / 160,650,000 tokens
30d：16,331 次 / 642,600,000 tokens
```

设置页也提供 Andante / Allegretto 预设按钮，实际套餐不同可以一键切换。

## 使用边界

这个项目不提供 `User-Agent` 伪装、随机化、统一清洗或账号池能力。代理会尽量保留客户端真实请求特征，仅做内部认证、限额、并发和审计。

请确认团队使用方式符合 Kimi Code 的相关规则。薄代理可以减少真实 key 泄露、误用和额度失控，但不能消除账号共享本身的规则风险。
