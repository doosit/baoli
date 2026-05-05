/*
 * Baoli check-in script for Loon.
 *
 * Loon plugin URL:
 * https://raw.githubusercontent.com/doosit/baoli/refs/heads/main/baoli.plugin
 *
 * Raw script URL:
 * https://raw.githubusercontent.com/doosit/baoli/refs/heads/main/baoli_loon_sign.js
 *
 * Other examples:
 * http-request ^https:\/\/a\.china-smartech\.com\/restful\/mall\/\d+\/ script-path=/path/to/baoli_loon_sign.js,tag=BaoliCapture,requires-body=false,timeout=30,argument="action=sign"
 * cron "6 7 * * *" script-path=/path/to/baoli_loon_sign.js,tag=BaoliDailySign,timeout=120,argument="action=sign"
 *
 * How it works:
 * 1. Use the http-request rule to capture one request from the Baoli mini-program through Loon.
 * 2. The script stores token, mallId and a small header set in Loon persistent storage.
 * 3. The cron task reads the latest capture and performs the daily check-in automatically.
 *
 * Important:
 * - This is automatic packet capture, not simulated login.
 * - If token expires, open the mini-program once through Loon to refresh it.
 */

const ACTIONS = {
  sign: {
    name: "签到",
    storeKey: "baoli.loon.action.sign",
    urlPattern: /^https:\/\/a\.china-smartech\.com\/restful\/mall\/\d+\//i,
    statusPath(mallId) {
      return `/restful/mall/${mallId}/checkInForm?with_records=1`;
    },
    signPath(mallId) {
      return `/restful/mall/${mallId}/checkInRecord`;
    },
    isAlreadySigned(json) {
      const data = json && json.data;
      const today = getTodayEntry(data);
      return Boolean(today && safeInt(today.point_total, 0) > 0);
    },
    statusMessage(json) {
      const data = json && json.data;
      const today = getTodayEntry(data);
      if (!today) {
        return "未找到今日签到记录。";
      }
      const stat = data && data.stat ? data.stat : {};
      const checked = safeInt(today.point_total, 0) > 0;
      const day = today.day || "今天";
      const pointTotal = safeInt(today.point_total, 0);
      const continuous = safeInt(stat.continuous_count, 0);
      return `${day} ${checked ? "已签到" : "未签到"}，今日积分 ${pointTotal}，连续签到 ${continuous} 天。`;
    },
    isSignSuccess(json) {
      return json && json.code === 200;
    },
    isAlreadySignedResponse(json) {
      return json && typeof json.msg === "string" && json.msg.indexOf("已签到") !== -1;
    },
    successMessage(json) {
      const data = json && json.data ? json.data : {};
      return `签到成功，获得 ${safeInt(data.point, 0)} 积分，累计 ${safeInt(data.total_point, 0)} 积分。`;
    },
  },
};

const DEFAULT_ACTION = "sign";
const BASE_URL = "https://a.china-smartech.com";
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.69(0x18004531) NetType/4G Language/zh_CN";
const SCRIPT_NAME = "保利签到";
const LOCK_KEY = "baoli.loon.runtime.lock";
const LOCK_TTL_MS = 60 * 1000;
const LOCK_CLOCK_SKEW_MS = 5 * 1000;
const WATCHDOG_TIMEOUT_MS = 55 * 1000;
const MAX_NOTIFICATION_DETAIL = 240;

const runtimeState = {
  runId: createRunId(),
  lockAcquired: false,
  lockOptional: false,
  completed: false,
  lastMessage: "",
  watchdogTimer: null,
};

try {
  main();
} catch (error) {
  handleFatalError(error);
}

