# 第 0 步 — Meta Business / WhatsApp Cloud API 開號清單

## 目標
由非官方 `whatsapp-web.js` 遷去官方 **WhatsApp Business Platform（Cloud API）**，
令自動化係官方允許嘅，唔會被 ban，可以正式收費上線。

## A. 開 Meta Business 帳戶
1. 去 https://business.facebook.com 開 **Business Manager / Meta Business Suite**。
2. 用公司名（同商業登記一致）註冊。

## B. 商業驗證（Business Verification）
1. Business Settings → **Security Center** → Begin Business Verification。
2. 提交：商業登記證（BR）、銀行月結單／住址證明、聯絡人。
3. 通常 1–2 星期完成。**冇驗證會限制訊息數量同號碼上線。**

## C. 開 WhatsApp 應用程式 + 攞 token
1. 去 https://developers.facebook.com → 建立 **App**（類型：Business）。
2. 喺 App 加 **WhatsApp** 產品。
3. 攞 **System User** token（永久 token）：
   - Business Settings → System Users → 建立 System User（Admin）。
   - 指派 WhatsApp 產品 + 權限。
   - Generate Token → 揀 `whatsapp_business_messaging` + `whatsapp_business_management`。
   - 呢個就係 `META_WHATSAPP_TOKEN`。

## D. 攞號碼 + phone_number_id
1. WhatsApp Manager → 加號碼（新號碼，或做 Migration 將現有號碼遷去 API）。
2. 驗證號碼（SMS／電話）。
3. 記低 **Phone number ID**（`META_PHONE_NUMBER_ID`）+ **WhatsApp Business Account ID**。

## E. 設定 Webhook
1. App Dashboard → WhatsApp → Configuration → Webhook。
2. Callback URL：`https://shifteee.com/webhooks/meta`
3. Verify token：自訂一個隨機字串（`META_VERIFY_TOKEN`），Meta 會用 GET 驗證，我哋個
   `/webhooks/meta` 已實作 handshake（先設定好 env，再按「Verify and Save」）。
4. 訂閱欄位：`messages`（及需要時 `message_template_status_updates`）。

## F. 環境變數（`.env`）
```env
MESSAGING_PROVIDER=cloud-api     # 遷移後先轉；未轉之前留 whatsapp-web
META_WHATSAPP_TOKEN=EAAG...
META_VERIFY_TOKEN=自己set
META_PHONE_NUMBER_ID=1234567890
META_GRAPH_VERSION=v21.0
```

## G. 測試
1. 用 Meta 提供嘅 **Test number** 傳訊，睇 `/webhooks/meta` 有冇收到 inbound。
2. 用 `CloudApiProvider.sendText(to, text)` 回覆。
3. 24 小時視窗外通知要用已審批 Template。

## 注意
- 由 2025 年起 Cloud API 係 **per-message 收費**，分 utility／service／marketing／authentication 類別。
- 你嘅審批／回覆多數屬 utility/service 類，成本低。