# Etar 日历网页端

Vue 3 + Vite 实现的 Etar 日历网页端，复刻 App 的**天视图**：

- 时间网格 + 12 单位宽度任务块（1 单位 = 2.5 分钟），配色与 App 一致
  （高优先级混紫、弹性任务混白）
- 底部常驻创建栏（优先级 + 输入框 + 2/5/10/15/20/25/补满按钮），
  目标时段是当天第一个任务时默认选中「补满」
- 右键任务 = 手机端长按菜单（编辑/移动/弹性/优先级/调整时长/补满/删除），双击 = 删除
- 单击任务选中，再单击空白时段把任务移动过去；单击空白时段（未选中时）设为创建目标
- 顶部 ← → 切换昨天/明天，右上角显示连接状态（连接中/已连通/离线）
- 网页**不持久保存日程**：刷新即重新拉取当前显示日，收到 push_change 自动刷新
- 配对：首次打开输入 6 位配对码连接手机；配对成功后 localStorage 记住手机
  peerId，下次打开自动重连。信令地址内置（`src/lib/store.js` 的 `DEFAULT_SIGNAL_URL`），
  弹窗里无需配置

## 底层

- 数据通道：WebRTC DataChannel（纯数据，无音视频）。ICE 按候选类型自动优先：
  内网/IPv6 直连 → STUN 打洞（UDP）→ TURN 中继兜底（UDP 80 / TCP 443 / TLS 443，
  Open Relay 公共服务，凭据在 `src/lib/rtc.js`，可换自建 coturn）。绝大多数情况仍走 P2P
- 信令：MQTT，公共 broker `broker.emqx.io`（网页 wss 8084 / 安卓 ssl 8883），
  只交换 SDP/ICE，主题划分与 join/here/leave/signal 报文见 `MQTT信令协议.md`；
  原 `../signaling/` Worker 已作废
- 依赖 `mqtt`（mqtt.js），首次拉代码需 `npm install`

## 开发/构建

```bash
npm install
npm run dev      # 本地开发 http://localhost:5173
npm run build    # 产物在 dist/，任意静态服务器托管即可
```

注意：浏览器要求安全上下文（https 或 localhost）才能使用 WebRTC。

## 协议

见 `src/lib/sync.js` 头部注释；日程数据以安卓本地库为唯一数据源。