function main() {
  startWatchdog();
  const args = parseArgument(typeof $argument === "string" ? $argument : "");
  const detectedActionKey = detectActionFromRequest();
  const actionKey = args.action || detectedActionKey || DEFAULT_ACTION;
  setRuntimeMessage(`启动执行: action=${actionKey}${typeof $request !== "undefined" ? " | mode=request" : " | mode=task"}`);

  if (typeof $request !== "undefined") {
    const action = ACTIONS[detectedActionKey || actionKey];
    if (!action) {
      finish(`未识别的 action: ${actionKey}`);
      return;
    }
    captureRequest(action);
    return;
  }

  if (!acquireLock(actionKey)) {
    const lock = readJSON(LOCK_KEY);
    const detail = lock ? formatLockDetail(lock) : "检测到有效运行锁。";
    finish("检测到脚本已在运行", false, `${detail} 为避免重复签到，本次执行已跳过`);
    return;
  }

  const action = ACTIONS[actionKey];
  if (!action) {
    finish(`未识别的 action: ${actionKey}`);
    return;
  }

  replayRequest(action);
}

function detectActionFromRequest() {
  if (typeof $request === "undefined" || !$request || !$request.url) {
    return "";
  }

  const url = $request.url;
  for (const key of Object.keys(ACTIONS)) {
    if (ACTIONS[key].urlPattern.test(url)) {
      return key;
    }
  }
  return "";
}

function captureRequest(action) {
  const request = $request || {};
  const url = request.url || "";
  const method = (request.method || "GET").toUpperCase();
  const headers = normalizeHeaders(request.headers || {});
  const token = normalizeToken(getHeader(headers, "Authorization"));
  const bodyText = normalizeBody(request.body);
  const tokenPayload = safeDecodeJwtPayload(token);
  const mallId = extractMallId(url) || String(tokenPayload && tokenPayload.mall_id || "").trim();

  log(`捕获请求: ${action.name} | ${method} | ${url}`);

  if (!action.urlPattern.test(url)) {
    finish(`当前请求不是${action.name}接口，已跳过`, true);
    return;
  }
  if (!token) {
    finish(`已命中${action.name}接口，但请求头缺少 Authorization`);
    return;
  }
  if (!mallId) {
    finish(`已命中${action.name}接口，但无法解析 mallId`);
    return;
  }

  const payload = {
    action: action.name,
    url: url,
    method: method,
    headers: headers,
    body: bodyText,
    token: token,
    mallId: mallId,
    capturedAt: Date.now(),
  };

  const ok = writeJSON(action.storeKey, payload);
  if (!ok) {
    finish(`保存${action.name}抓包失败`);
    return;
  }

  const detail = `mallId=${mallId} | token=${maskValue(token, 6, 6)} | 抓包时间=${formatAge(payload.capturedAt)}`;
  notify(`保利${action.name}`, "抓包保存成功", detail);
  done({});
}

function replayRequest(action) {
  executeAction(action, function(result) {
    try {
      notifyResult(result);
    } catch (error) {
      notify(SCRIPT_NAME, "通知结果失败", truncateText(error && error.message ? error.message : String(error)));
    }
    done();
  });
}

function executeAction(action, callback) {
  const saved = readJSON(action.storeKey);
  log(`准备执行: ${action.name}`);
  if (!saved) {
    callback({
      ok: false,
      actionName: action.name,
      title: `保利${action.name}`,
      subtitle: `没有找到已保存的${action.name}抓包`,
      detail: "请先打开一次小程序签到页，让 Loon 自动抓包",
    });
    return;
  }

  const payloadError = validateSavedPayload(action, saved);
  if (payloadError) {
    callback({
      ok: false,
      actionName: action.name,
      title: `保利${action.name}`,
      subtitle: `${action.name}抓包数据无效`,
      detail: payloadError,
    });
    return;
  }

  const tokenPayload = safeDecodeJwtPayload(saved.token);
  if (tokenPayload && isTokenExpired(tokenPayload)) {
    callback({
      ok: false,
      actionName: action.name,
      title: `保利${action.name}`,
      subtitle: "token 已过期",
      detail: "请重新打开一次小程序签到页，让抓包自动刷新",
    });
    return;
  }

  queryStatus(action, saved, function(statusResult) {
    if (statusResult.alreadySigned) {
      callback({
        ok: true,
        actionName: action.name,
        title: `保利${action.name}`,
        subtitle: "无需重复签到",
        detail: truncateText(`${statusResult.summary} | 抓包时间: ${formatAge(saved.capturedAt)}`),
      });
      return;
    }
    signNow(action, saved, statusResult, callback);
  });
}

