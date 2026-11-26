// ============================================================
// messaging.js — provider-agnostic messaging abstraction
// (migration step 1: 抽離訊息介面)
//
// 兩個 provider 實作同一個介面，令上層 bot 邏輯唔使理底層係：
//   - whatsapp-web.js（非官方，而家用緊），定係
//   - WhatsApp Business Platform Cloud API（官方）。
//
// 標準化入站訊息（inbound）形狀：
//   { id, from, body, timestamp, raw }
//   - `from` 係「純數字」電話號碼，例如 "85291234567"
// ============================================================

function cleanPhone(input) {
  return String(input || '').replace(/[^0-9]/g, '');
}

// 介面（所有 provider 都實現呢啲方法）
class MessagingProvider {
  constructor(config = {}) {
    this.config = config;
    this.handlers = [];
  }

  async start() {}
  async stop() {}
  isReady() { return false; }
  info() { return null; }

  async sendText(to, text) { throw new Error('sendText() not implemented'); }
  onMessage(handler) { this.handlers.push(handler); }
  emitMessage(inbound) {
    for (const h of this.handlers) {
      try { h(inbound); } catch (err) { console.error('messaging handler error:', err); }
    }
  }
}

// 薄包裝：將現有 whatsapp-web.js Client 包成同一介面（日後遷移時無縫切換）
class WhatsAppWebProvider extends MessagingProvider {
  constructor(client) {
    super();
    this.client = client;
  }

  isReady() { return Boolean(this.client); }

  async sendText(to, text) {
    return this.client.sendMessage(cleanPhone(to) + '@c.us', text);
  }

  onMessage(handler) {
    this.client.on('message', (msg) => {
      if (msg.fromMe || !msg.body || !msg.body.trim()) return;
      handler({
        id: msg.id && msg.id._serialized ? msg.id._serialized : null,
        from: cleanPhone(msg.from),
        body: msg.body,
        timestamp: msg.timestamp || Date.now(),
        raw: msg
      });
    });
  }
}

// 官方 WhatsApp Business Platform（Cloud API）adapter
class CloudApiProvider extends MessagingProvider {
  constructor(config = {}) {
    super(config);
    this.token = config.token || process.env.META_WHATSAPP_TOKEN;
    this.phoneNumberId = config.phoneNumberId || process.env.META_PHONE_NUMBER_ID;
    this.verifyToken = config.verifyToken || process.env.META_VERIFY_TOKEN;
    this.graphVersion = config.graphVersion || process.env.META_GRAPH_VERSION || 'v21.0';
    this.base = `https://graph.facebook.com/${this.graphVersion}`;
  }

  isConfigured() {
    return Boolean(this.token && this.phoneNumberId);
  }

  isReady() { return this.isConfigured(); }

  info() {
    return { provider: 'cloud-api', phoneNumberId: this.phoneNumberId, graphVersion: this.graphVersion };
  }

  // Meta webhook 驗證 handshake（GET）— 回傳 challenge 即代表驗證成功
  verifyWebhook(mode, token, challenge) {
    if (mode === 'subscribe' && this.verifyToken && token === this.verifyToken) {
      return { ok: true, challenge };
    }
    return { ok: false };
  }

  async sendText(to, text) {
    if (!this.isConfigured()) throw new Error('META_WHATSAPP_TOKEN / META_PHONE_NUMBER_ID 未設定');
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone(to),
      type: 'text',
      text: { preview_url: false, body: text }
    };
    return this._post(payload);
  }

  // 出於 24 小時視窗外 -> 用已審批 Template（HSM）
  async sendTemplate(to, templateName, languageCode = 'zh_HK', components = []) {
    if (!this.isConfigured()) throw new Error('META_WHATSAPP_TOKEN / META_PHONE_NUMBER_ID 未設定');
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone(to),
      type: 'template',
      template: { name: templateName, language: { code: languageCode }, ...(components.length ? { components } : {}) }
    };
    return this._post(payload);
  }

  async _post(payload) {
    const resp = await fetch(`${this.base}/${this.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error((data && data.error && data.error.message) || `Cloud API ${resp.status}`);
    }
    return data;
  }

  // 解析 Cloud API webhook payload → 標準化入站訊息陣列
  processWebhook(payload) {
    const results = [];
    if (!payload || payload.object !== 'whatsapp_business_account') return results;
    for (const entry of (payload.entry || [])) {
      for (const change of (entry.changes || [])) {
        const value = change.value || {};
        if (change.field === 'messages') {
          for (const m of (value.messages || [])) {
            if (m.type === 'text') {
              results.push({
                id: m.id,
                from: cleanPhone(m.from),
                body: (m.text && m.text.body) || '',
                timestamp: Number(m.timestamp) * 1000 || Date.now(),
                raw: m
              });
            }
          }
        }
      }
    }
    return results;
  }
}

function createProvider(config = {}) {
  const type = String(config.provider || process.env.MESSAGING_PROVIDER || 'whatsapp-web').toLowerCase();
  if (type === 'cloud-api' || type === 'cloud' || type === 'meta' || type === 'waba') {
    return new CloudApiProvider(config);
  }
  return new WhatsAppWebProvider(config.client);
}

module.exports = {
  MessagingProvider,
  WhatsAppWebProvider,
  CloudApiProvider,
  createProvider,
  cleanPhone
};