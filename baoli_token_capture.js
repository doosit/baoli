"use strict";

/*
Loon http-request capture script.

Recommended match:
^https:\/\/a\.china-smartech\.com\/restful\/

Recommended argument examples:
storeKey=baoli_token&mallStoreKey=baoli_mall_id&notify=1
notify=0
*/

const CONFIG = {
  defaultStoreKey: "baoli_token",
  defaultMallStoreKey: "baoli_mall_id",
  defaultUpdatedAtKey: "baoli_token_updated_at",
  defaultNotify: true,
  notificationOpenUrl: "loon://",
  targetPattern: /^https:\/\/a\.china-smartech\.com\/restful\//i,
  targetMallPattern: /\/restful\/mall\/(\d+)\//i,
};

function log(message) {
  if (typeof console !== "undefined" && console && typeof console.log === "function") {
    console.log("[baoli-capture] " + message);
  }
  return message;
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
  if (!hasPersistentStore() || !key || value === undefined || value === null || typeof $persistentStore.write !== "function") {
    return false;
  }
  try {
    return $persistentStore.write(String(value), String(key));
  } catch (_) {
    return false;
  }
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== "object") {
    return "";
  }
  const target = String(name || "").toLowerCase();
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (String(key).toLowerCase() === target) {
      return headers[key];
    }
  }
  return "";
}

function extractMallId(url) {
  const match = String(url || "").match(CONFIG.targetMallPattern);
  return match && match[1] ? match[1] : "";
}

function postNotification(enabled, title, subtitle, content) {
  if (!enabled || typeof $notification === "undefined" || !$notification || typeof $notification.post !== "function") {
    return;
  }
  $notification.post(title, subtitle, content, CONFIG.notificationOpenUrl);
}

function done() {
  if (typeof $done === "function") {
    $done({});
  }
}

function main() {
  const args = parseArgument(typeof $argument === "string" ? $argument : "");
  const storeKey = String(args.storeKey || args.store_key || CONFIG.defaultStoreKey || "").trim();
  const mallStoreKey = String(args.mallStoreKey || args.mall_store_key || CONFIG.defaultMallStoreKey || "").trim();
  const updatedAtKey = String(args.updatedAtKey || args.updated_at_key || CONFIG.defaultUpdatedAtKey || "").trim();
  const notify = parseBoolean(args.notify, CONFIG.defaultNotify);

  if (typeof $request === "undefined" || !$request) {
    log("未检测到 $request，跳过。");
    done();
    return;
  }

  const url = String($request.url || "");
  if (!CONFIG.targetPattern.test(url)) {
    done();
    return;
  }

  const headers = $request.headers || {};
  const token = normalizeToken(getHeader(headers, "Authorization"));
  if (!token) {
    log("目标请求没有 Authorization，跳过。");
    done();
    return;
  }

  const previousToken = readStore(storeKey);
  const mallId = extractMallId(url) || readStore(mallStoreKey);
  const changed = token !== previousToken;

  writeStore(storeKey, token);
  if (mallId) {
    writeStore(mallStoreKey, mallId);
  }
  writeStore(updatedAtKey, new Date().toISOString());

  if (changed) {
    const message = "已抓取并保存最新 token" + (mallId ? "，mallId=" + mallId : "") + "。";
    log(message);
    postNotification(notify, "保利 Token 抓取", "已更新", message);
  } else {
    log("token 未变化，已刷新最后抓取时间。");
  }

  done();
}

main();