function queryStatus(action, saved, callback) {
  const sender = resolveSender("get");
  if (!sender) {
    callback({
      alreadySigned: false,
      warning: "当前环境不支持 GET 请求",
      summary: "",
    });
    return;
  }

  const requestOptions = {
    url: BASE_URL + action.statusPath(saved.mallId),
    headers: buildRequestHeaders(saved, false),
    timeout: DEFAULT_TIMEOUT_MS,
  };

  sender(requestOptions, function(error, response, data) {
    if (error) {
      callback({
        alreadySigned: false,
        warning: `状态查询失败: ${String(error)}`,
        summary: "",
      });
      return;
    }

    const responseText = extractResponseText(response, data);
    const status = getStatusCode(response);
    const json = safeJsonParse(responseText);
    log(`状态接口返回: ${action.name} | HTTP ${status || 0}`);

    if (status !== 200 || !json || safeInt(json.code, 0) !== 200) {
      callback({
        alreadySigned: false,
        warning: `状态查询未成功: HTTP ${status || 0}`,
        summary: truncateText(responseText),
      });
      return;
    }

    callback({
      alreadySigned: action.isAlreadySigned(json),
      warning: "",
      summary: action.statusMessage(json),
    });
  });
}

function signNow(action, saved, statusResult, callback) {
  const sender = resolveSender("post");
  if (!sender) {
    callback({
      ok: false,
      actionName: action.name,
      title: `保利${action.name}`,
      subtitle: "当前环境不支持 POST 请求",
      detail: "",
    });
    return;
  }

  const requestOptions = {
    url: BASE_URL + action.signPath(saved.mallId),
    headers: buildRequestHeaders(saved, true),
    body: JSON.stringify({
      latitude: 0,
      longitude: 0,
    }),
    timeout: DEFAULT_TIMEOUT_MS,
  };

  sender(requestOptions, function(error, response, data) {
    if (error) {
      callback({
        ok: false,
        actionName: action.name,
        title: `保利${action.name}`,
        subtitle: `${action.name}请求失败: ${String(error)}`,
        detail: buildRecaptureHint(saved),
      });
      return;
    }

    const responseText = extractResponseText(response, data);
    const status = getStatusCode(response);
    const json = safeJsonParse(responseText);
    log(`签到接口返回: ${action.name} | HTTP ${status || 0}`);

    if (status !== 200) {
      callback({
        ok: false,
        actionName: action.name,
        title: `保利${action.name}`,
        subtitle: `${action.name}请求返回 HTTP ${status || "未知状态"}`,
        detail: truncateText(responseText) || buildRecaptureHint(saved),
      });
      return;
    }

    if (!json) {
      callback({
        ok: false,
        actionName: action.name,
        title: `保利${action.name}`,
        subtitle: `${action.name}返回不是 JSON`,
        detail: truncateText(responseText) || buildRecaptureHint(saved),
      });
      return;
    }

    if (action.isSignSuccess(json)) {
      callback({
        ok: true,
        actionName: action.name,
        title: `保利${action.name}`,
        subtitle: "执行成功",
        detail: truncateText(`${action.successMessage(json)}${statusResult.summary ? ` | ${statusResult.summary}` : ""}`),
      });
      return;
    }

    if (action.isAlreadySignedResponse(json)) {
      callback({
        ok: true,
        actionName: action.name,
        title: `保利${action.name}`,
        subtitle: "无需重复签到",
        detail: truncateText(statusResult.summary || "今天已经签到。"),
      });
      return;
    }

    callback({
      ok: false,
      actionName: action.name,
      title: `保利${action.name}`,
      subtitle: `${action.name}未成功: ${json.msg || "服务端未返回成功结果"}`,
      detail: buildRecaptureHint(saved),
    });
  });
}

