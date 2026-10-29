

## User

MQTT 上的信令协议（主题划分、join/here/leave/signal 报文）怎么定？

---

## Assistant

以下是完整的协议设计。目标是：**用 MQTT 的 pub/sub 完全替代 Worker 的房间转发逻辑**，同时尽量保持消息语义和现有代码（`sync.js` 的 `joined/peer-joined/peer-left` 状态机、`SyncService` 的 listener）一一对应，让两端改动最小。

## 1. 连接层

| | 安卓（Paho） | 网页（mqtt.js） |
|---|---|---|
| 地址 | `ssl://broker.emqx.io:8883` | `wss://broker.emqx.io:8084/mqtt` |
| cleanSession | `true` | `true` |
| keepAlive | 30s | 30s（mqtt.js 默认） |
| 自动重连 | Paho `automaticReconnect` | `reconnectPeriod` 指数退避 2s→30s |
| clientId | `etar-a-<peerId>-<随机后缀>` | `etar-w-<peerId>-<随机后缀>` |
| 发布 QoS | 1 | 1 |
| retain | **一律不用** | **一律不用** |

两个要点：
- **clientId 必须带随机后缀**：公共 broker 上同 clientId 会互踢，两端重连时避免误踢自己旧连接的残留。
- **不用 retain**：retain 的 `join`/`peer-left` 会永久挂在公共 broker 上变成陈旧状态；在线状态完全靠下面的握手维护。

## 2. 主题划分

房间标识 `T` 由配对码派生（防裸码出现在主题里被遍历到）：

```
T = sha256("etar-sync-v1:" + 配对码) 的前 16 个 hex 字符
```

每个"端角色"一个主题，**各自只往自己的主题发、只订对方的主题**，天然替代了 Worker 的 `to` 寻址：

```
etar/cal/<T>/android   ← 安卓发布，网页订阅
etar/cal/<T>/web       ← 网页发布，安卓订阅
```

这样不存在"发给谁"的路由问题，也不需要房间满员的服务端检查（见 §6）。

## 3. 报文格式

所有消息统一 JSON，带协议版本号 `v:1`（以后协议演进时老客户端可识别并忽略新消息）：

### `join` — 在线宣告（连上/重连后立即发）

```json
{"v":1,"type":"join","peerId":"android-371b5847","ts":1761650000000}
```

### `here` — 对 `join` 的应答（只应答 join，本身不触发应答）

```json
{"v":1,"type":"here","peerId":"android-371b5847"}
```

### `signal` — SDP/ICE 中继（offer/answer/ice，内容格式与现在完全一致）

```json
{"v":1,"type":"signal","from":"web-a1b2c3d4",
 "data":{"kind":"offer","sdp":"..."}}
```

### `leave` — 优雅下线（主动断开前发，LWT 兜底异常断线）

```json
{"v":1,"type":"leave","peerId":"web-a1b2c3d4"}
```

LWT（Last Will）在连接建立时注册，broker 在异常断线时代发：

```json
{"v":1,"type":"peer-left","peerId":"web-a1b2c3d4"}
```

`leave` 和 `peer-left` 语义对客户端等价，统一按"对端离开"处理即可（`ts` 字段用于客户端丢弃过期消息：收到 `signal` 时若 `ts` 比本地记录的对端离开时刻还早，忽略）。

## 4. 握手与防环

规则只有两条，这是整个协议防死循环的关键：

1. **收到 `join` → 必答一个 `here`**（无论是否答过）
2. **`here` 不触发任何回复**

推演一下双向连接：A 发 join → B 收到答 here → A 收到 here 不再回复 → 结束。任意一方重连重发 join → 对方再答一次 here → 结束。**最多两次交互，永不循环**。之所以敢"每 join 必答"，是因为 join 只在连接建立时发，不是定时器。

完整时序（首次配对）：

```
安卓                                网页
订阅 T/web                          
发布 join ──────────────────────►   (未订阅 T/android，丢失，无妨)
                                    订阅 T/android
                                    发布 join ──────────►
收到 web 的 join
发布 here ─────────────────────►    
                                    收到 android 的 join/here
                                    ← 此刻知道对端在场
                                    createOffer，发 signal(offer) ─►
收到 offer，setRemote，createAnswer
发 signal(answer) ─────────────►    
                                    setRemote(answer)
双方持续交换 ice ─────────────►◄──
DataChannel "sync" open → 配对完成
```

## 5. 谁发起 offer（与现有代码对齐）

保持现有约定：**网页永远是 offerer，安卓永远是 answerer**（`RtcPeer.kt` 就是按这个写的，不动）。

- **网页**：收到安卓的 `join` 或 `here`，且当前没有到该 peerId 的活连接 → `startRtc()` 发 offer。去重规则：`rtc` 已 OPEN 且 remotePeerId 相同 → 跳过；`rtc` 存在但 failed/closed → 先 teardown 再重建。
- **安卓**：收到对端 `join`/`here` 只记录 `webPeerId`，然后**等 offer**，不主动建连。收到 `signal` 时若 `rtc == null` 或 channel 已关闭 → 新建 `RtcPeer` 再 `handleSignal`（这正好修掉之前"网页重发 offer 时安卓复用死掉的 PeerConnection 导致 setRemoteDescription 失败"的隐患）。

## 6. 1 对 1 约束（替代 Worker 的 "room full"）

公共 broker 没有服务端做人数控制，改为**客户端自律**（和现有 `onSignal` 的 `known` 过滤逻辑一致并加强）：

- 安卓：只认**一个** web peer —— 已配对时只接受持久化的 `webPeerId`；配对中接受第一个 `web-*` 并持久化，之后对其他 `web-*` 的 join/here/signal 一律忽略。
- 网页：同理只认一个 `android-*`。
- 换码重配对：房间 `T` 变了，旧房间的残留连接自然隔离。

