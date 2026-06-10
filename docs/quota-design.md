# Kimi 订阅源额度管理：审计报告与设计方案

## 一、CC-Switch 审计结论

### 1.1 CC-Switch 的探针架构

CC-Switch（GUI + CLI）管理订阅源探针的核心在 `services/subscription.rs`：

| 维度 | CC-Switch 做法 | 对本项目的启示 |
|------|---------------|--------------|
| **凭据获取** | 读取本地 OAuth 凭据（Keychain / `~/.claude/.credentials.json`） | Kimi 用 API Key 而非 OAuth，更简单 |
| **探针端点** | Claude: `api.anthropic.com/api/oauth/usage`<br>Codex: `chatgpt.com/backend-api/wham/usage`<br>Gemini: `cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` | Kimi 有 `/coding/v1/usages`，已在使用 |
| **返回结构** | `tiers: [{name, utilization, resets_at}]` | Kimi 返回 `limits[].detail` + `window`，需转换 |
| **探针频率** | 由前端 React Query 控制，默认 30s 刷新 usage 日志；subscription 无主动轮询，依赖用户打开面板时查询 | **过于频繁会触发风控** |
| **额度应用** | 仅做展示和托盘提示，**不做代理层限流** | 本项目需要更进一步——用官方数据驱动限流 |
| **风控策略** | 透传客户端 UA；Copilot 场景做请求体分类（user/agent/warmup）优化头信息 | **绝不伪造 Agent**；分类优化是 Copilot 特化，不适用于 Kimi |

### 1.2 CC-Switch 的额度分配模式

CC-Switch **没有**实现多用户额度分配——它是单用户多 provider 切换工具。其 `provider_quota.rs` 中的 `QuotaTarget` 只是决定"查哪个 provider 的额度"，不是"把额度分给多个用户"。

这意味着：**本项目需要原创设计合租场景下的额度分配**。

### 1.3 当前项目 (kimi-codingplan-cosub) 的问题

1. **官方额度是只读展示**：`officialUsage.js` 拉取了 `remaining`，但 `limits.js` 的 `checkRollingLimits` 完全依赖本地记账和静态 `total*Limit` 配置
2. **静态分配僵化**：Andante/Allegretto 预设是固定的，不会随官方实际剩余额度变化
3. **未利用 `resetTime`**：官方明确告诉了窗口何时重置，但系统没有用于倒计时、动态调整刷新频率
4. **本地记账偏差**：本地按请求数/token数统计，与官方计数口径可能有差异（如 Kimi 的计费逻辑可能不同）
5. **风控盲区**：即使官方 5h 窗口已耗尽，本地若无感知仍会透传请求，导致上游 429

---

## 二、设计方案：官方额度驱动的动态限流与分配

### 2.1 核心原则

1. **不伪造 Agent**：proxy 层继续透传原始 UA，仅替换 Authorization
2. **少量人合租**：2–5 人场景优化，不做复杂多租户隔离
3. **风控优先**：宁可本地提前拒绝，也不让官方返回 429
4. **官方数据为准**：本地记账为辅，官方 `remaining` 为硬边界

### 2.2 额度获取逻辑增强

#### 2.2.1 官方响应解析增强

Kimi `/coding/v1/usages` 实际返回结构（从代码反推）：

```json
{
  "limits": [
    {
      "window": { "duration": 5, "timeUnit": "HOUR" },
      "detail": {
        "limit": 1307,
        "used": 100,
        "remaining": 1207,
        "resetTime": "2026-06-09T18:00:00Z"
      }
    },
    {
      "window": { "duration": 7, "timeUnit": "DAY" },
      "detail": {
        "limit": 9073,
        "used": 1000,
        "remaining": 8073,
        "resetTime": "2026-06-16T00:00:00Z"
      }
    }
  ],
  "usage": {
    "limit": 36292,
    "used": 5000,
    "remaining": 31292,
    "resetTime": "2026-07-01T00:00:00Z"
  },
  "parallel": { "limit": 5 }
}
```

当前 `officialUsage.js` 已能解析，但缺少：
- **按窗口名称的稳定索引**（`session` 是最小 windowMs，但不一定是 5h）
- **resetTime 的倒计时计算**
- **remaining 占 limit 的比例**（用于健康度判断）

#### 2.2.2 动态刷新策略

| 场景 | 刷新间隔 | 原因 |
|------|---------|------|
| 刚启动 / 手动刷新 | 立即 | 获取初始状态 |
| 剩余充足 (>30%) | 60 min | 减少官方探针频率，降低风控 |
| 剩余紧张 (5%–30%) | 15 min | 需要较及时掌握额度消耗 |
| 剩余临界 (<5%) | 5 min | 临近耗尽，高频监控 |
| 接近 resetTime | resetTime + 2 min | 窗口重置后第一时间获取新额度 |
| 每次 proxy 429 (quota exhausted) | 立即 | 被动触发，确认是否耗尽 |