function resolveSender(method) {
  if (typeof $httpClient === "undefined") {
    return null;
  }
  if (method === "post" && typeof $httpClient.post === "function") {
    return $httpClient.post.bind($httpClient);
  }
  if (method === "get" && typeof $httpClient.get === "function") {
    return $httpClient.get.bind($httpClient);
  }
  return null;
}

function validateSavedPayload(action, saved) {
  if (!saved || typeof saved !== "object") {
    return "本地存储为空或已损坏，请重新抓包";
  }
  if (!saved.url || !action.urlPattern.test(saved.url)) {
    return "保存的 URL 不匹配当前接口，请重新抓包";
  }
  if (!saved.token) {
    return "保存的 token 为空，请重新抓包";
  }
  if (!saved.mallId) {
    return "保存的 mallId 为空，请重新抓包";
  }
  return "";
}

function buildRequestHeaders(saved, withBody) {
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${saved.token}`,
    "User-Agent": getHeader(saved.headers || {}, "User-Agent") || DEFAULT_USER_AGENT,
  };
  const referer = getHeader(saved.headers || {}, "Referer");
  if (referer) {
    headers.Referer = referer;
  }
  if (withBody) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

function normalizeHeaders(headers) {
  const skip = {
    host: true,
    connection: true,
    "content-length": true,
    "accept-encoding": true,
    priority: true,
    te: true,
    trailer: true,
  };
  const result = {};
  Object.keys(headers || {}).forEach(function(key) {
    if (!key) {
      return;
    }
    const lowerKey = String(key).toLowerCase();
    if (lowerKey.charAt(0) === ":") {
      return;
    }
    if (lowerKey.indexOf("sec-fetch-") === 0 || lowerKey.indexOf("proxy-") === 0) {
      return;
    }
    if (skip[lowerKey]) {
      return;
    }
    result[key] = String(headers[key]);
  });
  return result;
}

function getHeader(headers, name) {
  const target = String(name || "").toLowerCase();
  const source = headers || {};
  const keys = Object.keys(source);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (String(key).toLowerCase() === target) {
      return source[key];
    }
  }
  return "";
}

function normalizeBody(body) {
  if (typeof body === "string") {
    return body.trim();
  }
  if (typeof body === "undefined" || body === null) {
    return "";
  }
  try {
    return JSON.stringify(body);
  } catch (e) {
    return String(body);
  }
}

function extractMallId(url) {
  const match = String(url || "").match(/\/restful\/mall\/(\d+)\//i);
  return match && match[1] ? match[1] : "";
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

function parseArgument(raw) {
  const result = {};
  if (!raw) {
    return result;
  }
  raw.split("&").forEach(function(pair) {
    if (!pair) {
      return;
    }
    const index = pair.indexOf("=");
    const key = index === -1 ? pair : pair.slice(0, index);
    const value = index === -1 ? "" : pair.slice(index + 1);
    result[safeDecode(key)] = safeDecode(value);
  });
  return result;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
}

function readJSON(key) {
  if (typeof $persistentStore === "undefined") {
    return null;
  }
  const raw = $persistentStore.read(key);
  if (!raw) {
    return null;
  }
  return safeJsonParse(raw);
}

function writeJSON(key, value) {
  if (typeof $persistentStore === "undefined") {
    return false;
  }
  try {
    return $persistentStore.write(JSON.stringify(value), key);
  } catch (e) {
    return false;
  }
}

function safeJsonParse(text) {
  if (!text) {
    return null;
  }
  if (typeof text === "object") {
    return text;
  }
  if (typeof text !== "string") {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function normalizeToken(token) {
  let value = token ? String(token) : "";
  value = value.replace(/[\r\n]/g, "").trim();
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

function safeDecodeJwtPayload(token) {
  const normalized = normalizeToken(token);
  if (!normalized) {
    return null;
  }
  try {
    const parts = normalized.split(".");
    if (parts.length < 2) {
      return null;
    }
    return JSON.parse(base64UrlToUtf8(parts[1]));
  } catch (e) {
    return null;
  }
}

function isTokenExpired(payload) {
  const exp = safeInt(payload && payload.exp, 0);
  return exp > 0 && exp <= Math.floor(Date.now() / 1000);
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

function safeInt(value, defaultValue) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function formatAge(timestamp) {
  const diffMs = Date.now() - Number(timestamp);
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return "未知";
  }
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) {
    return `${diffSec} 秒前`;
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin} 分钟前`;
  }
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) {
    return `${diffHour} 小时前`;
  }
  return `${Math.floor(diffHour / 24)} 天前`;
}

