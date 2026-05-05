/*
 * Baoli check-in script for QingLong.
 *
 * Required env:
 * - BAOLI_TOKEN: Authorization token, with or without "Bearer ".
 * - BAOLI_MALL_ID: mall id from the captured URL, for example /restful/mall/12345/.
 *
 * Optional env:
 * - BAOLI_HEADERS: JSON object copied from captured request headers.
 * - BAOLI_LOCK_TTL_MS: lock ttl, default 120000.
 *
 * QingLong cron example:
 * 6 7 * * * baoli_ql_sign.js
 */

const fs = require("fs");
const path = require("path");

const BASE_URL = "https://a.china-smartech.com";
const SCRIPT_NAME = "保利签到";
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_LOCK_TTL_MS = 2 * 60 * 1000;
const LOCK_FILE = path.join(process.env.QL_TMP_DIR || process.env.TMPDIR || "/tmp", "baoli_ql_sign.lock");
const DEFAULT_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.69(0x18004531) NetType/4G Language/zh_CN";

const runtimeState = {
  runId: `ql_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
  lockAcquired: false,
};

main().catch(async function(error) {
  const message = error && error.stack ? error.stack : String(error);
  await notify("执行异常", truncateText(message));
  console.log(`[${SCRIPT_NAME}] ${message}`);
  process.exitCode = 1;
}).finally(function() {
  releaseLock();
});

process.on("SIGINT", function() {
  releaseLock();
  process.exit(130);
});

process.on("SIGTERM", function() {
  releaseLock();
  process.exit(143);
});

async function main() {
  if (!acquireLock()) {
    const lock = readLock();
    console.log(`[${SCRIPT_NAME}] 检测到脚本已在运行，${formatLockDetail(lock)}，本次跳过。`);
    return;
  }

  const saved = readConfig();
  validateConfig(saved);

  const tokenPayload = safeDecodeJwtPayload(saved.token);
  if (tokenPayload && isTokenExpired(tokenPayload)) {
    throw new Error("token 已过期，请重新抓包并更新 BAOLI_TOKEN。");
  }

  const statusResult = await queryStatus(saved);
  if (statusResult.alreadySigned) {
    await notify("无需重复签到", statusResult.summary);
    return;
  }

  const signResult = await signNow(saved, statusResult);
  await notify(signResult.subtitle, signResult.detail);
}

function readConfig() {
  const headers = safeJsonParse(process.env.BAOLI_HEADERS || "{}") || {};
  return {
    token: normalizeToken(process.env.BAOLI_TOKEN || process.env.baoliToken || ""),
    mallId: String(process.env.BAOLI_MALL_ID || process.env.baoliMallId || "").trim(),
    headers,
  };
}

function validateConfig(saved) {
  if (!saved.token) {
    throw new Error("缺少 BAOLI_TOKEN。请从 Loon 抓包或小程序请求中复制 Authorization。");
  }
  if (!saved.mallId) {
    throw new Error("缺少 BAOLI_MALL_ID。请从请求 URL /restful/mall/{mallId}/ 中提取。");
  }
}

async function queryStatus(saved) {
  const response = await requestJson(BASE_URL + `/restful/mall/${saved.mallId}/checkInForm?with_records=1`, {
    method: "GET",
    headers: buildRequestHeaders(saved, false),
  });

  console.log(`[${SCRIPT_NAME}] 状态接口返回: HTTP ${response.status}`);
  if (response.status !== 200 || !response.json || safeInt(response.json.code, 0) !== 200) {
    return {
      alreadySigned: false,
      warning: `状态查询未成功: HTTP ${response.status}`,
      summary: truncateText(response.text),
    };
  }

  return {
    alreadySigned: isAlreadySigned(response.json),
    warning: "",
    summary: statusMessage(response.json),
  };
}

async function signNow(saved, statusResult) {
  const response = await requestJson(BASE_URL + `/restful/mall/${saved.mallId}/checkInRecord`, {
    method: "POST",
    headers: buildRequestHeaders(saved, true),
    body: JSON.stringify({
      latitude: 0,
      longitude: 0,
    }),
  });

  console.log(`[${SCRIPT_NAME}] 签到接口返回: HTTP ${response.status}`);
  if (response.status !== 200) {
    throw new Error(`签到请求返回 HTTP ${response.status}: ${truncateText(response.text)}`);
  }
  if (!response.json) {
    throw new Error(`签到返回不是 JSON: ${truncateText(response.text)}`);
  }
  if (response.json.code === 200) {
    const data = response.json.data || {};
    return {
      subtitle: "执行成功",
      detail: truncateText(`签到成功，获得 ${safeInt(data.point, 0)} 积分，累计 ${safeInt(data.total_point, 0)} 积分。${statusResult.summary ? ` | ${statusResult.summary}` : ""}`),
    };
  }
  if (typeof response.json.msg === "string" && response.json.msg.indexOf("已签到") !== -1) {
    return {
      subtitle: "无需重复签到",
      detail: truncateText(statusResult.summary || "今天已经签到。"),
    };
  }
  throw new Error(`签到未成功: ${response.json.msg || "服务端未返回成功结果"}`);
}

async function requestJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(function() {
    controller.abort();
  }, DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, Object.assign({}, options, {
      signal: controller.signal,
    }));
    const text = await response.text();
    return {
      status: response.status,
      text,
      json: safeJsonParse(text),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildRequestHeaders(saved, withBody) {
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${saved.token}`,
    "User-Agent": getHeader(saved.headers, "User-Agent") || DEFAULT_USER_AGENT,
  };
  const referer = getHeader(saved.headers, "Referer");
  if (referer) {
    headers.Referer = referer;
  }
  if (withBody) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

