# kimi-codingplan-cosub

一个面向小团队内部使用的 Kimi Code 薄代理和管理面板。界面和部分功能来源于 [sub2api](https://github.com/Wei-Shaw/sub2api)。

它的目标是权限收敛、额度分配、并发控制和审计，不做客户端伪装，不做账号池调度。

> **注意：本项目尚未经过真实环境实测，仅提供一个技术方案参考。实际可用性和稳定性尚未确认。**

## 功能

- 多个内部 proxy key，每个人一个 key
- 账号总池配置：5 小时、7 天请求/token 上限
- 人数/预留比例分配器：默认 2 人、预留 10%，每人默认 45%
- 每个 proxy key 按百分比分配总池，新 key 默认使用分配器算出的占比
- 到达 key 的 5 小时或 7 天占比上限后返回 429
- 每个 key 并发上限和全局并发上限
- 管理面板查看总览、key、审计日志、代理设置
- 透传客户端原始 `User-Agent`，只替换上游 `Authorization`
- 真实 Kimi Key 只放在服务端环境变量，不在前端展示
- 实验性官方同步额度池：默认关闭，启用后可用官方 5h/7d 剩余额度百分比动态估算每人 token 上限

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
KIMI_QUOTA_USER_AGENT=kimi-codingplan-cosub/0.1 quota-check
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

## Docker 运行

复制并编辑环境变量：

```bash
cp .env.example .env
# 编辑 .env，设置 ADMIN_TOKEN 和 KIMI_API_KEY
```

构建并启动：

```bash
docker compose up -d --build
```

查看日志：

```bash
docker compose logs -f
```

停止：

```bash
docker compose down
```

数据文件 `data/store.json` 会通过 volume 挂载到宿主机，容器重启不会丢失。

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

在设置页先填账号总池。项目默认使用 [mahonzhan/awesome-coding-plan](https://github.com/mahonzhan/awesome-coding-plan) 中整理的 Kimi Code Allegretto 估算值：

```text
5h 总请求：1,307
5h 总 Token：65,000,000
7d 总请求：9,073
7d 总 Token：357,000,000
```

每个 proxy key 再设置占比。默认分配方式是：

```text
每人占比 = (100% - 预留比例) / 人数
```

默认 `人数 = 2`、`预留比例 = 10%`，所以：

```text
A：45%
B：45%
缓冲：10%
```

人数可以自由增加，预留比例也可以在设置页调整。新建 key 会默认使用当前计算出的每人占比；已有 key 可以通过"应用到所有 Key"按钮重新分配。

如果 A 的 5h 请求上限为 `1,307 × 45% = 588` 次，A 在 5 小时滚动窗口内用到 588 次后，代理会对 A 返回 `429`，不会继续消耗上游账号。Token 上限同理。

Allegretto 下按 45% 计算，每人约为：

```text
5h：588 次 / 29,250,000 tokens
7d：4,082 次 / 160,650,000 tokens
```

设置页也提供 Andante / Allegretto 预设按钮，实际套餐不同可以一键切换。

### 两种额度模式

默认是预设模式：5h 和 7d 的请求/token 总池来自设置页预设，每个 proxy key 使用 `总池 × 占比` 作为硬限制。

启用官方同步额度池后，代理会读取 Kimi Code `/coding/v1/usages` 返回的 5h/7d resetTime 和剩余额度百分比。每次刷新时，系统会用本地代理日志的 token 用量反推当前周期总池：

```text
推算总 token = 本地代理总 token / 官方已用百分比
个人动态 token 上限 = 推算总 token × 个人占比
```

这个推算值在本次官方刷新后固定；刷新前用户继续消耗时，只更新分子。例如 A+B 本地已用 30 tokens，官方显示已用 11%，则推算总量约 272.72，45% 成员额度约 122.72。之后 A 再用 1 token，面板显示会变为 `11 / 122` 左右，而不会重新计算分母。

如果官方消耗明显高于代理日志，系统会把差额视为 Kimi App 或外部 key 的共享池消耗：差额先消耗预留池，超过预留池后再按“外部消耗权重”比例压缩所有人的 token 上限。权重默认为 1，表示完全计入外部消耗；调低则更偏向信任本地代理日志。

## 官方同步额度池

管理面板可以手动刷新 Kimi Code 官方额度。这个功能**默认关闭**，因为它会额外向 Kimi 发起一次带 `User-Agent` 的上游请求；确认接受这个风险后，在设置页打开"启用官方额度检查"再使用。

> **目前官方额度探针的可行性尚未得到确认，该功能仅作为实验性参考。**

代理会请求：

```text
GET https://api.kimi.com/coding/v1/usages
Authorization: Bearer <KIMI_API_KEY>
User-Agent: kimi-codingplan-cosub/0.1 quota-check
```

这个请求是管理端探针，不代表任何一个成员的 proxy key，也不会进入 A/B 的本地用量账本。自动刷新会遵守最小 5 分钟间隔；接近官方 resetTime 时会提高刷新频率。官方 resetTime 到达后，系统等待 1 分钟缓冲再切换本地统计周期。

注意：该接口在开源项目中被使用，但不是 Kimi 正式承诺稳定的公开 API。如果官方拒绝当前 `User-Agent` 或权限，面板会显示 `401/403/5xx` 错误；项目不会自动伪装成 Kimi CLI。

## 为什么不伪造 User-Agent

本项目**不提供** `User-Agent` 伪装、随机化、统一清洗或账号池能力。代理会尽量保留客户端真实请求特征，仅做内部认证、限额、并发和审计。

关于这个决策的更多背景，请参见这个帖子：[https://x.com/Young_AGI/status/2059248586559488352](https://x.com/Young_AGI/status/2059248586559488352)

## 使用边界

请确认团队使用方式符合 Kimi Code 的相关规则。薄代理可以减少真实 key 泄露、误用和额度失控，但不能消除账号共享本身的规则风险。
