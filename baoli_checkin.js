"use strict";

/*
Loon cron script.

Recommended argument examples:
token=YOUR_TOKEN&retry=3&timeout=20000&notify=1
mallId=3583&checkOnly=1&notify=0
storeKey=baoli_token&save=1&token=YOUR_TOKEN
mallStoreKey=baoli_mall_id
node=YourPolicyName
*/

const CONFIG = {
  baseUrl: "https://a.china-smartech.com",
  capturedToken: "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI5NTExNTMxIiwiZ3VhcmQiOiJtZW1iZXIiLCJtYWxsX2lkIjoiMzU4MyIsImlzcyI6Imh0dHBzOi8vYS5jaGluYS1zbWFydGVjaC5jb20vcmVzdGZ1bC9tZW1iZXIveC90b2tlbiIsImV4cCI6NDA5MjU5OTM0OSwiaWF0IjoxNzczNTcwODQ1LCJhcHBfaWQiOiJ3eGI1ZTNmMzAwNzZmM2E2YzAifQ.qpxJv6hAJRflYTUL__tp3ro_4AXeTZ_XXGOl19QQRoE",
  defaultTimeoutMs: 20000,
  defaultRetry: 2,
  defaultNotify: true,
  defaultStoreKey: "baoli_token",
  defaultMallStoreKey: "baoli_mall_id",
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.69(0x18004531) NetType/4G Language/zh_CN",
  notificationOpenUrl: "loon://",
  successCodes: {
    0: true,
    200: true,
  },
};

function log(message) {
  if (typeof console !== "undefined" && console && typeof console.log === "function") {
    console.log("[baoli] " + message);
  }
  return message;
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value || "").replace(/\+/g, "%20"));
  } catch (_) {
    return String(value || "");
  }
}

function parseArgument(rawArgument) {
  const result = {};
  if (!rawArgument || typeof rawArgument !== "string") {
    return result;
  }

  rawArgument.split(/[&\n,]/).forEach(function (part) {
    const item = String(part || "").trim();
    if (!item) {
      return;
    }
    const index = item.indexOf("=");
    if (index === -1) {
      result[safeDecode(item)] = "1";
      return;
    }
    const key = safeDecode(item.slice(0, index).trim());
    const value = safeDecode(item.slice(index + 1).trim());
    if (key) {
      result[key] = value;
    }
  });

  return result;
}

function normalizeToken(token) {
  let value = String(token || "").replace(/[\r\n]/g, "").trim();
  if (!value) {
    return "";
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  if (/^bearer\s+/i.test(value)) {
    value = value.replace(/^bearer\s+/i, "").trim();
  }
  return value;
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].indexOf(normalized) !== -1) {
    return true;
  }
  if (["0", "false", "no", "off"].indexOf(normalized) !== -1) {
    return false;
  }
  return defaultValue;
}

function parseInteger(value, defaultValue, minValue) {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return defaultValue;
  }
  if (typeof minValue === "number" && parsed < minValue) {
    return defaultValue;
  }
  return parsed;
}

function normalizeTimeout(value, defaultValue) {
  const parsed = parseInteger(value, defaultValue, 1);
  if (parsed <= 120) {
    return parsed * 1000;
  }
  return parsed;
}

function safeInt(value, defaultValue) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function hasPersistentStore() {
  return typeof $persistentStore !== "undefined" && $persistentStore && typeof $persistentStore.read === "function";
}

function readStore(key) {
  if (!hasPersistentStore() || !key) {
    return "";
  }
  return String($persistentStore.read(key) || "");
}

function writeStore(key, value) {
  if (!hasPersistentStore() || !key || !value || typeof $persistentStore.write !== "function") {
    return false;
  }
  try {
    return $persistentStore.write(String(value), String(key));
  } catch (_) {
    return false;
  }
}

function base64UrlToUtf8(value) {
  const base64 = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "===".slice((base64.length + 3) % 4);

  if (typeof atob === "function") {
    const binary = atob(padded);
    let hex = "";
    for (let i = 0; i < binary.length; i += 1) {
      hex += "%" + ("00" + binary.charCodeAt(i).toString(16)).slice(-2);
    }
    return decodeURIComponent(hex);
  }

  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  let output = "";
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < padded.length; i += 1) {
    const current = padded.charAt(i);
    if (current === "=") {
      break;
    }
    const index = chars.indexOf(current);
    if (index < 0) {
      continue;
    }
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }

  let hex = "";
  for (let i = 0; i < output.length; i += 1) {
    hex += "%" + ("00" + output.charCodeAt(i).toString(16)).slice(-2);
  }
  return decodeURIComponent(hex);
}

function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) {
    throw new Error("token 不是有效的 JWT");
  }
  const payload = JSON.parse(base64UrlToUtf8(parts[1]));
  if (!payload || typeof payload !== "object") {
    throw new Error("token payload 解析失败");
  }
  return payload;
}

