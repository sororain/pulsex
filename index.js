const { clients, fetchInstances } = require("./lightsail");
const {
  notifyIpChange,
  notifyMonitorOnline,
  notifyDailySnapshot,
  notifyFetchFailure,
} = require("./notifier");
const { loadState, saveState, hasState } = require("./state");
const { log } = require("./logger");
const config = require("./config");

// ============================================================
// 业务流程编排
// ============================================================

/**
 * 生成状态键：区域/实例名（实例名可能跨区域重复）
 */
const stateKey = (region, name) => `${region}/${name}`;

// 拉取失败告警防抖：同一区域失败后至少间隔 FETCH_FAILURE_ALERT_MIN 才再次告警
const lastFailureAlertAt = {};

async function alertFetchFailure(region, reason) {
  const now = Date.now();
  const last = lastFailureAlertAt[region] || 0;
  if (now - last < config.fetchFailureAlertMin * 60 * 1000) {
    log("WARN", `区域 ${region} 拉取失败告警已抑制（防抖中）`);
    return;
  }
  lastFailureAlertAt[region] = now;
  await notifyFetchFailure({ region, reason });
}

/**
 * 并发获取所有区域的实例列表
 * 失败的区域记入 failures 并触发防抖告警
 * @returns {Promise<{entries: Array, failures: Array}>}
 *   entries: [{region, name, ip}]
 *   failures: [{region, message}]
 */
async function fetchAllInstances() {
  const results = await Promise.all(
    clients.map(async ({ region, client }) => {
      try {
        const servers = await fetchInstances(client);
        return { region, ok: true, servers };
      } catch (err) {
        log("ERROR", `获取实例列表失败 (${region}): ${err.message}`);
        return { region, ok: false, message: err.message };
      }
    })
  );

  const entries = [];
  const failures = [];

  for (const result of results) {
    if (result.ok) {
      for (const server of result.servers) {
        // 跳过无公网 IP 的实例
        if (!server.publicIpAddress) continue;
        entries.push({
          region: result.region,
          name: server.name,
          ip: server.publicIpAddress,
        });
      }
    } else {
      failures.push(result);
      await alertFetchFailure(result.region, result.message);
    }
  }

  return { entries, failures };
}

/**
 * 执行一轮 IP 检查：对比上次记录，变化则通知 + 留档 + 更新基准
 */
// 防重入：上一轮未完成时跳过本轮，避免并发读写状态文件/重复通知
let running = false;

async function runCheck() {
  if (running) {
    log("WARN", "上一轮检查尚未完成，跳过本轮");
    return;
  }
  running = true;

  try {
    log("INFO", "开始新一轮 IP 检查");

    const { entries } = await fetchAllInstances();
    if (entries.length === 0) {
      log("WARN", "未获取到任何带公网 IP 的实例");
    }

    const state = loadState();
    const changes = [];
    let dirty = false; // 状态是否有变化，无变化时不重复写盘

    for (const entry of entries) {
      const key = stateKey(entry.region, entry.name);
      const lastIp = state[key];

      if (lastIp === undefined) {
        // 新实例：记录基准，不通知
        log("INFO", `新增基准: ${key} (${entry.ip})`);
        state[key] = entry.ip;
        dirty = true;
      } else if (lastIp !== entry.ip) {
        // IP 已变化：通知 + 留档 + 更新基准
        log("WARN", `${key} IP 变更: ${lastIp} → ${entry.ip}`);
        changes.push({ ...entry, oldIp: lastIp });
        state[key] = entry.ip;
        dirty = true;
      }
    }

    // 清理已消失实例的旧记录，避免状态文件堆积脏数据
    const currentKeys = new Set(entries.map((e) => stateKey(e.region, e.name)));
    let removed = 0;
    for (const key of Object.keys(state)) {
      if (!currentKeys.has(key)) {
        log("INFO", `清理已消失实例的记录: ${key}`);
        delete state[key];
        dirty = true;
        removed++;
      }
    }

    // 仅在有变化时写盘
    if (dirty) {
      saveState(state);
    }

    // 发送变更通知
    for (const change of changes) {
      await notifyIpChange({
        instanceName: change.name,
        region: change.region,
        oldIp: change.oldIp,
        newIp: change.ip,
      });
    }

    log(
      "INFO",
      `本轮检查完成: ${entries.length} 个实例, ${changes.length} 个变更, 清理 ${removed} 条旧记录`
    );
  } finally {
    running = false;
  }
}

/**
 * 首次运行：建立基准，并发送上线汇总通知
 */
async function firstRun() {
  log("INFO", "首次运行，建立 IP 基准...");

  const { entries } = await fetchAllInstances();

  const state = loadState();
  for (const entry of entries) {
    state[stateKey(entry.region, entry.name)] = entry.ip;
  }
  saveState(state);

  if (entries.length > 0) {
    await notifyMonitorOnline(entries);
  }

  log("INFO", `基准建立完成，共记录 ${entries.length} 个实例`);
}

// ============================================================
// 启动校验
// ============================================================

const configErrors = config.validateConfig();
if (configErrors.length > 0) {
  log("ERROR", "配置校验失败:");
  configErrors.forEach((err) => log("ERROR", `  - ${err}`));
  log("ERROR", "请检查 .env 文件或环境变量后重试");
  process.exit(1);
}

// ============================================================
// 优雅退出
// ============================================================

let shuttingDown = false;
let timer;
let snapshotTimer;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  log("INFO", `收到 ${signal} 信号，正在停止...`);
  clearInterval(timer);
  clearTimeout(snapshotTimer);
  clearInterval(snapshotTimer);

  // 给进行中的一轮检查留出收尾时间
  setTimeout(() => {
    log("INFO", "程序已退出");
    process.exit(0);
  }, 1000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ============================================================
// 启动
// ============================================================

/**
 * 每日快照：汇总推送所有实例当前 IP
 */
async function runDailySnapshot() {
  log("INFO", "开始每日快照");
  const { entries } = await fetchAllInstances();
  if (entries.length > 0) {
    await notifyDailySnapshot(entries);
  }
  log("INFO", `每日快照完成，共 ${entries.length} 个实例`);
}

/**
 * 调度每日快照：每天指定小时触发一次
 */
function scheduleDailySnapshot() {
  if (!config.dailySnapshot.enabled) {
    log("INFO", "每日快照已禁用（DAILY_SNAPSHOT_ENABLED=false）");
    return;
  }

  const now = new Date();
  const next = new Date(now);
  next.setHours(config.dailySnapshot.hour, 0, 0, 0);
  // 今天的时刻已过，顺延到明天
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }

  log(
    "INFO",
    `每日快照已启用，下次快照: ${next.toLocaleString("zh-CN", { hour12: false })}`
  );

  snapshotTimer = setTimeout(async () => {
    await runDailySnapshot();
    // 之后每天循环
    snapshotTimer = setInterval(async () => {
      await runDailySnapshot();
    }, 24 * 60 * 60 * 1000);
  }, next.getTime() - now.getTime());
}

async function main() {
  log("INFO", `PulseX 启动，检查间隔: ${config.interval} 分钟`);

  // 首次运行（状态文件不存在）建立基准并发送上线通知
  const isFirstRun = !hasState();
  if (isFirstRun) {
    await firstRun();
  }

  scheduleDailySnapshot();

  runCheck();
  timer = setInterval(() => {
    runCheck();
  }, config.interval * 60 * 1000);
}

main();