function notify(title, subtitle, message) {
  setRuntimeMessage([title, subtitle, message].filter(Boolean).join(" | "));
  log(runtimeState.lastMessage);
  if (typeof $notification !== "undefined" && typeof $notification.post === "function") {
    $notification.post(title, subtitle || "", message || "");
  }
}

function notifyResult(result) {
  notify(result.title, result.subtitle, truncateText(result.detail));
}

function finish(message, silent, detail) {
  if (!silent) {
    notify(SCRIPT_NAME, message, truncateText(detail || ""));
  }
  done();
}

function done(value) {
  if (runtimeState.completed) {
    return;
  }
  runtimeState.completed = true;
  stopWatchdog();
  releaseLock();
  if (typeof $done === "function") {
    if (typeof value !== "undefined") {
      $done(value);
      return;
    }
    if (typeof $request !== "undefined" || typeof $response !== "undefined") {
      $done({});
      return;
    }
    if (runtimeState.lastMessage) {
      $done({
        body: truncateText(runtimeState.lastMessage, 500),
      });
      return;
    }
    $done({});
  }
}

function extractResponseText(response, data) {
  if (typeof data === "string") {
    return data;
  }
  if (response && typeof response.body === "string") {
    return response.body;
  }
  if (typeof data === "object" && data !== null) {
    try {
      return JSON.stringify(data);
    } catch (e) {
      return String(data);
    }
  }
  return "";
}

function getStatusCode(response) {
  if (!response) {
    return 0;
  }
  const raw = response.status || response.statusCode;
  return raw ? Number(raw) : 0;
}

function buildRecaptureHint(saved) {
  const age = saved && saved.capturedAt ? formatAge(saved.capturedAt) : "未知";
  return truncateText(`当前使用的抓包时间: ${age}。如果 token 失效，请重新打开一次小程序签到页刷新抓包`);
}

function truncateText(text, limit) {
  const content = typeof text === "string" ? text : text ? String(text) : "";
  const max = limit || MAX_NOTIFICATION_DETAIL;
  if (!content || content.length <= max) {
    return content;
  }
  return `${content.slice(0, max - 3)}...`;
}

function maskValue(value, head, tail) {
  const text = value ? String(value) : "";
  if (!text || text.length <= (head || 0) + (tail || 0)) {
    return text;
  }
  return `${text.slice(0, head || 0)}***${text.slice(text.length - (tail || 0))}`;
}