function isTokenExpired(payload) {
  const exp = safeInt(payload && payload.exp, 0);
  return exp > 0 && exp <= Math.floor(Date.now() / 1000);
}

function toText(data) {
  if (typeof data === "string") {
    return data;
  }
  if (data === undefined || data === null) {
    return "";
  }
  if (typeof data === "object" && typeof data.byteLength === "number") {
    const view = data instanceof Uint8Array ? data : new Uint8Array(data);
    let output = "";
    for (let i = 0; i < view.length; i += 1) {
      output += String.fromCharCode(view[i]);
    }
    try {
      return decodeURIComponent(
        output
          .split("")
          .map(function (char) {
            return "%" + ("00" + char.charCodeAt(0).toString(16)).slice(-2);
          })
          .join("")
      );
    } catch (_) {
      return output;
    }
  }
  return String(data);
}

function parseApiResult(bodyText, httpStatus) {
  let raw;
  try {
    raw = JSON.parse(bodyText);
  } catch (_) {
    throw new Error("接口未返回合法 JSON: " + bodyText);
  }

  if (!raw || typeof raw !== "object") {
    throw new Error("接口返回结构异常: " + bodyText);
  }

  return {
    httpStatus: safeInt(httpStatus, 0),
    code: safeInt(raw.code, -1),
    msg: String(raw.msg || ""),
    data: raw.data,
    raw: raw,
  };
}

function httpRequest(method, params) {
  return new Promise(function (resolve, reject) {
    if (typeof $httpClient === "undefined" || !$httpClient || typeof $httpClient[method] !== "function") {
      reject(new Error("当前环境不支持 Loon $httpClient"));
      return;
    }

    $httpClient[method](params, function (error, response, data) {
      if (error) {
        reject(new Error(String(error)));
        return;
      }
      resolve({
        status: response && response.status,
        headers: (response && response.headers) || {},
        data: data,
      });
    });
  });
}

async function requestJson(method, path, token, options) {
  const headers = {
    Accept: "application/json",
    Authorization: "Bearer " + token,
    "User-Agent": options.userAgent,
  };

  const request = {
    url: options.baseUrl + path,
    timeout: options.timeoutMs,
    headers: headers,
  };

  if (options.node) {
    request.node = options.node;
  }

  if (options.body !== undefined) {
    request.headers["Content-Type"] = "application/json";
    request.body = JSON.stringify(options.body);
  }

  const attempts = Math.max(1, options.retry + 1);
  let lastError = "";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await httpRequest(method, request);
      return parseApiResult(toText(response.data), response.status);
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
      if (attempt < attempts) {
        await sleep(Math.min(2000, attempt * 1000));
      }
    }
  }

  throw new Error("请求失败，已重试 " + attempts + " 次: " + lastError);
}

function getTodayEntry(formData) {
  if (!formData || !Array.isArray(formData.days)) {
    return null;
  }
  for (let i = 0; i < formData.days.length; i += 1) {
    const item = formData.days[i];
    if (item && safeInt(item.today, 0) === 1) {
      return item;
    }
  }
  return null;
}

function formatFormSummary(formData) {
  const today = getTodayEntry(formData);
  if (!today) {
    return "未找到今日签到记录。";
  }

  const stat = formData && formData.stat ? formData.stat : {};
  const checked = safeInt(today.point_total, 0) > 0;
  const day = today.day || "今天";
  const pointTotal = safeInt(today.point_total, 0);
  const continuous = safeInt(stat.continuous_count, 0);
  return day + " " + (checked ? "已签到" : "未签到") + "，今日积分 " + pointTotal + "，连续签到 " + continuous + " 天。";
}

function isSuccess(result) {
  return Boolean(CONFIG.successCodes[result.code]);
}

function isAlreadyCheckedIn(result) {
  return String(result && result.msg || "").indexOf("已签到") !== -1;
}

function isAuthError(result) {
  const status = safeInt(result && result.httpStatus, 0);
  const code = safeInt(result && result.code, 0);
  return status === 401 || status === 403 || code === 401 || code === 403;
}

function getPoints(data) {
  if (!data || typeof data !== "object") {
    return {
      point: 0,
      totalPoint: 0,
    };
  }
  return {
    point: safeInt(data.point, 0),
    totalPoint: safeInt(data.total_point, 0),
  };
}

function postNotification(enabled, title, subtitle, content) {
  if (!enabled || typeof $notification === "undefined" || !$notification || typeof $notification.post !== "function") {
    return;
  }
  $notification.post(title, subtitle, content, CONFIG.notificationOpenUrl);
}