## 7. 安全性说明（如实评估）

- **配对码即房间密钥**：6 位码 → hash 后做主题，遍历者无法从主题反推码，但理论上可 wildcard 订阅 `etar/cal/#` 看到所有房间的流量。缓解：主题用 hash 不裸奔码；泄露面仅限 **SDP/ICE**（含端侧 IP，浏览器侧 host 候选走 mDNS 掩码），**日程数据从不经过 MQTT**，它走 P2P DataChannel（DTLS-SRTP 加密）。这与原 Worker 方案的暴露面相同，没有变差。
  - ⚠️ 已过时：v2 起日程数据也经 MQTT 直连传输，但改为 **AES-256-GCM 加密**，见 §9；泄露面仍是密文。
- 想再加一层可以后续把 `data` 用码派生的密钥对称加密，v1 不做，保持简单。（§9 已实现）

## 8. 与现有代码的映射（改动范围）

| 现有事件 | 新来源 | 影响文件 |
|---|---|---|
| `joined{peers}` | 收到对端 `join`（presence） | `signal.js`、`SignalingClient.kt` |
| `peer-joined` | 收到对端 `here` | 同上 |
| `peer-left` / `leave` | 收到 `leave` 或 LWT `peer-left` | 同上 |
| `signal{to,...}` | 发布到对端主题（去掉 `to`，加 `from`） | `signal.js`、`SignalingClient.kt` |
| `error{room full}` | 取消（客户端自律，见 §6） | — |

具体改动文件：
- **网页** `E:\code\Etar-Web`：重写 `src/lib/signal.js`（内部换 mqtt.js，**对外 `on('status'|'message')`/`signal()`/`connect()`/`close()` 接口不变**），`sync.js`/`store.js` 几乎不动；顺手把网页自己的 peerId 也持久化到 localStorage（现在每次刷新都换新 peerId，会让安卓的配对校验抖动）。
- **安卓** `Etar-Calendar-master`：重写 `SignalingClient.kt`（Paho，对外 `Listener` 接口不变），`SyncService.kt` 只加"offer 到达时重建已死 RtcPeer"的健壮性处理，`SyncPrefs.SIGNAL_URL` 改为 broker 地址；`DohDns.kt`、`signaling/` 目录删除，okhttp 依赖移除。
- **部署**：`signaling/` 整个目录作废删除，Cloudflare 上的 worker 可以直接删掉。

协议就这样定。如果没异议，我按这个方案开始改两端代码，改完用你连着的手机 + Node 模拟网页端做一轮信令互通实测（join → here → offer → answer 全链路），再给你可部署的网页构建。

---

## 9. 数据通道 v2：MQTT 直连优先，60s 超时升级 WebRTC（2026-10-29）

背景：联调发现 WebRTC 路径在对称 NAT / 无入站场景极易失败，而 MQTT（出站长连接）几乎总能通。
新策略把"能同步"与"低延迟 P2P"解耦——**先保证数据能走，再追求走得好**。

### 9.1 传输策略

1. **第一优先：MQTT 数据直连**。信令连上、对端在场后，日程数据（fetch_day/add/update/delete/ping ↔ day/result/pong/push_change）
   直接经现有两条角色主题以 `type="data"` 加密信封收发，**不等 WebRTC**。
2. **60s 升级**：对端在场但 60s 内没有任何数据回包（`RTC_ESCALATE_MS`）→ 升级尝试 WebRTC DataChannel。
   ICE 自身按候选类型顺序降级：host/IPv6 直连 → STUN srflx 打洞 → TURN relay 中继（§5 不变）。
3. **回落**：DataChannel 打开后数据切到 P2P；RTC 断线时数据自动回落 MQTT，同步不断线。
4. 两端均如此（升级动作只由网页端发起，安卓只应答）。

### 9.2 `data` 信封

```json
{"v":1,"type":"data","from":"web-a1b2c3d4","ts":1793250000000,"d":"<base64>"}
```

`d` = `base64( iv(12B) || AES-256-GCM(明文JSON) || tag(16B) )`：

- **key = SHA-256("etar-sync-data-v1:" + 配对码)**，两端各自派生（网页 `crypto.js`，安卓 `DataCrypto.kt`），密钥不过网
- IV 每条消息随机 12B 前置；GCM tag 固定 128bit
- base64 标准字母表带 padding（安卓侧 `Base64.NO_WRAP`）
- 明文即 §9.1 列出的数据协议消息（含 `id`/`day`/`events` 等字段，与 DataChannel 上完全一致）

### 9.3 可靠性

- **幂等**：QoS1 在重连窗口可能重复投递。请求 id = `<sid>-<seq>`（sid 每次页面加载随机）；
  安卓按 id 去重（LRU 128 条，`SyncService.replyCache`），重复请求直接重发缓存的响应。
- **响应与请求通道无关**：网页按 id 配对响应，不看它从 MQTT 还是 DataChannel 回来；
  安卓发送出口统一 `sendToWeb()`（RTC 优先，回落 MQTT）。
- **兼容**：旧版对端收到 `type="data"` 走"未知类型忽略"分支 → 新网页 60s 后升级走旧 WebRTC 路径，双向兼容、无需同步发版。

### 9.4 状态与 UI

- 网页顶栏：`已连通·MQTT` / `已连通·P2P`（`sync.on('status', (s, transport))`）
- 安卓通知：`网页已连接（MQTT 数据通道）` / `网页已连接（P2P）`
- 控制台/配对页日志标注每条数据的来源通道 `[mqtt]` / `[rtc]`