**风控约束**：无论如何，两次刷新间隔 ≥ 5 min，避免被官方 rate limit。

### 2.3 刷新逻辑设计

```
计时器周期: 1 min

每次 tick:
  1. 若 quotaCheckEnabled == false → 跳过
  2. 若 now < nextAllowedRefreshAt → 跳过（防刷保护）
  3. 计算 targetInterval:
       - 若 officialUsage.ok == false → 60 min（退避）
       - 若任一窗口 remaining / limit < 0.05 → 5 min
       - 若任一窗口 remaining / limit < 0.30 → 15 min
       - 若 resetTime 在 10 min 内 → 5 min
       - 否则 → 60 min
  4. 若 now - lastRefreshAt >= targetInterval → 执行刷新
  5. 刷新后更新 lastRefreshAt, nextAllowedRefreshAt = now + 5 min
```

### 2.4 额度展示 Pane 设计（Dashboard 首页）

新增 **「官方实时额度」** Pane，替换现有的 `OfficialUsagePanel`：

```
┌──────────────────────────────────────────────────────┐
│ 官方实时额度                              [⟳ 刷新]   │
├──────────────────────────────────────────────────────┤
│  5h 会话窗口                                         │
│  ├─ 剩余: 1,145 / 1,307 请求  (87.6%)               │
│  ├─ 已用: 162 请求                                   │
│  ├─ 下次重置: 2小时13分后 (18:00)                    │
│  └─ ████████████████░░░░░░░░░░░░░░░░░░ 12.4%        │
├──────────────────────────────────────────────────────┤
│  7d 周期窗口                                         │
│  ├─ 剩余: 5,897 / 9,073 请求  (65.0%)               │
│  ├─ 已用: 3,176 请求                                 │
│  ├─ 下次重置: 3天7小时后 (6/16 00:00)                │
│  └─ ██████████████████████████░░░░░░░░ 35.0%        │
├──────────────────────────────────────────────────────┤
│  30d 月额度                                          │
│  ├─ 剩余: 28,432 / 36,292 请求  (78.3%)             │
│  └─ ██████████████████████░░░░░░░░░░░░ 21.7%        │
├──────────────────────────────────────────────────────┤
│  并发上限: 5  │  上次刷新: 14:32  │  探针间隔: 60min   │
└──────────────────────────────────────────────────────┘
```

颜色规则：
- 剩余 > 30%：绿色（健康）
- 剩余 5%–30%：黄色（紧张）
- 剩余 < 5%：红色（临界）

### 2.5 基于官方额度的分配形式

#### 2.5.1 当前静态分配的问题

```
总池 = 预设值 (如 Allegretto: 5h=1307, 7d=9073)
每人 = (100% - 10%预留) / 2人 = 45%
→ 每人 5h = 588 请求，7d = 4082 请求
```

问题：如果官方 7d 已用 80%，实际只剩 1814 请求，但每人仍被允许 4082 请求——**本地限额和官方实际脱节**。

#### 2.5.2 新方案：双轨制限流

**轨道 A：个人软限额（本地记账）**
- 基于 `quotaPercent` 和静态 `total*Limit` 计算
- 作用：公平分配、防止个人滥用
- 可配置为"严格模式"（用完即拒）或"借用模式"（可从共享池借）

**轨道 B：全局硬限额（官方驱动）**
- 基于官方 `remaining` 的实时值
- 作用：保护账号不被官方风控
- 永远是最终防线

**限流决策优先级**（proxy 请求时）：

```
1. 全局并发超限 → 429 (global_concurrency_limit)
2. 个人并发超限 → 429 (key_concurrency_limit)
3. 官方 5h remaining <= 0 → 429 (official_session_exhausted)
4. 官方 7d remaining <= 0 → 429 (official_weekly_exhausted)
5. 官方 30d remaining <= 0 → 429 (official_monthly_exhausted)
6. 个人 5h 软限额用完 + 借用关闭 → 429 (five_hour_request_limit)
7. 个人 7d 软限额用完 + 借用关闭 → 429 (weekly_request_limit)
8. 个人 30d 软限额用完 + 借用关闭 → 429 (monthly_request_limit)
9. 通过 → 转发 upstream
```

**动态配额计算**：

