# Loon 使用说明

这套方案现在拆成两个脚本：

1. [baoli_token_capture.js](/Users/satan/Documents/baoli/baoli_token_capture.js)
   作用：拦截小程序请求，自动抓取并保存最新 `token`
2. [baoli_checkin.js](/Users/satan/Documents/baoli/baoli_checkin.js)
   作用：读取已保存的 `token`，执行定时签到

## 先说明边界

这里的“自动抓 token”是指：

- 只要你的小程序请求经过 Loon
- 并且命中了 `a.china-smartech.com/restful/...`
- Loon 就会自动把请求头里的 `Authorization` 抓出来并保存

这不是“模拟登录拿 token”。如果你希望完全不打开小程序也能自己刷新 token，那还需要单独分析登录链路。

## 第一步：启用 MITM

要让 Loon 能抓到请求头，`a.china-smartech.com` 必须走 MITM。

至少把这个域名加入 MITM：

```text
a.china-smartech.com
```

## 第二步：配置抓 token 脚本

推荐加一条 `http-request`：

```ini
http-request ^https:\/\/a\.china-smartech\.com\/restful\/ script-path=baoli_token_capture.js, requires-body=false, timeout=30, tag=保利抓Token, argument="notify=1", enable=true
```

这条规则的作用：

- 监听经过 Loon 的相关请求
- 自动提取 `Authorization`
- 自动保存到 `$persistentStore`
- 如果 token 变了，会发一条通知

默认保存的 key：

- `baoli_token`
- `baoli_mall_id`
- `baoli_token_updated_at`

## 第三步：手动打开一次小程序签到页

首次使用时，打开一次微信小程序签到页或任何会访问这个域名的页面，让抓 token 脚本先把 token 存下来。

抓取成功后，Loon 会通知：

```text
保利 Token 抓取
已更新
已抓取并保存最新 token，mallId=3583。
```

## 第四步：配置定时签到脚本

然后加一条 `cron`，设置为每天早上 `07:06`：

```ini
cron "6 7 * * *" script-path=baoli_checkin.js, tag=保利签到, timeout=60, argument="retry=3&timeout=20000&notify=1", enable=true
```

这条规则会：

- 优先读取 `$persistentStore` 里的 `baoli_token`
- 自动解析 `mallId`
- 查询今天是否已签到
- 未签到时自动发起签到

## 常用参数

两个脚本都支持 `argument`，常用值如下。

签到脚本 [baoli_checkin.js](/Users/satan/Documents/baoli/baoli_checkin.js)：

- `retry=3`
- `timeout=20000`
- `notify=1`
- `checkOnly=1`
- `node=你的策略组或节点名称`
- `storeKey=baoli_token`
- `mallStoreKey=baoli_mall_id`
- `token=你的token`
- `save=1`

抓取脚本 [baoli_token_capture.js](/Users/satan/Documents/baoli/baoli_token_capture.js)：

- `notify=1`
- `storeKey=baoli_token`
- `mallStoreKey=baoli_mall_id`

## 推荐配置

抓 token：

```ini
http-request ^https:\/\/a\.china-smartech\.com\/restful\/ script-path=baoli_token_capture.js, requires-body=false, timeout=30, tag=保利抓Token, argument="notify=1", enable=true
```

定时签到：

```ini
cron "6 7 * * *" script-path=baoli_checkin.js, tag=保利签到, timeout=60, argument="retry=3&timeout=20000&notify=1", enable=true
```

## 常见输出

抓 token 成功：

```text
保利 Token 抓取
已更新
已抓取并保存最新 token，mallId=3583。
```

签到成功：

```text
签到成功，获得 1 积分，累计 123 积分。
```

今天已签到：

```text
2026-03-15 已签到，今日积分 1，连续签到 1 天。
今天已经签到，无需重复签到。
```

未抓到 token：

```text
缺少 token。请先启用抓 token 脚本并打开一次小程序签到页，或手动通过 argument 传 token=...
```

token 失效：

```text
签到失败：token 可能已失效，请重新抓包替换 token。
```

## 故障排查

如果签到突然失败，优先检查：

1. `a.china-smartech.com` 是否已经加入 MITM
2. 抓 token 脚本是否已经启用
3. 最近有没有打开过一次小程序，让 Loon 重新抓到最新 token
4. 当前网络或策略是否正常，必要时在签到脚本里指定 `node=策略组名`
