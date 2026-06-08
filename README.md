# Kimi Thin Proxy

一个面向小团队内部使用的 Kimi Code 薄代理和管理面板。它的目标是权限收敛、额度分配、并发控制和审计，不做客户端伪装，不做账号池调度。

## 功能

- 多个内部 proxy key，每个人一个 key
- 账号总池配置：5 小时、7 天、30 天请求/token 上限
- 人数/预留比例分配器：默认 2 人、预留 10%，每人默认 45%
- 每个 proxy key 按百分比分配总池，新 key 默认使用分配器算出的占比
- 到达 key 的 5 小时、7 天或 30 天占比上限后返回 429
- 每个 key 并发上限和全局并发上限
- 管理面板查看总览、key、审计日志、代理设置
- 透传客户端原始 `User-Agent`，只替换上游 `Authorization`
- 真实 Kimi Key 只放在服务端环境变量，不在前端展示
- 实验性官方额度检查：默认关闭，启用后手动刷新为主，每小时自动刷新一次

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
KIMI_QUOTA_USER_AGENT=KimiThinProxy/0.1 quota-check
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

人数可以自由增加，预留比例也可以在设置页调整。新建 key 会默认使用当前计算出的每人占比；已有 key 可以通过“应用到所有 Key”按钮重新分配。

如果 A 的 5h 请求上限为 `1,307 × 45% = 588` 次，A 在 5 小时滚动窗口内用到 588 次后，代理会对 A 返回 `429`，不会继续消耗上游账号。Token 上限同理。

Allegretto 下按 45% 计算，每人约为：

```text
5h：588 次 / 29,250,000 tokens
7d：4,082 次 / 160,650,000 tokens
30d：16,331 次 / 642,600,000 tokens
```

设置页也提供 Andante / Allegretto 预设按钮，实际套餐不同可以一键切换。

## 官方额度检查

管理面板可以手动刷新 Kimi Code 官方额度。这个功能**默认关闭**，因为它会额外向 Kimi 发起一次带 `User-Agent` 的上游请求；确认接受这个风险后，在设置页打开“启用官方额度检查”再使用。

代理会请求：

```text
GET https://api.kimi.com/coding/v1/usages
Authorization: Bearer <KIMI_API_KEY>
User-Agent: KimiThinProxy/0.1 quota-check
```

这个请求是管理端探针，不代表任何一个成员的 proxy key，也不会进入 A/B 的本地用量账本。启用后默认每 1 小时自动刷新一次，主要还是通过面板手动刷新确认。

注意：该接口在开源项目中被使用，但不是 Kimi 正式承诺稳定的公开 API。如果官方拒绝当前 `User-Agent` 或权限，面板会显示 `401/403/5xx` 错误；项目不会自动伪装成 Kimi CLI。

## 使用边界

这个项目不提供 `User-Agent` 伪装、随机化、统一清洗或账号池能力。代理会尽量保留客户端真实请求特征，仅做内部认证、限额、并发和审计。

请确认团队使用方式符合 Kimi Code 的相关规则。薄代理可以减少真实 key 泄露、误用和额度失控，但不能消除账号共享本身的规则风险。