function createRunId() {
  return `run_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function startWatchdog() {
  if (typeof setTimeout !== "function" || runtimeState.watchdogTimer) {
    return;
  }
  runtimeState.watchdogTimer = setTimeout(function() {
    if (runtimeState.completed) {
      return;
    }
    finish("执行超时，已自动结束并释放锁", false, "请稍后重试；如果连续出现，请重新打开小程序刷新抓包。");
  }, WATCHDOG_TIMEOUT_MS);
}

function stopWatchdog() {
  if (!runtimeState.watchdogTimer || typeof clearTimeout !== "function") {
    runtimeState.watchdogTimer = null;
    return;
  }
  clearTimeout(runtimeState.watchdogTimer);
  runtimeState.watchdogTimer = null;
}

function handleFatalError(error) {
  const message = error && error.stack ? error.stack : error && error.message ? error.message : String(error);
  try {
    finish("脚本异常，已自动释放锁", false, truncateText(message));
  } catch (finishError) {
    releaseLock();
    if (typeof $done === "function") {
      $done({
        body: truncateText(`脚本异常: ${message}`, 500),
      });
    }
  }
}

function setRuntimeMessage(message) {
  runtimeState.lastMessage = truncateText(message || "", 500);
}

function log(message) {
  if (typeof console !== "undefined" && typeof console.log === "function") {
    console.log(`[${SCRIPT_NAME}] ${message}`);
  }
}

function acquireLock(actionKey) {
  if (typeof $persistentStore === "undefined") {
    return true;
  }
  const now = Date.now();
  const current = readJSON(LOCK_KEY);
  if (isActiveLock(current, now)) {
    return false;
  }
  if (current) {
    cleanupLock(current);
  }
  const lock = {
    runId: runtimeState.runId,
    action: actionKey,
    expiresAt: now + LOCK_TTL_MS,
    createdAt: now,
  };
  const ok = writeJSON(LOCK_KEY, lock);
  if (!ok) {
    runtimeState.lockOptional = true;
    log("写入运行锁失败，已降级继续执行。");
    return true;
  }
  const saved = readJSON(LOCK_KEY);
  if (!saved || saved.runId !== runtimeState.runId) {
    runtimeState.lockOptional = true;
    log("运行锁校验失败，已降级继续执行。");
    return true;
  }
  runtimeState.lockAcquired = true;
  return true;
}

function releaseLock() {
  if ((!runtimeState.lockAcquired && !runtimeState.lockOptional) || typeof $persistentStore === "undefined") {
    return;
  }
  const current = readJSON(LOCK_KEY);
  if (current && current.runId === runtimeState.runId) {
    try {
      $persistentStore.write("", LOCK_KEY);
    } catch (e) {
      log(`释放运行锁失败: ${String(e)}`);
    }
  }
  runtimeState.lockAcquired = false;
  runtimeState.lockOptional = false;
}

function isActiveLock(lock, now) {
  if (!lock || !lock.runId || lock.runId === runtimeState.runId) {
    return false;
  }
  if (isAbnormalLock(lock, now)) {
    return false;
  }
  const expiresAt = Number(lock.expiresAt || 0);
  return expiresAt > now;
}

function isAbnormalLock(lock, now) {
  if (!lock || typeof lock !== "object" || !lock.runId) {
    return true;
  }
  const createdAt = Number(lock.createdAt || 0);
  const expiresAt = Number(lock.expiresAt || 0);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || createdAt <= 0 || expiresAt <= 0) {
    return true;
  }
  if (createdAt - now > LOCK_CLOCK_SKEW_MS) {
    return true;
  }
  if (now - createdAt >= LOCK_TTL_MS) {
    return true;
  }
  if (expiresAt - createdAt > LOCK_TTL_MS + LOCK_CLOCK_SKEW_MS) {
    return true;
  }
  if (expiresAt <= now) {
    return true;
  }
  return false;
}

function cleanupLock(lock) {
  try {
    $persistentStore.write("", LOCK_KEY);
    log(`已清理异常运行锁: ${formatLockDetail(lock)}`);
  } catch (e) {
    log(`清理异常运行锁失败: ${String(e)}`);
  }
}

function formatLockDetail(lock) {
  if (!lock || typeof lock !== "object") {
    return "锁内容为空或已损坏。";
  }
  const action = lock.action ? `action=${lock.action}` : "action=unknown";
  const created = lock.createdAt ? `创建于 ${formatAge(lock.createdAt)}` : "创建时间未知";
  const expiresAt = Number(lock.expiresAt || 0);
  const expires = expiresAt > Date.now() ? `预计 ${Math.ceil((expiresAt - Date.now()) / 1000)} 秒后过期` : "已过期";
  return `${action} | ${created} | ${expires}`;
}
