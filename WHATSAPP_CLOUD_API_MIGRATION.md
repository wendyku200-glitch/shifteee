# 遷去官方 WhatsApp Business Platform (Cloud API) — 路線圖

## 點解要遷
而家程式用 **`whatsapp-web.js`（非官方、模擬 WhatsApp Web 自動化）**，違反 WhatsApp 條款，
任何自動化都有機會令號碼被暫時限制甚至封號。要正式收費上線，應該遷去
**官方 WhatsApp Business Platform（Cloud API）** —— 呢個係唯一官方允許嘅自動化渠道。

> 注意：你嘅「分級限制」（員工數上限等）係純後台邏輯，同用邊個訊息通道無關，
> 遷移後照搬即可，唔受影響。

## 現況觸點（改咗呢度就得）
- `instances`（`index.js` 內嘅 multi-instance 管理器）＋ `LocalAuth`／`.wwebjs_auth/` `—` 要移除。
- `client.sendMessage(...)` — 出站，改為 Cloud API `POST /{phone_number_id}/messages`。
- `client.on('message', ...)` — 入站，改為 Cloud API webhook。
- `/webhooks/whatsapp`（已有！）— 可以直接重用做官方 webhook 驗證＋接收。
- `attachClientHandlers()` 內嘅 `findOrCreateUser`／`handleConversation` — 保持不動（通道無關）。

## 第 0 步：Meta Business 設定
1. 開 **Meta Business Suite / Business Manager**。
2. 完成 **Business Verification（商業驗證）**—— 需公司商業登記。
3. 開 **WhatsApp Manager / WhatsApp Business Platform**。
4. 揀號碼：
   - 新號碼：直接由 Platform 開（會寄 SMS/電話驗證）。
   - 現有號碼：做 **Migration / Coexistence**，將現有 WhatsApp 號碼遷去 API。

## 第 1 步：抽離「訊息介面」（provider adapter）
將 bot 邏輯同 whatsapp-web.js 解耦，方便日後切換／多供應商：

- 定義一組介面：
  - `sendText(to, text)`
  - `onInbound(handler)`
- 而家個 `instances` / `attachClientHandlers` 改成一個 `MessagingProvider` adapter；
  短期繼續用 whatsapp-web.js，長期換 Cloud API，唔使改上層 bot 邏輯。

## 第 2 步：接入 Cloud API（揀一條路）
- **方法 A（建議）：經 BSP** — Twilio / 360dialog / Vonage / MessageBird / Gupshup，
  佢哋包 webhook、號碼、計費同支援，開發最快。
- **方法 B：直接用 Cloud API** — 喺 Meta Graph API 自理，
  System User + 長期 token，成本平但開發同維護多啲。

## 第 3 步：Webhook 驗證 + 接收（重用 `/webhooks/whatsapp`）
1. **GET 驗證**：Meta 會 send `hub.mode=subscribe`、`hub.verify_token`、`hub.challenge`，
   你要回傳 `hub.challenge`（用 `WEBHOOK_VERIFY_TOKEN` 比對）。
2. **POST 接收**：處理 `entry[].changes[].value` 內嘅
   `messages`（`from`、`text.body`、`timestamp`）同 `statuses`（sent/delivered/read）。
3. 將 `from`（例如 `85291234567`）map 返你現有 `cleanPhone`（而家係剝走 `@c.us`）。

## 第 4 步：出站訊息＋Template
- **24 小時免費視窗內**：可自由回覆（你嘅批准／拒絕通知多數喺呢個視窗內，直接回覆即可）。
- **視窗外**：要用 **Template（已審批訊息範本）**，例如
  「你嘅請假申請 #102 已獲批准」呢類通知，預先喺 WhatsApp Manager 送審。

## 第 5 步：計費
Cloud API 由 2025 年起係**按訊息收費（per-message）**，分
Utility／Service／Marketing／Authentication 類別，不同類別不同價（香港約每則 HK$0.0x–0.2 視乎類別）。
你嘅審批／回覆多數屬 Utility/Service 類，成本極低。

## 第 6 步：號碼↔公司對應（多租戶）
- 而家係「一間公司 = 一個 whatsapp-web.js session（`.wwebjs_auth/session-company-N`）」。
- Cloud API 下改為「一間公司 = 一個 `phone_number_id`」，
  喺 `Company` 加欄位 `waba_phone_number_id`／`waba_access_token` 做對應（可先存喺現有 `whatsapp_config` JSON）。

## 第 7 步：測試清單
- [ ] 收發文字訊息
- [ ] 新員工 welcome 訊息
- [ ] 請假／換班流程（入站→處理→出站）
- [ ] 批准／拒絕通知
- [ ] 員工數上限（分級限制）照常生效
- [ ] Template（視窗外通知）
- [ ] 失敗重試／日誌（MessageLog）

## 時間／成本（粗略）
- Meta Business Verification：約 1–2 週（視乎文件）。
- BSP 開號＋SDK 接駁：約 1–2 日。
- 抽離 adapter＋webhook 重構：約 2–4 日開發。
- 計費：按訊息量，遠低於而家嘅風險成本（封號 = 客戶斷線）。

## 備註
- 已完成嘅「分級限制」同定價引擎唔使改，遷移係**替換傳輸層**，唔係改業務邏輯。
- 遷移期間可 **Coexistence**：官方 API 同而家 whatsapp-web.js 並行，逐步切換，減低風險。