const axios = require("axios").default;
const config = require("./config");
const { log } = require("./logger");

/**
 * 通过 Server酱 发送通知
 * @param {string} title - 标题
 * @param {string} desp - 正文（支持换行）
 */
async function sendByServerChan(title, desp) {
  if (!config.serverChanToken) {
    log("WARN", "未配置 SERVER_CHAN_TOKEN，跳过推送");
    return;
  }

  try {
    await axios.request({
      method: "POST",
      url: `https://sctapi.ftqq.com/${config.serverChanToken}.send`,
      headers: { "Content-Type": "application/json" },
      data: { title, desp },
    });
    log("INFO", "Server酱 通知发送成功");
  } catch (err) {
    log("ERROR", `Server酱 通知发送失败: ${err.message}`);
  }
}

/**
 * 通过 Telegram Bot 发送通知
 * @param {string} title - 标题
 * @param {string} desp - 正文（支持换行）
 */
async function sendByTelegram(title, desp) {
  if (!config.telegram.botToken || !config.telegram.chatId) {
    log("WARN", "未配置 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID，跳过 Telegram 推送");
    return;
  }

  try {
    await axios.request({
      method: "POST",
      url: `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`,
      headers: { "Content-Type": "application/json" },
      data: {
        chat_id: config.telegram.chatId,
        text: `${title}\n\n${desp}`,
      },
    });
    log("INFO", "Telegram 通知发送成功");
  } catch (err) {
    log("ERROR", `Telegram 通知发送失败: ${err.message}`);
  }
}

/**
 * 发送到所有已配置的通知渠道（Server酱 + Telegram）
 */
async function sendAll(title, desp) {
  // 并行发送，互不影响（一个渠道失败不影响另一个）
  await Promise.allSettled([sendByServerChan(title, desp), sendByTelegram(title, desp)]);
}

/**
 * 发送 IP 变更通知并留档
 * @param {object} detail - 通知详情
 * @param {string} detail.instanceName - 实例名称
 * @param {string} detail.region - 区域
 * @param {string} detail.oldIp - 旧 IP
 * @param {string} detail.newIp - 新 IP
 */
async function notifyIpChange({ instanceName, region, oldIp, newIp }) {
  const time = new Date().toLocaleString("zh-CN", { hour12: false });
  const desp = [
    `实例: ${instanceName}`,
    `区域: ${region}`,
    `旧 IP: ${oldIp}`,
    `新 IP: ${newIp}`,
    `时间: ${time}`,
  ].join("\n");

  log("CHANGE", `${instanceName} IP已变更 ${oldIp} → ${newIp}`);

  await sendAll(`🔔 IP变更: ${instanceName}`, desp);
}

/**
 * 发送监控上线汇总通知（首次运行）
 * @param {Array} entries - [{region, name, ip}]
 */
async function notifyMonitorOnline(entries) {
  const time = new Date().toLocaleString("zh-CN", { hour12: false });
  const lines = entries.map((e) => `- ${e.region}/${e.name}: ${e.ip}`).join("\n");
  const desp = [
    `PulseX 监控已上线，当前 ${entries.length} 台实例：`,
    "",
    lines,
    "",
    `时间: ${time}`,
  ].join("\n");

  await sendAll("🚀 PulseX 监控已上线", desp);
}

/**
 * 发送每日快照汇总通知
 * @param {Array} entries - [{region, name, ip}]
 */
async function notifyDailySnapshot(entries) {
  const time = new Date().toLocaleString("zh-CN", { hour12: false });
  const lines = entries.map((e) => `- ${e.region}/${e.name}: ${e.ip}`).join("\n");
  const desp = [
    `当前 ${entries.length} 台实例：`,
    "",
    lines,
    "",
    `时间: ${time}`,
  ].join("\n");

  await sendAll("📊 PulseX 每日快照", desp);
}

/**
 * 发送拉取失败告警
 * @param {object} detail - {region, reason}
 */
async function notifyFetchFailure({ region, reason }) {
  const time = new Date().toLocaleString("zh-CN", { hour12: false });
  const desp = [
    `区域: ${region}`,
    `原因: ${reason}`,
    `时间: ${time}`,
    "",
    "请检查 AWS 凭证、网络或服务状态。",
  ].join("\n");

  await sendAll(`⚠️ PulseX 拉取失败: ${region}`, desp);
}

module.exports = { notifyIpChange, notifyMonitorOnline, notifyDailySnapshot, notifyFetchFailure };
