require("dotenv").config();

const config = {
  // AWS 区域（多个用逗号分隔，如 "ap-northeast-1,us-east-1"）
  regions: (process.env.AWS_REGIONS || "ap-northeast-1").split(",").map((r) => r.trim()),

  // AWS 凭证（只需只读权限）
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },

  // 检查间隔（分钟），默认 1
  interval: parseFloat(process.env.CHECK_INTERVAL_MIN || "1"),

  // Server酱 推送 Token（可选，留空不推送）
  serverChanToken: process.env.SERVER_CHAN_TOKEN || "",

  // Telegram 推送（可选，两者都填才会推送）
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID || "",
  },

  // 每日快照（可选，默认启用，每天定时推送一次所有实例 IP 汇总）
  dailySnapshot: {
    enabled: (process.env.DAILY_SNAPSHOT_ENABLED || "true") !== "false",
    hour: parseInt(process.env.DAILY_SNAPSHOT_HOUR || "0", 10),
  },

  // 拉取失败告警防抖间隔（分钟），同一区域失败至少间隔这么久才再次告警
  fetchFailureAlertMin: parseInt(process.env.FETCH_FAILURE_ALERT_MIN || "30", 10),

  // IP 状态文件（记录上次已知 IP）
  stateFile: process.env.STATE_FILE || "ip-state.json",
};

/**
 * 校验配置是否完整
 * @returns {string[]} 错误信息数组，为空则配置正常
 */
function validateConfig() {
  const errors = [];

  if (!config.credentials.accessKeyId) {
    errors.push("AWS_ACCESS_KEY_ID 未设置");
  }
  if (!config.credentials.secretAccessKey) {
    errors.push("AWS_SECRET_ACCESS_KEY 未设置");
  }
  if (config.regions.length === 0 || !config.regions[0]) {
    errors.push("AWS_REGIONS 未设置或格式不正确");
  }
  if (Number.isNaN(config.interval) || config.interval < 1) {
    errors.push("CHECK_INTERVAL_MIN 必须大于 0");
  }
  if (
    Number.isNaN(config.dailySnapshot.hour) ||
    config.dailySnapshot.hour < 0 ||
    config.dailySnapshot.hour > 23
  ) {
    errors.push("DAILY_SNAPSHOT_HOUR 必须是 0-23 的整数");
  }
  if (Number.isNaN(config.fetchFailureAlertMin) || config.fetchFailureAlertMin < 1) {
    errors.push("FETCH_FAILURE_ALERT_MIN 必须大于 0");
  }

  return errors;
}

module.exports = config;
module.exports.validateConfig = validateConfig;
