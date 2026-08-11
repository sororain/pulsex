const { clients, fetchInstances } = require("./lightsail");
const { notifyIpChange, notifyMonitorOnline } = require("./notifier");
const { loadState, saveState } = require("./state");
const { log } = require("./logger");
const config = require("./config");

// ============================================================
// 业务流程编排
// ============================================================

/**
 * 生成状态键：区域/实例名（实例名可能跨区域重复）
 */
const stateKey = (region, name) => `${region}/${name}`;

/**
 * 并发获取所有区域的实例列表
 * @returns {Promise<Array<{region: string, name: string, ip: string}>>}
 */
async function fetchAllInstances() {
  const results = await Promise.allSettled(
    clients.map(async ({ region, client }) => {
      const servers = await fetchInstances(client);
      return { region, servers };
    })
  );

  const entries = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      const { region, servers } = result.value;
      for (const server of servers) {
        // 跳过无公网 IP 的实例
        if (!server.publicIpAddress) continue;
        entries.push({
          region,
          name: server.name,
          ip: server.publicIpAddress,
        });
      }
    } else {
      log("ERROR", `获取实例列表失败: ${result.reason.message}`);
    }
  }

  return entries;
}

/**
 * 执行一轮 IP 检查：对比上次记录，变化则通知 + 留档 + 更新基准
 */
async function runCheck() {
  log("INFO", "开始新一轮 IP 检查");

  const entries = await fetchAllInstances();
  if (entries.length === 0) {
    log("WARN", "未获取到任何带公网 IP 的实例");
  }

  const state = loadState();
  const changes = [];

  for (const entry of entries) {
    const key = stateKey(entry.region, entry.name);
    const lastIp = state[key];

    if (lastIp === undefined) {
      // 新实例：记录基准，不通知
      log("INFO", `新增基准: ${key} (${entry.ip})`);
      state[key] = entry.ip;
    } else if (lastIp !== entry.ip) {
      // IP 已变化：通知 + 留档 + 更新基准
      log("WARN", `${key} IP 变更: ${lastIp} → ${entry.ip}`);
      changes.push({ ...entry, oldIp: lastIp });
      state[key] = entry.ip;
    }
  }

  // 清理已消失实例的旧记录，避免状态文件堆积脏数据
  const currentKeys = new Set(entries.map((e) => stateKey(e.region, e.name)));
  let removed = 0;
  for (const key of Object.keys(state)) {
    if (!currentKeys.has(key)) {
      log("INFO", `清理已消失实例的记录: ${key}`);
      delete state[key];
      removed++;
    }
  }

  saveState(state);

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
}

/**
 * 首次运行：建立基准，并发送上线汇总通知
 */
async function firstRun() {
  log("INFO", "首次运行，建立 IP 基准...");

  const entries = await fetchAllInstances();

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

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  log("INFO", `收到 ${signal} 信号，正在停止...`);
  clearInterval(timer);

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

async function main() {
  log("INFO", `PulseX 启动，检查间隔: ${config.interval} 分钟`);

  // 首次运行（状态文件为空）建立基准并发送上线通知
  const isFirstRun = Object.keys(loadState()).length === 0;
  if (isFirstRun) {
    await firstRun();
  }

  runCheck();
  timer = setInterval(() => {
    runCheck();
  }, config.interval * 60 * 1000);
}

main();
