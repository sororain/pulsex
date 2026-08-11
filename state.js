const fs = require("fs");
const path = require("path");
const config = require("./config");
const { log } = require("./logger");

const STATE_FILE = path.join(__dirname, config.stateFile);

/**
 * 读取 IP 状态文件
 * 结构: { "区域/实例名": "1.2.3.4" }
 * @returns {object} 状态对象，读取失败或文件不存在时返回空对象
 */
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    log("ERROR", `读取状态文件失败: ${err.message}`);
    return {};
  }
}

/**
 * 保存 IP 状态文件
 * @param {object} state - 状态对象
 */
function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    log("ERROR", `写入状态文件失败: ${err.message}`);
  }
}

/**
 * 判断状态文件是否已存在（用于判定是否首次运行）
 * @returns {boolean}
 */
function hasState() {
  try {
    return fs.existsSync(STATE_FILE);
  } catch (err) {
    log("ERROR", `检查状态文件失败: ${err.message}`);
    return false;
  }
}

module.exports = { loadState, saveState, hasState };
