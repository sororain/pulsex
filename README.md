# PulseX

监控 AWS Lightsail 实例公网 IP 变化，变化时通过 Server酱 / Telegram 通知，纯只读零风险。

**只做检测和通知**：不检测连通性、不自动更换 IP，纯只读，零变更风险。

## 工作原理

1. 定时（默认 1 分钟）并发拉取所有区域 Lightsail 实例列表
2. 读取每个实例的 `name` + `publicIpAddress`
3. 与本地 `ip-state.json` 中上次记录的 IP 对比：
   - **无记录**（新实例/首轮）→ 记录为基准，不通知
   - **IP 未变化** → 跳过本轮
   - **IP 已变化** → Server酱 通知 + 写入 `changes.log` 留档 + 更新基准
4. **首次运行**：建立基准，并发送一条"监控已上线 + 当前 IP 清单"汇总通知
5. 定期清理状态文件中已消失实例的旧记录
6. **每日快照**：每天定时（默认 0 点）推送一次所有实例当前 IP 汇总
7. **失败告警**：某区域拉取失败时推送告警通知（带防抖，避免持续故障刷屏）

> 不需要 Ping，因此可部署在任意位置（国内/国外均可）。

## 前置要求

- Node.js 20 LTS+
- AWS 账号及 [IAM 访问密钥](https://console.aws.amazon.com/iam/home?region=ap-northeast-1#/security_credentials)
  - **只需只读权限**（如 `ReadOnlyAccess`，或仅 `lightsail:GetInstances`）
- pm2（推荐生产使用）

## 安装

```bash
# 1. 安装 Node.js（推荐使用 nvm）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | sh
reboot
nvm install --lts
npm i pm2 -g

# 2. 下载项目
git clone https://github.com/sororain/pulsex.git
cd pulsex

# 3. 安装依赖
npm install

# 4. 配置环境变量
cp .env.example .env
# 编辑 .env 填入你的 AWS 凭证和配置
```

## 配置

通过环境变量配置，支持 `.env` 文件：

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `AWS_ACCESS_KEY_ID` | 是 | - | AWS 访问密钥 ID |
| `AWS_SECRET_ACCESS_KEY` | 是 | - | AWS 秘密访问密钥 |
| `AWS_REGIONS` | 否 | `ap-northeast-1` | AWS 区域，多个用逗号分隔 |
| `CHECK_INTERVAL_MIN` | 否 | `1` | 检查间隔（分钟） |
| `SERVER_CHAN_TOKEN` | 否 | - | Server酱 推送 Token（IP 变更/上线都会通知） |
| `TELEGRAM_BOT_TOKEN` | 否 | - | Telegram Bot Token（与 `TELEGRAM_CHAT_ID` 同时配置才推送） |
| `TELEGRAM_CHAT_ID` | 否 | - | Telegram 接收者 Chat ID（与 `TELEGRAM_BOT_TOKEN` 同时配置才推送） |
| `DAILY_SNAPSHOT_ENABLED` | 否 | `true` | 是否启用每日快照 |
| `DAILY_SNAPSHOT_HOUR` | 否 | `0` | 每日快照推送时间（小时，0-23） |
| `FETCH_FAILURE_ALERT_MIN` | 否 | `30` | 拉取失败告警防抖间隔（分钟） |
| `STATE_FILE` | 否 | `ip-state.json` | IP 状态文件路径 |

## 运行

```bash
# 开发模式（nodemon 热重载）
npm start

# 生产模式（pm2 守护进程）
npm run build
```

PM2 管理命令：

```bash
pm2 list               # 查看进程列表
pm2 logs pulsex        # 查看日志
pm2 restart pulsex     # 重启
pm2 stop pulsex        # 停止
```

## 日志

所有日志统一写入项目根目录的 `lightsail.log` 文件，同时输出到控制台。
IP 变更事件（`CHANGE` 级别）会额外单独记录到 `changes.log` 文件，便于快速检索变更历史。

### 日志级别

| 级别 | 用途 | 筛选命令 |
|------|------|----------|
| `INFO` | 正常流程信息（检查开始、基准建立、汇总报告等） | `grep "\[INFO\]" lightsail.log` |
| `WARN` | 警告（IP 变更、获取不到实例等） | `grep "\[WARN\]" lightsail.log` |
| `CHANGE` | IP 变更事件（记录实例名和 IP 变更） | `grep "\[CHANGE\]" lightsail.log` |
| `ERROR` | 异常错误（API 调用失败等） | `grep "\[ERROR\]" lightsail.log` |

### 日志示例

```
[2026/8/11 12:00:00] [INFO] PulseX 启动，检查间隔: 1 分钟
[2026/8/11 12:00:01] [INFO] 首次运行，建立 IP 基准...
[2026/8/11 12:00:02] [INFO] 基准建立完成，共记录 2 个实例
[2026/8/11 12:01:00] [INFO] 开始新一轮 IP 检查
[2026/8/11 12:02:30] [WARN] ap-northeast-1/my-instance IP 变更: 1.2.3.4 → 5.6.7.8
[2026/8/11 12:02:31] [CHANGE] my-instance IP已变更 1.2.3.4 → 5.6.7.8
[2026/8/11 12:02:32] [INFO] 本轮检查完成: 2 个实例, 1 个变更, 清理 0 条旧记录
```

## 项目结构

```
pulsex/
├── index.js       # 入口文件，定时调度与业务流程编排
├── config.js      # 配置管理（环境变量读取）
├── lightsail.js   # AWS Lightsail API 封装（只读 GetInstances，自动分页）
├── state.js       # IP 状态持久化（读写 ip-state.json）
├── notifier.js    # 消息通知（Server酱 / Telegram：IP 变更 / 上线汇总）
├── logger.js      # 本地日志记录（含 changes.log 留档）
├── .env.example   # 环境变量模板
├── package.json
└── README.md
```

## 通知示例

**IP 变更**
```
标题: 🔔 IP变更: my-instance

实例: my-instance
区域: ap-northeast-1
旧 IP: 1.2.3.4
新 IP: 5.6.7.8
时间: 2026/8/11 12:02:31
```

**监控上线（首次运行）**
```
标题: 🚀 PulseX 监控已上线

PulseX 监控已上线，当前 2 台实例：

- ap-northeast-1/my-instance: 1.2.3.4
- us-east-1/other: 9.9.9.9

时间: 2026/8/11 12:00:02
```

## 支持的区域

- us-east-2, us-east-1, us-west-2
- ap-south-1, ap-northeast-2, ap-southeast-1, ap-southeast-2, ap-northeast-1
- ca-central-1
- eu-central-1, eu-west-1, eu-west-2, eu-west-3, eu-north-1
