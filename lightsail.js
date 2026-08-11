const { LightsailClient, GetInstancesCommand } = require("@aws-sdk/client-lightsail");
const config = require("./config");
const { log } = require("./logger");

// 创建各区域客户端，配置 AWS SDK 内置重试（最多 3 次，指数退避）
const clients = config.regions.map((region) => ({
  region,
  client: new LightsailClient({
    region,
    credentials: config.credentials,
    maxAttempts: 3,
  }),
}));

/**
 * 带重试的 API 调用包装（在 AWS SDK 内置重试之上增加日志）
 */
async function withRetry(operation, context) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const isRetryable =
        err.name === "ThrottlingException" ||
        err.name === "RequestLimitExceeded" ||
        err.name === "ServiceUnavailableException" ||
        err.code === "ECONNRESET" ||
        err.code === "ENETUNREACH" ||
        err.code === "ETIMEDOUT" ||
        err.$metadata?.httpStatusCode === 429;

      if (!isRetryable || attempt === 3) {
        log("ERROR", `${context} 失败: ${err.message}`);
        throw err;
      }

      const delay = Math.pow(2, attempt) * 1000;
      log("WARN", `${context} 限流，${delay / 1000}s 后重试 (${attempt}/2)`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

/**
 * 获取区域内全部实例（自动分页）
 * @param {LightsailClient} client
 * @returns {Promise<Array>} 实例列表
 */
async function fetchInstances(client) {
  const instances = [];
  let pageToken;

  do {
    const response = await withRetry(async () => {
      const command = new GetInstancesCommand(pageToken ? { pageToken } : {});
      return await client.send(command);
    }, "获取实例列表");
    instances.push(...(response.instances || []));
    pageToken = response.nextPageToken;
  } while (pageToken);

  return instances;
}

module.exports = {
  clients,
  fetchInstances,
};