```js
// 每次刷新官方额度后，重新计算每个人的"动态上限"
function computeDynamicLimits(officialUsage, settings, keys) {
  const official = officialUsage.ok ? officialUsage : null
  const base5h = settings.totalFiveHourRequestLimit
  const base7d = settings.totalWeeklyRequestLimit
  const base30d = settings.totalMonthlyRequestLimit

  // 官方实际剩余作为全局硬上限
  const hard5h = official?.session?.remaining ?? base5h
  const hard7d = official?.largestWindow?.remaining ?? base7d
  const hard30d = official?.weekly?.remaining ?? base30d

  // 每人动态上限 = min(软限额, 官方剩余 × 个人占比)
  // 这样保证：即使官方剩余很少，每人也不会超过官方总量
  for (const key of keys) {
    const pct = key.quotaPercent / 100
    key.dynamicLimits = {
      fiveHours: { requests: Math.floor(Math.min(base5h * pct, hard5h * pct)) },
      week: { requests: Math.floor(Math.min(base7d * pct, hard7d * pct)) },
      month: { requests: Math.floor(Math.min(base30d * pct, hard30d * pct)) }
    }
  }
}
```

**弹性借用机制**（可选，默认关闭）：

```js
// 当个人用完软限额但全局还有余量时，允许有限借用
function canBorrow(key, window, officialRemaining, allKeysUsage) {
  if (!settings.borrowEnabled) return false

  const totalAllocated = allKeysUsage.reduce((sum, k) => sum + k.used, 0)
  const totalUnused = officialRemaining - totalAllocated

  // 最多借用个人基础配额的 50%，且不超过全局剩余
  const borrowCap = key.baseLimit * 0.5
  const actualBorrow = Math.min(borrowCap, totalUnused * 0.2)

  return key.used < key.baseLimit + actualBorrow
}
```

**为什么不默认开启借用？**
- 少量合租场景下（2-3 人），借用容易导致"一人用完、大家没得用"
- 关闭借用 + 预留 10-20% 是更稳健的策略
- 借用适合「有人出差不用，有人临时赶项目」的场景

---

## 三、风控安全策略

### 3.1 探针层

1. **最小频率原则**：官方额度充足时 60min 刷新一次，这是 CC-Switch 也没有的保守策略
2. **User-Agent 诚实**：使用 `KimiThinProxy/0.1 quota-check`，不伪装成 Kimi CLI
3. **失败退避**：官方返回 429/503 时，下次刷新间隔翻倍（最高 4h）
4. **静默刷新**：后台定时器刷新，不在请求路径上阻塞

### 3.2 代理层

1. **透传所有客户端特征**：UA、模型、参数原样转发
2. **快速本地拒绝**：当官方额度耗尽时，本地直接 429，不转发到上游
3. **并发控制**：全局 + 个人双限制，防止突发流量
4. **无状态设计**：不修改请求体（不像 CC-Switch 的 Copilot 优化器那样做消息合并）

### 3.3 少量合租特化

| 人数 | 预留比例 | 每人占比 | 建议并发 | 说明 |
|------|---------|---------|---------|------|
| 2 人 | 10% | 45% | 2-3 | 最稳健，有充足缓冲 |
| 3 人 | 15% | 28% | 1-2 | 需要更严格的本地限额 |
| 4 人 | 20% | 20% | 1 | 接近官方并发上限 5，需小心 |
| 5 人+ | 25% | 15% | 1 | 不推荐，风控风险高 |

---

## 四、实现文件清单

| 文件 | 修改类型 | 内容 |
|------|---------|------|
| `server/officialUsage.js` | 增强 | 添加 `remainingPercent`, `health`, `secondsUntilReset` 计算 |
| `server/store.js` | 增强 | 添加 `dynamicLimits`, `borrowEnabled`, `strictMode` 设置 |
| `server/limits.js` | 重写 | 新增 `checkOfficialLimits` + `checkRollingLimits` 整合 |
| `server/index.js` | 修改 | proxy 路由集成新限流逻辑；增强刷新策略 |
| `src/main.tsx` | 增强 | 新的 `OfficialQuotaPane` 组件，展示剩余值和倒计时 |
| `server/proxy.js` | 无需修改 | 透传逻辑已正确 |

---

## 五、总结

CC-Switch 的探针设计值得学习的是：**按 provider 类型自动路由到不同的凭据读取和 API 查询逻辑**。但它不做代理层限流——这是本项目的差异化价值。

本设计的核心创新：
1. **官方 remaining 作为硬上限** —— 这是从 CC-Switch 的「只读展示」进化到「驱动决策」
2. **resetTime 驱动的动态刷新** —— 不是固定间隔，而是根据额度健康度自适应
3. **双轨限流（软限额 + 硬限额）** —— 兼顾公平分配和风控安全
4. **倒计时展示** —— 让用户知道「还有多久窗口刷新」，比单纯的百分比更有信息价值