function buildRuntimeConfig() {
  const args = parseArgument(typeof $argument === "string" ? $argument : "");
  const storeKey = String(args.storeKey || args.store_key || CONFIG.defaultStoreKey || "").trim();
  const mallStoreKey = String(args.mallStoreKey || args.mall_store_key || CONFIG.defaultMallStoreKey || "").trim();

  if (parseBoolean(args.save || args.persist, false) && args.token) {
    const saved = writeStore(storeKey, normalizeToken(args.token));
    log(saved ? "已将 token 写入本地存储。" : "写入 token 到本地存储失败。");
  }

  if (parseBoolean(args.save || args.persist, false) && (args.mallId || args.mall_id)) {
    writeStore(mallStoreKey, String(args.mallId || args.mall_id).trim());
  }

  const token = normalizeToken(args.token || readStore(storeKey) || CONFIG.capturedToken);
  const notify = parseBoolean(args.notify, CONFIG.defaultNotify);
  const timeoutMs = normalizeTimeout(args.timeout, CONFIG.defaultTimeoutMs);
  const retry = parseInteger(args.retry, CONFIG.defaultRetry, 0);

  return {
    args: args,
    token: token,
    storeKey: storeKey,
    mallStoreKey: mallStoreKey,
    mallId: String(args.mallId || args.mall_id || readStore(mallStoreKey) || "").trim(),
    notify: notify,
    checkOnly: parseBoolean(args.checkOnly || args.check_only, false),
    timeoutMs: timeoutMs,
    retry: retry,
    node: String(args.node || "").trim(),
    baseUrl: CONFIG.baseUrl,
    userAgent: CONFIG.userAgent,
  };
}

async function runCheckIn(config) {
  if (!config.token) {
    throw new Error("缺少 token。请先启用抓 token 脚本并打开一次小程序签到页，或手动通过 argument 传 token=...");
  }

  let jwtPayload = null;
  try {
    jwtPayload = decodeJwtPayload(config.token);
  } catch (error) {
    if (!config.mallId) {
      throw new Error("token 解析失败，且没有提供 mallId。");
    }
    log("token 不是标准 JWT，改用 argument 里的 mallId。");
  }

  if (jwtPayload && isTokenExpired(jwtPayload)) {
    throw new Error("token 已过期，请重新抓包替换。");
  }

  const mallId = config.mallId || String((jwtPayload && jwtPayload.mall_id) || "").trim();
  if (!mallId) {
    throw new Error("无法确定 mallId。请先启用抓 token 脚本，或在 argument 中传 mallId=3583。");
  }

  let formError = "";

  try {
    const form = await requestJson("get", "/restful/mall/" + mallId + "/checkInForm?with_records=1", config.token, {
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      retry: config.retry,
      userAgent: config.userAgent,
      node: config.node,
    });

    if (isSuccess(form) && form.data && typeof form.data === "object") {
      const summary = formatFormSummary(form.data);
      log(summary);
      const today = getTodayEntry(form.data);
      if (today && safeInt(today.point_total, 0) > 0) {
        const message = "今天已经签到，无需重复签到。";
        log(message);
        postNotification(config.notify, "保利签到", "无需重复签到", summary);
        return;
      }
    } else {
      formError = "查询签到状态失败: http=" + form.httpStatus + ", code=" + form.code + ", msg=" + form.msg;
    }
  } catch (error) {
    formError = error && error.message ? error.message : String(error);
  }

  if (config.checkOnly) {
    if (formError) {
      throw new Error(formError);
    }
    const message = "仅检查状态完成，今天还未签到。";
    log(message);
    postNotification(config.notify, "保利签到", "状态检查完成", message);
    return;
  }

  if (formError) {
    log(formError);
    log("查询失败，继续尝试直接签到。");
  }

  const sign = await requestJson("post", "/restful/mall/" + mallId + "/checkInRecord", config.token, {
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    retry: config.retry,
    userAgent: config.userAgent,
    node: config.node,
    body: {
      latitude: 0,
      longitude: 0,
    },
  });

  if (isSuccess(sign)) {
    const points = getPoints(sign.data);
    const successMessage = "签到成功，获得 " + points.point + " 积分，累计 " + points.totalPoint + " 积分。";
    log(successMessage);
    postNotification(config.notify, "保利签到", "签到成功", successMessage);
    return;
  }

  if (isAlreadyCheckedIn(sign)) {
    const alreadyMessage = "今天已经签到。";
    log(alreadyMessage);
    postNotification(config.notify, "保利签到", "无需重复签到", alreadyMessage);
    return;
  }

  if (isAuthError(sign)) {
    throw new Error("签到失败：token 可能已失效，请重新抓包替换 token。");
  }

  throw new Error("签到失败: http=" + sign.httpStatus + ", code=" + sign.code + ", msg=" + sign.msg);
}

async function main() {
  const config = buildRuntimeConfig();
  await runCheckIn(config);
}

function isLoonRuntime() {
  return typeof $done === "function" && typeof $httpClient !== "undefined";
}

if (isLoonRuntime()) {
  main()
    .catch(function (error) {
      const message = error && error.message ? error.message : String(error);
      log(message);
      const args = parseArgument(typeof $argument === "string" ? $argument : "");
      const notify = parseBoolean(args.notify, CONFIG.defaultNotify);
      postNotification(notify, "保利签到", "执行失败", message);
    })
    .finally(function () {
      $done();
    });
} else {
  log("This script is intended to run inside Loon.");
}