function acquireLock() {
  const now = Date.now();
  const current = readLock();
  if (current && current.runId && Number(current.expiresAt || 0) > now && current.runId !== runtimeState.runId) {
    return false;
  }
  if (current) {
    removeLock();
  }

  const ttl = safeInt(process.env.BAOLI_LOCK_TTL_MS, DEFAULT_LOCK_TTL_MS);
  const lock = {
    runId: runtimeState.runId,
    pid: process.pid,
    createdAt: now,
    expiresAt: now + Math.max(ttl, 30000),
  };
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify(lock), {
      flag: "wx",
    });
    runtimeState.lockAcquired = true;
    return true;
  } catch (error) {
    const after = readLock();
    if (after && after.runId && Number(after.expiresAt || 0) > Date.now() && after.runId !== runtimeState.runId) {
      return false;
    }
    fs.writeFileSync(LOCK_FILE, JSON.stringify(lock));
    runtimeState.lockAcquired = true;
    return true;
  }
}

function releaseLock() {
  if (!runtimeState.lockAcquired) {
    return;
  }
  const current = readLock();
  if (current && current.runId === runtimeState.runId) {
    removeLock();
  }
  runtimeState.lockAcquired = false;
}

function readLock() {
  try {
    return safeJsonParse(fs.readFileSync(LOCK_FILE, "utf8"));
  } catch (error) {
    return null;
  }
}

function removeLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      console.log(`[${SCRIPT_NAME}] 清理锁文件失败: ${error.message || String(error)}`);
    }
  }
}

function isAlreadySigned(json) {
  const today = getTodayEntry(json && json.data);
  return Boolean(today && safeInt(today.point_total, 0) > 0);
}

function statusMessage(json) {
  const data = json && json.data;
  const today = getTodayEntry(data);
  if (!today) {
    return "未找到今日签到记录。";
  }
  const stat = data && data.stat ? data.stat : {};
  const checked = safeInt(today.point_total, 0) > 0;
  return `${today.day || "今天"} ${checked ? "已签到" : "未签到"}，今日积分 ${safeInt(today.point_total, 0)}，连续签到 ${safeInt(stat.continuous_count, 0)} 天。`;
}

function getTodayEntry(formData) {
  if (!formData || !Array.isArray(formData.days)) {
    return null;
  }
  return formData.days.find(function(item) {
    return item && safeInt(item.today, 0) === 1;
  }) || null;
}

async function notify(subtitle, detail) {
  const content = truncateText(detail || "");
  console.log(`[${SCRIPT_NAME}] ${subtitle}${content ? ` | ${content}` : ""}`);
  try {
    const sendNotify = require("./sendNotify");
    if (sendNotify && typeof sendNotify.sendNotify === "function") {
      await sendNotify.sendNotify(SCRIPT_NAME, `${subtitle}\n${content}`);
    }
  } catch (error) {
    // QingLong injects sendNotify in many repos; console output is enough when it is absent.
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

function getHeader(headers, name) {
  const target = String(name || "").toLowerCase();
  const keys = Object.keys(headers || {});
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (String(key).toLowerCase() === target) {
      return headers[key];
    }
  }
  return "";
}

function safeJsonParse(text) {
  if (!text) {
    return null;
  }
  if (typeof text === "object") {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
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
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch (error) {
    return null;
  }
}

function isTokenExpired(payload) {
  const exp = safeInt(payload && payload.exp, 0);
  return exp > 0 && exp <= Math.floor(Date.now() / 1000);
}

function safeInt(value, defaultValue) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function truncateText(text, limit) {
  const content = typeof text === "string" ? text : text ? String(text) : "";
  const max = limit || 240;
  if (!content || content.length <= max) {
    return content;
  }
  return `${content.slice(0, max - 3)}...`;
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

function formatLockDetail(lock) {
  if (!lock) {
    return "锁文件存在但无法读取";
  }
  const created = lock.createdAt ? `创建于 ${formatAge(lock.createdAt)}` : "创建时间未知";
  const expiresAt = Number(lock.expiresAt || 0);
  const expires = expiresAt > Date.now() ? `预计 ${Math.ceil((expiresAt - Date.now()) / 1000)} 秒后过期` : "已过期";
  return `${created}，${expires}`;
}
