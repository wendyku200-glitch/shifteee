const express = require('express');
const { Client, LocalAuth, Buttons, List } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const { execSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();
const { Sequelize, DataTypes } = require('sequelize');
const { CloudApiProvider } = require('./messaging');

const cloudApi = new CloudApiProvider();

// ---- Admin auth (simple ADMIN_TOKEN) ----
function adminToken() {
  return process.env.ADMIN_TOKEN || '';
}

function adminMatches(req) {
  const tok = adminToken();
  if (!tok) return true; // no token configured -> open (dev mode)
  const header = req.header('x-admin-token') || '';
  const auth = req.header('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const query = String(req.query.token || '');
  const cookies = (req.headers.cookie || '').split(';').map((s) => s.trim());
  const adminCookie = cookies.find((s) => s.startsWith('admin_token='));
  const cookieVal = adminCookie ? decodeURIComponent(adminCookie.slice('admin_token='.length)) : '';
  return header === tok || bearer === tok || query === tok || cookieVal === tok;
}

function adminLoginPage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>管理員登入</title></head><body style="font-family:Arial,sans-serif;background:#f0f2f5;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;"><div style="background:#fff;padding:28px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.08);width:320px;text-align:center;"><h2 style="margin:0 0 16px;">🔐 管理員登入</h2><input id="p" type="password" placeholder="ADMIN_TOKEN" autofocus style="width:100%;box-sizing:border-box;padding:12px;border:1px solid #ccc;border-radius:8px;font-size:15px;"><button onclick="login()" style="margin-top:14px;width:100%;padding:12px;background:#128c7e;color:#fff;border:none;border-radius:8px;font-size:15px;cursor:pointer;">登入</button><p id="err" style="color:#c00;font-size:13px;min-height:18px;"></p></div><script>function login(){var v=document.getElementById('p').value.trim();if(!v){document.getElementById('err').textContent='請輸入 ADMIN_TOKEN';return;}document.cookie='admin_token='+encodeURIComponent(v)+';path=/';location.reload();}</script></body></html>`;
}

function requireAdmin(req, res, next) {
  if (adminMatches(req)) return next();
  if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
    return res.status(401).json({ error: '未授權：缺少或錯誤嘅 ADMIN_TOKEN' });
  }
  return res.status(401).send(adminLoginPage());
}

const app = express();
app.use(express.json({
  // Keep the raw body around so Stripe webhook signatures can be verified
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// ============================================
// Database Setup
// ============================================
const sequelize = new Sequelize(process.env.DATABASE_URL, { logging: false });

// Companies (multi-tenant)
const Company = sequelize.define('Company', {
  name: { type: DataTypes.STRING, allowNull: false },
  slug: { type: DataTypes.STRING, unique: true },
  status: { type: DataTypes.STRING, defaultValue: 'active' }, // active | pending_payment | pending_qr | suspended
  payment_status: { type: DataTypes.STRING, defaultValue: 'unpaid' }, // unpaid | pending | paid | refunded
  payment_method: { type: DataTypes.STRING },                          // mock | stripe | alipayhk | payme | manual
  payment_reference: { type: DataTypes.STRING },                       // session id / order no / transaction ref
  paid_amount: { type: DataTypes.INTEGER },                            // in cents (e.g. 29900 = HK$299.00)
  paid_currency: { type: DataTypes.STRING },
  paid_at: { type: DataTypes.DATE },
  plan_type: { type: DataTypes.STRING, defaultValue: 'starter' },
  whatsapp_config: { type: DataTypes.TEXT, defaultValue: '{}' },
  line_config: { type: DataTypes.TEXT, defaultValue: '{}' },
  active: { type: DataTypes.BOOLEAN, defaultValue: true }
}, { timestamps: true });

// Branches (multi-store / departments within a company)
const Branch = sequelize.define('Branch', {
  name: { type: DataTypes.STRING, allowNull: false },
  code: { type: DataTypes.STRING },                          // 分店代號（選填）
  is_default: { type: DataTypes.BOOLEAN, defaultValue: false },
  active: { type: DataTypes.BOOLEAN, defaultValue: true },
  whatsapp_config: { type: DataTypes.TEXT, defaultValue: '{}' }  // 專屬 WhatsApp 號碼設定
}, { timestamps: true });

// Users (employees)
const User = sequelize.define('User', {
  name: { type: DataTypes.STRING, allowNull: false },
  full_english_name: { type: DataTypes.STRING },
  work_nickname: { type: DataTypes.STRING },
  phone: { type: DataTypes.STRING },
  external_id: { type: DataTypes.STRING },
  role: { type: DataTypes.STRING, defaultValue: 'employee' },
  has_paid_leave: { type: DataTypes.BOOLEAN, defaultValue: false },  // 有薪假資格
  branch_id: { type: DataTypes.INTEGER, allowNull: true },
  active: { type: DataTypes.BOOLEAN, defaultValue: true }
}, { timestamps: true });

// Message Logs
const MessageLog = sequelize.define('MessageLog', {
  channel: { type: DataTypes.STRING },
  direction: { type: DataTypes.STRING },
  raw_text: { type: DataTypes.TEXT },
  parsed_payload: { type: DataTypes.TEXT },
  message_id: { type: DataTypes.STRING },
  sender: { type: DataTypes.STRING },
  branch_id: { type: DataTypes.INTEGER, allowNull: true }
}, { timestamps: true });

// Requests (leave / swap)
const Request = sequelize.define('Request', {
  type: { type: DataTypes.STRING, allowNull: false },  // leave, swap
  leave_pay_type: { type: DataTypes.STRING },           // paid, unpaid
  leave_category: { type: DataTypes.STRING },           // 事假, 病假, 產假, 婚假
  date_from: { type: DataTypes.DATEONLY },
  date_to: { type: DataTypes.DATEONLY },
  time_slot: { type: DataTypes.STRING },                // 自由填寫時間
  reason: { type: DataTypes.TEXT },
  doctor_cert: { type: DataTypes.BOOLEAN },             // 醫生證明
  full_english_name: { type: DataTypes.STRING },
  work_nickname: { type: DataTypes.STRING },
  status: { type: DataTypes.STRING, defaultValue: 'pending' },
  source_channel: { type: DataTypes.STRING, defaultValue: 'whatsapp' },
  processed_by: { type: DataTypes.INTEGER, allowNull: true },
  branch_id: { type: DataTypes.INTEGER, allowNull: true }
}, { timestamps: true });

// Relationships
Company.hasMany(User, { foreignKey: 'company_id' });
User.belongsTo(Company, { foreignKey: 'company_id' });

Company.hasMany(Request, { foreignKey: 'company_id' });
Request.belongsTo(Company, { foreignKey: 'company_id' });

User.hasMany(Request, { foreignKey: 'user_id' });
Request.belongsTo(User, { foreignKey: 'user_id' });

Request.belongsTo(User, { as: 'targetUser', foreignKey: 'target_user_id' });

Company.hasMany(MessageLog, { foreignKey: 'company_id' });
MessageLog.belongsTo(Company, { foreignKey: 'company_id' });
MessageLog.belongsTo(User, { foreignKey: 'user_id' });

// Branch relationships (multi-store)
Company.hasMany(Branch, { foreignKey: 'company_id' });
Branch.belongsTo(Company, { foreignKey: 'company_id' });

Branch.hasMany(User, { foreignKey: 'branch_id' });
User.belongsTo(Branch, { foreignKey: 'branch_id' });

Branch.hasMany(Request, { foreignKey: 'branch_id' });
Request.belongsTo(Branch, { foreignKey: 'branch_id' });

Branch.hasMany(MessageLog, { foreignKey: 'branch_id' });
MessageLog.belongsTo(Branch, { foreignKey: 'branch_id' });

// ============================================
// In-Memory Conversation State Store
// ============================================
const conversationState = new Map(); // key: phone -> { step, data }
const welcomeSent = new Set(); // Track users who have received welcome message

const STEPS = {
  NONE: 'none',

  // Leave flow (compressed, interactive)
  LEAVE_TYPE: 'leave_type',
  LEAVE_DETAILS: 'leave_details',
  LEAVE_CONFIRM: 'leave_confirm',

  // Swap flow (compressed)
  SWAP_DETAILS: 'swap_details',
  SWAP_CONFIRM: 'swap_confirm',
};

// ============================================
// Seed Default Data
// ============================================
async function seedDefaultData() {
  const count = await Company.count();
  if (count === 0) {
    const company = await Company.create({
      name: 'Demo Company',
      slug: 'demo-company',
      status: 'active',
      payment_status: 'paid',
      payment_method: 'manual',
      paid_amount: 0,
      paid_currency: 'HKD',
      paid_at: new Date(),
      plan_type: 'starter',
      whatsapp_config: JSON.stringify({}),
      line_config: JSON.stringify({})
    });
    console.log('✅ Created default company: Demo Company');

    await User.bulkCreate([
      { name: '小明', full_english_name: 'Siu Ming', work_nickname: '小明', phone: '', external_id: '', role: 'employee', has_paid_leave: true, company_id: company.id },
      { name: '小華', full_english_name: 'Siu Wah', work_nickname: '小華', phone: '', external_id: '', role: 'employee', has_paid_leave: false, company_id: company.id },
      { name: '管理員', full_english_name: 'Manager', work_nickname: '管理員', phone: '', external_id: '', role: 'manager', has_paid_leave: true, company_id: company.id }
    ]);
    console.log('✅ Created demo users: 小明 (有薪假✅), 小華, 管理員');
  }
}

// ============================================
// Conversation Logic
// ============================================

// Get Chinese weekday name
function getChineseWeekday(dateStr) {
  const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const d = new Date(dateStr);
  return days[d.getDay()];
}

// Format date in Chinese format
function formatDateChinese(dateStr) {
  const d = new Date(dateStr);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const weekday = getChineseWeekday(dateStr);
  return `${year}年${month}月${day}日 ${weekday}`;
}

// Format leave summary for confirmation
function formatLeaveSummary(data) {
  const payTypeText = data.leave_pay_type === 'paid' ? '有薪假期 ✅' : '無薪假期';
  const categoryMap = { '事假': '事假', '病假': '病假', '產假': '產假', '婚假': '婚假' };
  const catText = categoryMap[data.leave_category] || data.leave_category;
  const dateText = data.date_from ? formatDateChinese(data.date_from) : '-';
  
  let details = '';
  if (data.leave_category === '事假') details = `📝 事由：${data.reason || '-'}`;
  else if (data.leave_category === '病假') details = `🩺 病情：${data.reason || '-'}\n💊 醫生證明：${data.doctor_cert ? '有 ✅' : '無 ❌'}`;
  else if (data.leave_category === '產假') details = `📄 證明：${data.reason || '已準備'}`;
  else if (data.leave_category === '婚假') details = `📄 證明：${data.reason || '已準備'}`;

  return [
    `📋 *請假申請確認*`,
    ``,
    `👤 員工：${data.full_english_name || '-'}（${data.work_nickname || '-'}）`,
    `💰 類型：${payTypeText}`,
    `📂 類別：${catText}`,
    `📅 日期：${dateText}`,
    `⏰ 時間：${data.time_slot || '全日'}`,
    `${details}`,
    ``,
    `請確認以上資料是否正確？`,
    `回覆「✅ 確認」或「❌ 取消」`
  ].join('\n');
}

// Format swap summary
function formatSwapSummary(data) {
  const dateText = data.date_from ? formatDateChinese(data.date_from) : '-';
  return [
    `📋 *換班申請確認*`,
    ``,
    `👤 申請人：${data.full_english_name || '-'}（${data.work_nickname || '-'}）`,
    `📅 日期：${dateText}`,
    `⏰ 時間：${data.time_slot || '-'}`,
    `📝 原因：${data.reason || '-'}`,
    `👥 換班對象：${data.target_name || '無指定'}`,
    ``,
    `請確認以上資料是否正確？`,
    `回覆「✅ 確認」或「❌ 取消」`
  ].join('\n');
}

// ---- Interactive helpers (壓縮訊息、慳 Cloud API 成本) ----

function leaveTypeList() {
  return new List(
    '📋 *請假申請* — 請選擇假期種類：',
    '選擇種類',
    [
      { title: '有薪假期', rows: [
        { id: 'paid_sick',      title: '有薪病假', description: '需醫生紙' },
        { id: 'paid_personal',  title: '有薪事假', description: '' },
        { id: 'paid_maternity', title: '產假（有薪）', description: '' },
        { id: 'paid_marriage',  title: '婚假（有薪）', description: '' },
      ]},
      { title: '無薪假期', rows: [
        { id: 'unpaid_personal', title: '無薪事假', description: '' },
        { id: 'unpaid_sick',    title: '無薪病假', description: '' },
      ]},
    ],
    '請假申請',
    ''
  );
}

function parseLeaveType(text) {
  const t = String(text || '');
  if (/有薪病假/.test(t))        return { leave_pay_type: 'paid', leave_category: '病假', doctor_cert: false };
  if (/無薪病假/.test(t))        return { leave_pay_type: 'unpaid', leave_category: '病假', doctor_cert: false };
  if (/有薪事假/.test(t))        return { leave_pay_type: 'paid', leave_category: '事假', doctor_cert: false };
  if (/無薪事假/.test(t))        return { leave_pay_type: 'unpaid', leave_category: '事假', doctor_cert: false };
  if (/產假/.test(t))           return { leave_pay_type: 'paid', leave_category: '產假', doctor_cert: true };
  if (/婚假/.test(t))           return { leave_pay_type: 'paid', leave_category: '婚假', doctor_cert: true };
  return null;
}

function confirmButtons(bodyText) {
  return new Buttons(bodyText, [
    { id: 'confirm', body: '✅ 確認' },
    { id: 'reset',   body: '🔄 重設' },
    { id: 'cancel',  body: '❌ 取消' }
  ], '請確認', '');
}

function detailsPrompt(bodyText, title) {
  return new Buttons(bodyText, [
    { id: 'cancel', body: '❌ 取消申請' }
  ], title || '', '');
}

function leaveDetailsText(category) {
  const certHint = category === '病假' ? '（病假請註明有無醫生紙）' : '';
  return `📅 *請一次過回覆*\n\n日期：7月10日\n時間：09:00-17:00（或 全日）\n事由：發燒頭痛${certHint}`;
}

function swapDetailsText() {
  return `🔄 *換班申請*\n\n請一次過回覆（可用以下格式）：\n日期：7月10日\n時間：09:00-17:00（或 全日）\n對象：小明（或 無）\n原因：家中有事`;
}

const ALL_LABELS = ['日期', '時間', '事由', '原因', '理由', '對象', '同事'];

function pickLabel(text, labels) {
  const others = ALL_LABELS.filter((l) => !labels.includes(l)).join('|');
  const stop = others ? `(?=(?:${others})\\s*[：:：]|$)` : '';
  for (const label of labels) {
    const re = new RegExp(label + '\\s*[：:：]\\s*([\\s\\S]*?)' + stop);
    const m = text.match(re);
    if (m && m[1] && m[1].trim()) return m[1].trim();
  }
  return '';
}

// 一次過解析「日期 + 時間 + 事由（+ 對象）」嘅自由文字
function parseCombined(text) {
  const r = {};
  r.date = extractDate(text);
  r.time_slot = pickLabel(text, ['時間']) || '';
  r.reason = pickLabel(text, ['事由', '原因', '理由']);
  r.target_name = pickLabel(text, ['對象', '同事']);
  r.doctor_cert = /有醫生紙|有醫生證明|醫生證明|有證明/.test(text);

  if (!r.time_slot) {
    const tm = text.match(/(\d{1,2}:\d{2})\s*[-~–—至到]\s*(\d{1,2}:\d{2})/);
    if (tm) r.time_slot = tm[1] + '-' + tm[2];
    else if (/全日|全天/.test(text)) r.time_slot = '全日';
    else if (/上午|上晝/.test(text)) r.time_slot = '上午';
    else if (/下午|下晝/.test(text)) r.time_slot = '下午';
    else r.time_slot = '全日';
  }

  if (!r.reason) {
    let rest = text
      .replace(/日期|時間|事由|原因|理由|對象|同事/g, ' ')
      .replace(/\d{4}年\d{1,2}月\d{1,2}日/g, ' ')
      .replace(/\d{1,2}月\d{1,2}[日號]/g, ' ')
      .replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, ' ')
      .replace(/\d{1,2}:\d{2}/g, ' ')
      .replace(/有醫生紙|有醫生證明|醫生證明|有證明/g, ' ');
    rest = rest.replace(/[：:]\s*/g, ' ').replace(/\s+/g, ' ').trim();
    r.reason = rest || '-';
  }

  return r;
}

// Handle conversation message
async function handleConversation(company, user, msg, text) {
  const key = `${company.id}:${user.external_id || user.phone || msg.from}`;
  let state = conversationState.get(key) || { step: STEPS.NONE, data: {} };

  // If not in a conversation, check for intent triggers
  if (state.step === STEPS.NONE) {
    // Detect LEAVE intent (skip when the message is really a records query)
    if (/請假|攞假|拎假/.test(text) && !/記錄|查詢|查記錄|^我的請假/.test(text.trim())) {
      state = { step: STEPS.LEAVE_TYPE, data: { type: 'leave' } };
      conversationState.set(key, state);
      await msg.reply(leaveTypeList());
      return true;
    }

    // Detect SWAP intent
    if (/換班|換更|調班|調更/.test(text)) {
      state = {
        step: STEPS.SWAP_DETAILS,
        data: {
          type: 'swap',
          full_english_name: user.full_english_name || '',
          work_nickname: user.work_nickname || user.name
        }
      };
      conversationState.set(key, state);
      await msg.reply(detailsPrompt(swapDetailsText(), '換班申請'));
      return true;
    }

    // Detect CANCEL intent (cancel an existing pending request)
    if (/取消|作廢/.test(text)) {
      const idMatch = text.match(/(?:#|編號|號|no\.?)\s*(\d+)/i) || text.match(/(\d+)/);
      const targetId = idMatch ? Number(idMatch[1]) : null;
      if (targetId) {
        await cancelRequestById(company, user, targetId, msg);
      } else {
        await msg.reply(`請輸入要取消的申請編號，例如：取消 #12`);
      }
      return true;
    }

    // Show command list (/menu, /commands, /指令)
    if (/^\/(menu|commands|指令|幫助|說明|help)$/i.test(text.trim())) {
      await msg.reply(
        `📌 *可用指令清單*\n\n` +
        `📋 *請假* - 申請假期\n` +
        `   範例：輸入「請假」開始申請流程\n\n` +
        `🔄 *換班* - 申請換班\n` +
        `   範例：輸入「換班」開始申請流程\n\n` +
        `📊 *我的記錄* - 查看自己的申請\n` +
        `   範例：輸入「我的記錄」或「查詢記錄」\n\n` +
        `❓ *幫助* - 顯示此說明\n` +
        `   範例：輸入「幫助」或「help」\n\n` +
        `──────────────────\n` +
        `*管理員專用指令*：\n\n` +
        `📈 *管理儀表板* - 查看統計數據\n` +
        `⏳ *待審核* - 列出待審核申請\n\n` +
        `有任何問題請聯絡管理員。`
      );
      return true;
    }

    // If "help" or greeting
    if (/^(hello|hi|hey|help|你好|您好|嗨|哈囉)[\s!！。?？]*$/i.test(text.trim())) {
      await msg.reply(
        `👋 你好！我是排班機器人。\n\n` +
        `輸入 *"/指令"* 或 *"/menu"* 查看所有可用指令！\n\n` +
        `快速指令：\n` +
        `• 「請假」- 申請假期\n` +
        `• 「換班」- 申請換班\n` +
        `• 「我的記錄」- 查看申請記錄`
      );
      return true;
    }

    // Detect MY_REQUESTS intent (查詢自己的記錄)
    if (/記錄|我的請假|我的申請/.test(text)) {
      const userRequests = await Request.findAll({
        where: { user_id: user.id },
        order: [['createdAt', 'DESC']],
        limit: 10
      });

      if (userRequests.length === 0) {
        await msg.reply(`📭 您目前沒有任何申請記錄。\n\n輸入「請假」開始申請。`);
        return true;
      }

      const lines = [`📊 *您的申請記錄*（最新 ${Math.min(userRequests.length, 10)} 筆）:\n`];
      for (const r of userRequests) {
        const statusText = {
          pending: '⏳ 待審核',
          approved: '✅ 已批准',
          rejected: '❌ 已拒絕',
          cancelled: '🚫 已取消'
        }[r.status] || r.status;

        const typeText = r.type === 'leave'
          ? `請假${r.leave_pay_type === 'paid' ? '(有薪)' : '(無薪)'}-${r.leave_category}`
          : '換班';

        const dateText = r.date_from ? formatDateChinese(r.date_from) : '-';
        lines.push(`#${r.id} ${typeText}\n📅 ${dateText}\n📌 ${statusText}`);
      }

      await msg.reply(lines.join('\n\n'));
      return true;
    }

    // Admin commands for managers
    if (user.role === 'manager') {
      // Check for admin stats command
      if (/管理儀表板|統計|總覽|admin\s*stats/i.test(text)) {
        const totalRequests = await Request.count();
        const pendingRequests = await Request.count({ where: { status: 'pending' } });
        const approvedToday = await Request.count({
          where: { 
            status: 'approved',
            updatedAt: { [Sequelize.Op.gte]: new Date(new Date().setHours(0,0,0,0)) }
          }
        });

        await msg.reply(
          `📊 *管理儀表板*\n\n` +
          `📋 總申請數：${totalRequests}\n` +
          `⏳ 待審核：${pendingRequests}\n` +
          `✅ 今日批准：${approvedToday}\n\n` +
          `後台網址：${baseUrl()}/requests`
        );
        return true;
      }

      // Check for pending requests list
      if (/待審核|^_?pending$/i.test(text.trim())) {
        const pendingRequests = await Request.findAll({
          where: { status: 'pending' },
          include: [{ model: User, attributes: ['name'] }],
          order: [['createdAt', 'ASC']],
          limit: 10
        });

        if (pendingRequests.length === 0) {
          await msg.reply(`✅ 目前沒有待審核的申請。`);
          return true;
        }

        const lines = [`⏳ *待審核申請* (${pendingRequests.length}筆):\n`];
        for (const r of pendingRequests) {
          const typeText = r.type === 'leave' ? '請假' : '換班';
          const name = r.full_english_name || (r.User ? r.User.name : '未知');
          const dateText = r.date_from ? formatDateChinese(r.date_from) : '-';
          lines.push(`#${r.id} ${typeText} - ${name}\n📅 ${dateText}`);
        }
        lines.push(`\n到後台審核：${baseUrl()}/requests`);

        await msg.reply(lines.join('\n\n'));
        return true;
      }
    }

    return false;
  }

  // ================ LEAVE FLOW (compressed, interactive) ================
  if (state.data.type === 'leave') {
    // Step: pick leave type via interactive List
    if (state.step === STEPS.LEAVE_TYPE) {
      const parsed = parseLeaveType(text);
      if (!parsed) {
        await msg.reply(leaveTypeList());
        return true;
      }
      state.data.leave_pay_type = parsed.leave_pay_type;
      state.data.leave_category = parsed.leave_category;
      state.data.doctor_cert = parsed.doctor_cert;
      state.data.full_english_name = state.data.full_english_name || user.full_english_name || '';
      state.data.work_nickname = state.data.work_nickname || user.work_nickname || user.name;
      state.step = STEPS.LEAVE_DETAILS;
      conversationState.set(key, state);
      await msg.reply(detailsPrompt(leaveDetailsText(state.data.leave_category), '請假申請'));
      return true;
    }

    // Step: one-shot details (date + time + reason)
    if (state.step === STEPS.LEAVE_DETAILS) {
      if (/取消|❌/.test(text)) {
        conversationState.delete(key);
        await msg.reply('❌ 請假申請已取消。如需重新申請，請輸入「請假」。');
        return true;
      }
      const parsed = parseCombined(text);
      if (!parsed.date) {
        await msg.reply(detailsPrompt(leaveDetailsText(state.data.leave_category), '請假申請'));
        return true;
      }
      state.data.date_from = parsed.date;
      state.data.date_to = parsed.date;
      state.data.time_slot = parsed.time_slot;
      state.data.reason = parsed.reason;
      if (state.data.leave_category === '病假' && parsed.doctor_cert) state.data.doctor_cert = true;
      if (state.data.leave_category === '產假' || state.data.leave_category === '婚假') state.data.doctor_cert = true;
      state.step = STEPS.LEAVE_CONFIRM;
      conversationState.set(key, state);
      await msg.reply(confirmButtons(formatLeaveSummary(state.data)));
      return true;
    }

    // (日期／時間／姓名分步已合併入 LEAVE_DETAILS，減少訊息數)

    // Step: Confirm
    if (state.step === STEPS.LEAVE_CONFIRM) {
      if (/確認|✅|yes|ok|好|係|confirm/i.test(text)) {
        // Save to database
        try {
          const request = await Request.create({
            company_id: company.id,
            user_id: user.id,
            branch_id: user.branch_id || null,
            type: 'leave',
            leave_pay_type: state.data.leave_pay_type,
            leave_category: state.data.leave_category,
            date_from: state.data.date_from,
            date_to: state.data.date_to,
            time_slot: state.data.time_slot,
            reason: state.data.reason,
            doctor_cert: state.data.doctor_cert || false,
            full_english_name: state.data.full_english_name,
            work_nickname: state.data.work_nickname,
            status: 'pending',
            source_channel: 'whatsapp'
          });

          // Notify managers of the request's branch
          const managers = await getRequestManagers(company.id, request.branch_id);

          const payTypeText = state.data.leave_pay_type === 'paid' ? '有薪' : '無薪';
          const categoryText = state.data.leave_category;
          const dateText = state.data.date_from ? formatDateChinese(state.data.date_from) : '-';

          for (const mgr of managers) {
            if (mgr.external_id) {
              const chatId = mgr.external_id.includes('@c.us') ? mgr.external_id : mgr.external_id + '@c.us';
              try {
                await sendToCompany(
                  company.id,
                  chatId,
                  `📢 *新請假通知*\n\n` +
                  `👤 申請人：${state.data.full_english_name}（${state.data.work_nickname}）\n` +
                  `📋 類型：${payTypeText} - ${categoryText}\n` +
                  `📅 日期：${dateText}\n` +
                  `⏰ 時間：${state.data.time_slot}\n` +
                  `📝 原因：${state.data.reason || '-'}\n` +
                  `🆔 申請編號：#${request.id}\n\n` +
                  `✅ 請到後台審核：${baseUrl()}/requests`
                );
              } catch (e) {}
            }
          }

          conversationState.delete(key);
          await msg.reply(`✅ 已提交：申請編號 #${request.id}（待審核）`);
        } catch (err) {
          console.error('❌ Error saving request:', err);
          await msg.reply('❌ 抱歉，系統出現錯誤，請稍後再試或聯絡管理員。');
        }
      } else if (/重設|🔄|edit|修改/i.test(text)) {
        state.step = STEPS.LEAVE_DETAILS;
        conversationState.set(key, state);
        await msg.reply(detailsPrompt(leaveDetailsText(state.data.leave_category), '請假申請'));
      } else if (/取消|❌|no|唔|不要|cancel/i.test(text)) {
        conversationState.delete(key);
        await msg.reply('❌ 請假申請已取消。如需重新申請，請輸入「請假」。');
      } else {
        await msg.reply(confirmButtons(formatLeaveSummary(state.data)));
      }
      return true;
    }
  }

  // ================ SWAP FLOW (compressed) ================
  if (state.data.type === 'swap') {
    if (state.step === STEPS.SWAP_DETAILS) {
      if (/取消|❌/.test(text)) {
        conversationState.delete(key);
        await msg.reply('❌ 換班申請已取消。如需重新申請，請輸入「換班」。');
        return true;
      }
      const parsed = parseCombined(text);
      if (!parsed.date) {
        await msg.reply(detailsPrompt(swapDetailsText(), '換班申請'));
        return true;
      }
      state.data.date_from = parsed.date;
      state.data.date_to = parsed.date;
      state.data.time_slot = parsed.time_slot;
      state.data.reason = parsed.reason || '-';
      const tname = (parsed.target_name || '').trim();
      if (tname && tname !== '無' && tname !== '冇' && tname !== '沒有' && tname !== 'no' && tname !== 'none') {
        state.data.target_name = tname;
      }
      state.step = STEPS.SWAP_CONFIRM;
      conversationState.set(key, state);
      await msg.reply(confirmButtons(formatSwapSummary(state.data)));
      return true;
    }

    // Step: Confirm swap
    if (state.step === STEPS.SWAP_CONFIRM) {
      if (/確認|✅|yes|ok|好|係|confirm/i.test(text)) {
        try {
          let targetUserId = null;
          if (state.data.target_name) {
            const targetUser = await User.findOne({
              where: { name: state.data.target_name, company_id: company.id }
            });
            if (targetUser) targetUserId = targetUser.id;
          }

          const request = await Request.create({
            company_id: company.id,
            user_id: user.id,
            branch_id: user.branch_id || null,
            type: 'swap',
            date_from: state.data.date_from,
            date_to: state.data.date_to,
            time_slot: state.data.time_slot,
            reason: state.data.reason,
            target_user_id: targetUserId,
            full_english_name: state.data.full_english_name || user.full_english_name,
            work_nickname: state.data.work_nickname || user.work_nickname || user.name,
            status: 'pending',
            source_channel: 'whatsapp'
          });

          // Notify managers of the request's branch
          const managers = await getRequestManagers(company.id, request.branch_id);

          const dateText = request.date_from ? formatDateChinese(request.date_from) : '-';

          for (const mgr of managers) {
            if (mgr.external_id) {
              const chatId = mgr.external_id.includes('@c.us') ? mgr.external_id : mgr.external_id + '@c.us';
              try {
                await sendToCompany(
                  company.id,
                  chatId,
                  `📢 *新換班通知*\n\n` +
                  `👤 申請人：${request.full_english_name}（${request.work_nickname}）\n` +
                  `📅 日期：${dateText}\n` +
                  `⏰ 時間：${request.time_slot}\n` +
                  `📝 原因：${request.reason}\n` +
                  `👥 對象：${state.data.target_name || '無指定'}\n` +
                  `🆔 申請編號：#${request.id}\n\n` +
                  `✅ 請到後台審核：${baseUrl()}/requests`
                );
              } catch (e) {}
            }
          }

          conversationState.delete(key);
          await msg.reply(`✅ 已提交：申請編號 #${request.id}（待審核）`);
        } catch (err) {
          console.error('❌ Error saving swap request:', err);
          await msg.reply('❌ 抱歉，系統出現錯誤，請稍後再試或聯絡管理員。');
        }
      } else if (/重設|🔄|edit|修改/i.test(text)) {
        state.step = STEPS.SWAP_DETAILS;
        conversationState.set(key, state);
        await msg.reply(detailsPrompt(swapDetailsText(), '換班申請'));
      } else if (/取消|❌|no|唔|不要|cancel/i.test(text)) {
        conversationState.delete(key);
        await msg.reply('❌ 換班申請已取消。如需重新申請，請輸入「換班」。');
      } else {
        await msg.reply(confirmButtons(formatSwapSummary(state.data)));
      }
      return true;
    }
  }

  return false;
}

// ============================================
// Helper: extract date from text
// ============================================
function extractDate(text) {
  const year = new Date().getFullYear();

  // Chinese format: 2026年7月10日 星期五
  const chineseMatch = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (chineseMatch) {
    return `${chineseMatch[1]}-${chineseMatch[2].padStart(2, '0')}-${chineseMatch[3].padStart(2, '0')}`;
  }

  // Chinese format: 7月10日
  const chineseShortMatch = text.match(/(\d{1,2})月(\d{1,2})日/);
  if (chineseShortMatch) {
    return `${year}-${chineseShortMatch[1].padStart(2, '0')}-${chineseShortMatch[2].padStart(2, '0')}`;
  }

  // ISO format: 2026-07-10 or 2026/07/10
  const isoMatch = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
  }

  // Local format: 7/10 or 7月10號
  const localMatch = text.match(/(\d{1,2})[\/月](\d{1,2})[號日]?/);
  if (localMatch) {
    const month = localMatch[1].padStart(2, '0');
    const day = localMatch[2].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // Chinese relative dates
  if (/今天|今日/.test(text)) return formatDate(new Date());
  if (/明天|聽日|明日/.test(text)) {
    const d = new Date(); d.setDate(d.getDate() + 1);
    return formatDate(d);
  }
  if (/後天|後日/.test(text)) {
    const d = new Date(); d.setDate(d.getDate() + 2);
    return formatDate(d);
  }
  if (/昨天|昨日/.test(text)) {
    const d = new Date(); d.setDate(d.getDate() - 1);
    return formatDate(d);
  }

  // Weekday
  const weekdays = { '星期一': 1, '星期二': 2, '星期三': 3, '星期四': 4, '星期五': 5, '星期六': 6, '星期日': 0, '週一': 1, '週二': 2, '週三': 3, '週四': 4, '週五': 5, '週六': 6, '週日': 0 };
  for (const [name, day] of Object.entries(weekdays)) {
    if (text.includes(name)) {
      const d = new Date();
      let diff = day - d.getDay();
      if (diff <= 0) diff += 7;
      d.setDate(d.getDate() + diff);
      return formatDate(d);
    }
  }

  return null;
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ============================================
// Multi-tenant WhatsApp instance manager
// ============================================
function slugify(name) {
  const base = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'company';
}

async function uniqueSlug(name, companyId) {
  const base = slugify(name);
  let candidate = base;
  let suffix = 1;
  while (true) {
    const clash = await Company.findOne({ where: { slug: candidate } });
    if (!clash || clash.id === companyId) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
}

// Kill any orphaned Chromium left behind by a previous process. Without this,
// the saved profile (session-company-<id>) stays locked and initialize() fails
// with "browser is already running for <userDataDir>".
function killStaleBrowser(clientId, label) {
  const marker = path.join(process.cwd(), '.wwebjs_auth', `session-${clientId}`);
  let pids = [];
  try {
    pids = execSync(`pgrep -f "${marker}"`, { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (err) {
    return; // pgrep exits with 1 when nothing matches
  }
  for (const pid of pids) {
    try { process.kill(Number(pid), 'SIGKILL'); } catch (err) { /* ignore */ }
  }
  if (pids.length > 0) {
    console.log(`🧹 Killed ${pids.length} stale Chromium process(es) for ${label || clientId}`);
    execSync('sleep 2'); // give the OS a moment to release the profile lock
  }
}

// SQLite-safe column upgrade (sync({ alter: true }) drops/recreates tables and breaks FKs)
async function ensureSchemaUpgrades() {
  const [columns] = await sequelize.query('PRAGMA table_info(`Companies`)');
  const names = columns.map((c) => c.name);
  if (!names.includes('slug')) {
    await sequelize.query('ALTER TABLE `Companies` ADD COLUMN `slug` VARCHAR(255)');
    console.log('🛠️  Added Companies.slug');
  }
  if (!names.includes('status')) {
    await sequelize.query("ALTER TABLE `Companies` ADD COLUMN `status` VARCHAR(255) DEFAULT 'active'");
    console.log('🛠️  Added Companies.status');
  }
  // Billing columns (added after the initial release)
  const paymentColumns = [
    ['payment_status', "VARCHAR(255) DEFAULT 'unpaid'"],
    ['payment_method', 'VARCHAR(255)'],
    ['payment_reference', 'VARCHAR(255)'],
    ['paid_amount', 'INTEGER'],
    ['paid_currency', 'VARCHAR(255)'],
    ['paid_at', 'DATETIME']
  ];
  for (const [column, type] of paymentColumns) {
    if (!names.includes(column)) {
      await sequelize.query(`ALTER TABLE \`Companies\` ADD COLUMN \`${column}\` ${type}`);
      console.log(`🛠️  Added Companies.${column}`);
    }
  }
  // Grandfather companies that were already running before billing existed
  await sequelize.query(
    "UPDATE `Companies` SET `payment_status` = 'paid', `paid_at` = datetime('now') " +
    "WHERE `status` = 'active' AND (`payment_status` IS NULL OR `payment_status` = 'unpaid')"
  );

  // Multi-branch columns (added after multi-store release)
  for (const table of ['Users', 'Requests', 'MessageLogs']) {
    const [rows] = await sequelize.query(`PRAGMA table_info(\`${table}\`)`);
    const colNames = rows.map((r) => r.name);
    if (!colNames.includes('branch_id')) {
      await sequelize.query(`ALTER TABLE \`${table}\` ADD COLUMN \`branch_id\` INTEGER`);
      console.log(`🛠️  Added ${table}.branch_id`);
    }
  }

  // Branch dedicated WhatsApp number config column
  const [branchCols] = await sequelize.query('PRAGMA table_info(`Branches`)');
  if (!branchCols.map((c) => c.name).includes('whatsapp_config')) {
    await sequelize.query("ALTER TABLE `Branches` ADD COLUMN `whatsapp_config` TEXT DEFAULT '{}'");
    console.log('🛠️  Added Branches.whatsapp_config');
  }

  const companies = await Company.findAll();
  for (const company of companies) {
    if (!company.slug) {
      company.slug = await uniqueSlug(company.name, company.id);
      await company.save();
      console.log(`🏷️  Assigned slug "${company.slug}" to company #${company.id}`);
    }
  }
}

// ============================================
// Normalize legacy / unknown plan_type values to a valid plan
// ============================================
async function normalizePlanTypes() {
  const validKeys = Object.keys(PLANS);
  const companies = await Company.findAll();
  for (const company of companies) {
    if (!company.plan_type || !validKeys.includes(company.plan_type)) {
      const oldValue = company.plan_type || '(empty)';
      company.plan_type = 'starter';
      await company.save();
      console.log(`🔁 Normalized plan_type "${oldValue}" → "starter" (company #${company.id}: ${company.name})`);
    }
  }
}

// ============================================
// Ensure each company has a default branch (multi-store model)
// ============================================
async function ensureDefaultBranches() {
  const companies = await Company.findAll();
  for (const company of companies) {
    let defaultBranch = await Branch.findOne({ where: { company_id: company.id, is_default: true } });
    if (!defaultBranch) {
      const anyBranch = await Branch.findOne({ where: { company_id: company.id } });
      if (!anyBranch) {
        defaultBranch = await Branch.create({ company_id: company.id, name: '總店', code: 'HQ', is_default: true, active: true });
        console.log(`🏪 Created default branch "總店" for company #${company.id}`);
      } else {
        defaultBranch = anyBranch;
        defaultBranch.is_default = true;
        await defaultBranch.save();
      }
    }
    await User.update({ branch_id: defaultBranch.id }, { where: { company_id: company.id, branch_id: null } });
  }
}

class InstanceManager {
  constructor() {
    this.instances = new Map();        // companyId -> instance (company / shared number)
    this.branchInstances = new Map();  // branchId -> instance (branch's own number)
  }

  get(companyId) {
    return this.instances.get(Number(companyId));
  }

  list() {
    return Array.from(this.instances.values()).map((i) => ({
      companyId: i.companyId,
      companyName: i.companyName,
      companySlug: i.companySlug,
      status: i.status,
      number: i.info ? i.info.number : null,
      pushname: i.info ? i.info.pushname : null,
      qrUpdatedAt: i.qrUpdatedAt,
      lastError: i.lastError
    }));
  }

  getReadyClient(companyId) {
    const instance = this.get(companyId);
    if (instance && instance.status === 'ready') return instance.client;
    return null;
  }

  async start(company) {
    const id = company.id;
    const existing = this.instances.get(id);
    if (existing && existing.client) return existing;

    killStaleBrowser(`company-${id}`, `company #${id}`);

    const instance = {
      companyId: id,
      companyName: company.name,
      companySlug: company.slug,
      client: null,
      status: 'starting',
      qr: null,
      qrUpdatedAt: null,
      info: null,
      lastError: null
    };
    this.instances.set(id, instance);

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: `company-${id}` }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
      },
      // Pin a known-good WhatsApp Web build so WAWebSocketModel loads
      // (fixes "Cannot read properties of null (reading 'Socket')")
      webVersion: '2.3000.1053021455-alpha',
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html'
      },
      qrMaxRetries: 0 // keep refreshing the QR code until it is scanned
    });
    instance.client = client;

    client.on('qr', async (qr) => {
      instance.status = 'qr';
      instance.qrUpdatedAt = new Date();
      try {
        instance.qr = await QRCode.toDataURL(qr, { margin: 1, width: 280 });
      } catch (err) {
        instance.qr = null;
        console.error(`❌ Failed to render QR for company #${id}:`, err.message);
      }
      console.log(`📱 QR ready for company #${id} (${company.name}) → ${baseUrl()}/qr/${company.slug}`);
      if (process.env.PRINT_QR === '1') qrcode.generate(qr, { small: true });
    });

    client.on('authenticated', () => {
      instance.status = 'authenticated';
      instance.qr = null;
      console.log(`🔐 Company #${id} authenticated, loading WhatsApp...`);
    });

    client.on('ready', async () => {
      instance.status = 'ready';
      instance.qr = null;
      instance.info = {
        number: client.info && client.info.wid ? client.info.wid.user : null,
        pushname: client.info ? client.info.pushname : null
      };
      console.log(`✅ Company #${id} (${company.name}) WhatsApp ready: ${instance.info.number} (${instance.info.pushname})`);
      try {
        await Company.update({ status: 'active' }, { where: { id } });
      } catch (err) {
        console.error('❌ Failed to mark company active:', err.message);
      }
    });

    client.on('disconnected', (reason) => {
      instance.status = 'disconnected';
      instance.lastError = String(reason || '');
      console.log(`⚠️  Company #${id} disconnected: ${reason}`);
    });

    client.on('auth_failure', (message) => {
      instance.status = 'error';
      instance.lastError = String(message || 'auth failure');
      console.error(`❌ Company #${id} auth failure:`, message);
    });

    attachClientHandlers(company, client);

    client.initialize().catch((err) => {
      instance.status = 'error';
      instance.lastError = err.message;
      console.error(`❌ Company #${id} failed to initialize:`, err.message);
    });

    return instance;
  }

  // ---- Branch dedicated-number support (pro plan) ----
  getBranch(branchId) {
    return this.branchInstances.get(Number(branchId));
  }

  listBranches() {
    return Array.from(this.branchInstances.values()).map((i) => ({
      branchId: i.branchId,
      companyId: i.companyId,
      branchName: i.branchName,
      status: i.status,
      number: i.info ? i.info.number : null,
      pushname: i.info ? i.info.pushname : null,
      qrUpdatedAt: i.qrUpdatedAt,
      lastError: i.lastError
    }));
  }

  getBranchReadyClient(branchId) {
    const instance = this.getBranch(branchId);
    return (instance && instance.status === 'ready') ? instance.client : null;
  }

  async startBranch(company, branch) {
    const bid = branch.id;
    const existing = this.branchInstances.get(bid);
    if (existing && existing.client) return existing;

    killStaleBrowser(`branch-${bid}`, `branch #${bid}`);

    const instance = {
      branchId: bid,
      companyId: company.id,
      companyName: company.name,
      branchName: branch.name,
      client: null,
      status: 'starting',
      qr: null,
      qrUpdatedAt: null,
      info: null,
      lastError: null
    };
    this.branchInstances.set(bid, instance);

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: `branch-${bid}` }),
      puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] },
      webVersion: '2.3000.1053021455-alpha',
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html'
      },
      qrMaxRetries: 0
    });
    instance.client = client;

    client.on('qr', async (qr) => {
      instance.status = 'qr';
      instance.qrUpdatedAt = new Date();
      try {
        instance.qr = await QRCode.toDataURL(qr, { margin: 1, width: 280 });
      } catch (err) {
        instance.qr = null;
      }
      console.log(`📱 Branch #${bid} (${branch.name}) QR ready → /qr/branch/${bid}`);
    });

    client.on('authenticated', () => { instance.status = 'authenticated'; instance.qr = null; });

    client.on('ready', () => {
      instance.status = 'ready';
      instance.qr = null;
      instance.info = {
        number: client.info && client.info.wid ? client.info.wid.user : null,
        pushname: client.info ? client.info.pushname : null
      };
      console.log(`✅ Branch #${bid} (${branch.name}) WhatsApp ready: ${instance.info.number} (${instance.info.pushname})`);
    });

    client.on('disconnected', (reason) => { instance.status = 'disconnected'; instance.lastError = String(reason || ''); });
    client.on('auth_failure', (message) => { instance.status = 'error'; instance.lastError = String(message || 'auth failure'); });

    attachClientHandlers(company, client, branch);

    client.initialize().catch((err) => {
      instance.status = 'error';
      instance.lastError = err.message;
      console.error(`❌ Branch #${bid} failed to initialize:`, err.message);
    });

    return instance;
  }

  async stopBranch(branchId) {
    const bid = Number(branchId);
    const instance = this.branchInstances.get(bid);
    if (!instance) return false;
    try {
      if (instance.client) {
        await Promise.race([
          instance.client.destroy(),
          new Promise((resolve) => setTimeout(resolve, 5000))
        ]);
      }
    } catch (err) {
      console.error(`⚠️  Error destroying branch client #${bid}:`, err.message);
    }
    this.branchInstances.delete(bid);
    return true;
  }

  async stop(companyId) {
    const id = Number(companyId);
    const instance = this.instances.get(id);
    if (!instance) return false;
    try {
      if (instance.client) {
        // Never let a broken/hung client block shutdown or a restart
        await Promise.race([
          instance.client.destroy(),
          new Promise((resolve) => setTimeout(resolve, 5000))
        ]);
      }
    } catch (err) {
      console.error(`⚠️  Error destroying client for company #${id}:`, err.message);
    }
    this.instances.delete(id);
    return true;
  }

  async restart(company) {
    await this.stop(company.id);
    return this.start(company);
  }

  async logout(company) {
    const instance = this.get(company.id);
    if (instance && instance.client) {
      try { await instance.client.logout(); } catch (e) { /* ignore */ }
      try { await instance.client.destroy(); } catch (e) { /* ignore */ }
    }
    this.instances.delete(company.id);
    await Company.update({ status: 'pending_qr' }, { where: { id: company.id } });
  }

  async stopAll() {
    for (const id of Array.from(this.instances.keys())) {
      await this.stop(id);
    }
    for (const bid of Array.from(this.branchInstances.keys())) {
      await this.stopBranch(bid);
    }
  }
}

const instances = new InstanceManager();

// Send a WhatsApp message through the client that belongs to a company
async function sendToCompany(companyId, chatId, message) {
  const client = instances.getReadyClient(companyId);
  if (!client) {
    console.warn(`⚠️  Company #${companyId} is not connected - message to ${chatId} skipped`);
    return null;
  }
  return client.sendMessage(chatId, message);
}

// ============================================
// Billing / payment helpers
// ============================================
const PLANS = {
  basic:   { label: '入門版', amount: 19900, currency: 'HKD', maxEmployees: 20,  maxBranches: 1 },
  starter: { label: '標準版', amount: 29900, currency: 'HKD', maxEmployees: null, maxBranches: 1 },
  pro:     { label: '專業版', amount: 59900, currency: 'HKD', maxEmployees: null, maxBranches: null }
};

const checkoutSessions = new Map(); // mock checkout sessions (in-memory)

function planOf(key) {
  return PLANS[key] || PLANS.starter;
}

function branchConfig(branch) {
  try { return JSON.parse(branch.whatsapp_config || '{}'); } catch (e) { return {}; }
}

function formatMoney(amount, currency) {
  const cur = String(currency || 'HKD').toUpperCase();
  const value = (Number(amount || 0) / 100).toFixed(2);
  return `${cur === 'HKD' ? 'HK$' : cur + ' '}${value}`;
}

function publicBaseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

function baseUrl() {
  return process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
}

// Create a default branch ("總店") for a freshly created company (multi-store)
async function ensureCompanyDefaultBranch(company) {
  const existing = await Branch.findOne({ where: { company_id: company.id, is_default: true } });
  if (!existing) {
    await Branch.create({ company_id: company.id, name: '總店', code: 'HQ', is_default: true, active: true });
    console.log(`🏪 Created default branch "總店" for company #${company.id}`);
  }
}

// Flip a company to paid and provision its WhatsApp instance + QR page
async function markCompanyPaid(company, { method, reference, amount, currency } = {}) {
  if (!company) throw new Error('company is required');
  if (company.payment_status === 'paid') return company;

  const plan = planOf(company.plan_type);
  company.payment_status = 'paid';
  company.payment_method = method || company.payment_method || 'manual';
  if (reference) company.payment_reference = reference;
  company.paid_amount = amount != null ? Number(amount) : plan.amount;
  company.paid_currency = String(currency || plan.currency).toUpperCase();
  company.paid_at = new Date();
  if (company.status !== 'active') company.status = 'pending_qr';
  await company.save();

  console.log(`💰 Company #${company.id} (${company.name}) PAID via ${company.payment_method} (${formatMoney(company.paid_amount, company.paid_currency)}) → /qr/${company.slug}`);

  if (!instances.get(company.id)) {
    instances.start(company).catch((err) => {
      console.error(`❌ Company #${company.id} start error after payment:`, err.message);
    });
  }
  return company;
}

// Stripe Checkout (REST API — no stripe npm dependency needed)
async function createStripeCheckout(company, baseUrl) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured on this server');

  const plan = planOf(company.plan_type);
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('success_url', `${baseUrl}/payment/success?company=${company.id}&session={CHECKOUT_SESSION_ID}`);
  params.set('cancel_url', `${baseUrl}/payment/cancel?company=${company.id}`);
  params.set('client_reference_id', `company-${company.id}`);
  params.set('metadata[company_id]', String(company.id));
  params.set('line_items[0][quantity]', '1');
  params.set('line_items[0][price_data][currency]', plan.currency.toLowerCase());
  params.set('line_items[0][price_data][unit_amount]', String(plan.amount));
  params.set('line_items[0][price_data][product_data][name]', `更容易Eee (ShiftE+) - ${plan.label}`);
  params.set('line_items[0][price_data][product_data][description]',
    '每間公司專屬的 WhatsApp 請假 / 換班排班機器人 + 管理後台（每月訂閱）');

  const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });
  const data = await resp.json();
  if (!resp.ok) {
    const message = data && data.error && data.error.message ? data.error.message : 'Stripe session creation failed';
    throw new Error(message);
  }
  return data;
}

// Verify the Stripe-Signature header (HMAC-SHA256 over "<timestamp>.<rawBody>")
function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!secret) return true; // dev mode: no secret configured, accept and log upstream
  if (!rawBody || !sigHeader) return false;

  const parts = {};
  for (const chunk of String(sigHeader).split(',')) {
    const [k, v] = chunk.split('=');
    if (!k || !v) continue;
    parts[k] = parts[k] ? `${parts[k]},${v}` : v;
  }

  const timestamp = Number(parts.t || 0);
  if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > 300) return false; // 5 min tolerance

  const expected = crypto.createHmac('sha256', secret)
    .update(`${parts.t}.${rawBody.toString('utf8')}`)
    .digest('hex');

  return String(parts.v1 || '').split(',').some((sig) => {
    try {
      return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch (err) {
      return false;
    }
  });
}

// Mock checkout sessions live in memory; recover them from the DB after a restart
async function findCheckoutSession(sessionId) {
  const cached = checkoutSessions.get(sessionId);
  if (cached) return cached;
  const company = await Company.findOne({ where: { payment_reference: sessionId } });
  if (!company) return null;
  return {
    id: sessionId,
    companyId: company.id,
    amount: company.paid_amount,
    currency: company.paid_currency,
    status: company.payment_status
  };
}

function paymentRequiredPage(company) {
  const plan = planOf(company.plan_type);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>尚未付款 - ${company.name}</title>
<style>
  body { font-family: Arial, "Microsoft JhengHei", sans-serif; background: #f0f2f5; padding: 24px; }
  .card { max-width: 460px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 28px; text-align: center; box-shadow: 0 4px 16px rgba(0,0,0,.08); }
  .big { font-size: 46px; }
  .btn { display: inline-block; margin-top: 14px; background: #337ab7; color: #fff; text-decoration: none; padding: 10px 18px; border-radius: 6px; }
</style></head><body>
  <div class="card">
    <div class="big">💳</div>
    <h2>${company.name} 尚未完成付款</h2>
    <p>方案：${plan.label}（${formatMoney(plan.amount, plan.currency)}）</p>
    <p>付款狀態：<strong>${company.payment_status || 'unpaid'}</strong></p>
    <p style="color:#888;font-size:13px">完成付款後，此頁會自動顯示 WhatsApp QR Code。</p>
    <a class="btn" href="/register">前往付款</a>
  </div>
</body></html>`;
}

// ============================================
// Find or create user by phone number
// ============================================
async function findOrCreateUser(phone, companyId, company, branch) {
  const cleanPhone = phone.replace('@c.us', '').replace('@s.whatsapp.net', '');
  
  let user = await User.findOne({ where: { external_id: cleanPhone, company_id: companyId } });
  
  if (!user) {
    const last10 = cleanPhone.slice(-10);
    user = await User.findOne({ where: { phone: { [Sequelize.Op.like]: `%${last10}` }, company_id: companyId } });
  }

  let isNewUser = false;
  if (!user) {
    // Enforce per-plan employee headcount limit (basic plan caps active employees)
    const plan = planOf(company ? company.plan_type : 'starter');
    const max = plan.maxEmployees;
    if (typeof max === 'number' && max > 0) {
      const count = await User.count({ where: { company_id: companyId, role: 'employee', active: true } });
      if (count >= max) {
        console.log(`⛔ [${companyId}] employee cap reached (${count}/${max}) — blocked new user ${cleanPhone}`);
        return { user: null, isNewUser: false, blocked: true, maxEmployees: max, planLabel: plan.label };
      }
    }

    const defaultBranch = branch || await Branch.findOne({ where: { company_id: companyId, is_default: true } });
    user = await User.create({
      name: `User_${cleanPhone.slice(-4)}`,
      phone: cleanPhone,
      external_id: cleanPhone,
      role: 'employee',
      company_id: companyId,
      branch_id: defaultBranch ? defaultBranch.id : null,
      active: true,
      has_paid_leave: false
    });
    console.log(`👤 Auto-created user: ${user.name} (${cleanPhone})`);
    isNewUser = true;
  }

  return { user, isNewUser, blocked: false };
}

// ============================================
// Branch-scoped manager helpers
// ============================================

// Find managers who should be notified for a request (branch-scoped)
async function getRequestManagers(companyId, branchId) {
  if (branchId != null) {
    // Branch managers + company-level managers (branch_id null oversees all branches)
    return User.findAll({
      where: {
        company_id: companyId,
        role: 'manager',
        active: true,
        [Sequelize.Op.or]: [{ branch_id: branchId }, { branch_id: null }]
      }
    });
  }
  return User.findAll({ where: { company_id: companyId, role: 'manager', active: true } });
}

// Whether an acting manager may approve/reject a request (branch-scoped)
async function canManageRequest(managerId, request) {
  if (managerId == null) return true; // legacy / global admin (no actor specified)
  const manager = await User.findByPk(managerId);
  if (!manager || manager.role !== 'manager' || manager.active !== true) return false;
  if (manager.company_id !== request.company_id) return false;
  if (manager.branch_id == null) return true; // company-level manager can manage everything
  return Number(manager.branch_id) === Number(request.branch_id);
}

// Cancel a user's own pending request by ID
async function cancelRequestById(company, user, id, msg) {
  const target = await Request.findOne({ where: { id, company_id: company.id, user_id: user.id } });
  if (!target) {
    await msg.reply(`❌ 搵唔到你嘅申請 #${id}。可用「我的記錄」查返正確編號。`);
    return;
  }
  if (target.status === 'cancelled') {
    await msg.reply(`申請 #${id} 已經取消。`);
    return;
  }
  if (target.status !== 'pending') {
    await msg.reply(`❌ 申請 #${id} 已經${target.status === 'approved' ? '批准' : '拒絕'}，無法取消。請聯絡管理員。`);
    return;
  }
  target.status = 'cancelled';
  await target.save();
  await msg.reply(`✅ 已取消申請 #${id}（${target.type === 'leave' ? '請假' : '換班'}）。`);
}

// ============================================
// Attach message handlers to a company's WhatsApp client
// ============================================
function attachClientHandlers(company, client, branch = null) {
  // Handle incoming messages for this company
  client.on('message', async (msg) => {
    console.log(`📩 [${company.name}] Message received:`, msg.body);

    // Ignore group chats, broadcasts, newsletters and messages sent by this account
    const fromId = msg.from || '';
    if (msg.fromMe || fromId.endsWith('@g.us') || fromId === 'status@broadcast' || fromId.endsWith('@newsletter')) {
      console.log('⏭️  Skip group/broadcast/self message from:', fromId);
      return;
    }

    // Ignore non-text messages (media, stickers, voice notes, etc.)
    if (!msg.body || !msg.body.trim()) {
      console.log('⏭️  Skip text-less message from:', fromId);
      return;
    }

    try {
      const { user, isNewUser, blocked, maxEmployees, planLabel } = await findOrCreateUser(msg.from, company.id, company, branch);

      // Block new employees once the plan's headcount limit is reached
      if (blocked) {
        await client.sendMessage(
          msg.from,
          `⛔ 抱歉，貴公司嘅「*${planLabel}*」方案已達員工人數上限（${maxEmployees} 位）。\n\n` +
          `請聯絡管理員*升級方案*即可新增更多員工，毋須重新開通。`
        );
        return;
      }

      const stateKey = `${company.id}:${user.external_id || user.phone || msg.from}`;

      // Send welcome message to new users
      if (isNewUser && !welcomeSent.has(stateKey)) {
        welcomeSent.add(stateKey);
        setTimeout(async () => {
          try {
            await client.sendMessage(
              msg.from,
              `👋 *歡迎使用排班機器人！*\n\n` +
              `我是您的助理，可以幫您處理以下事項：\n\n` +
              `📋 *請假* - 申請假期\n` +
              `🔄 *換班* - 申請換班\n` +
              `📊 *我的記錄* - 查看申請記錄\n\n` +
              `💡 輸入 *"/指令"* 查看所有可用指令！\n\n` +
              `有任何問題請隨時告訴我。`
            );
            console.log(`📬 Welcome message sent to: ${user.name}`);
          } catch (err) {
            console.error('❌ Error sending welcome message:', err);
          }
        }, 1000);
      }

      // Log the message
      await MessageLog.create({
        company_id: company.id,
        user_id: user.id,
        channel: 'whatsapp',
        direction: 'inbound',
        raw_text: msg.body,
        message_id: msg.id._serialized,
        sender: msg.from,
        branch_id: branch ? branch.id : null
      });

      // Handle conversation flow
      const handled = await handleConversation(company, user, msg, msg.body.trim());

      // Log parsed payload if conversation
      if (handled) {
        const state = conversationState.get(stateKey);
        if (state) {
          await MessageLog.update(
            { parsed_payload: JSON.stringify({ step: state.step, data: state.data }) },
            { where: { message_id: msg.id._serialized } }
          );
        }
      }

    } catch (err) {
      console.error('❌ Error handling message:', err);
    }
  });

  // Handle outgoing messages
  client.on('message_create', async (msg) => {
    if (!msg.fromMe) return;
    try {
      await MessageLog.create({
        company_id: company.id,
        channel: 'whatsapp',
        direction: 'outbound',
        raw_text: msg.body,
        message_id: msg.id._serialized,
        sender: msg.to,
        branch_id: branch ? branch.id : null
      });
    } catch (err) {
      console.error('❌ Error logging outbound message:', err);
    }
  });
}

// ============================================
// Webhook Route
// ============================================
app.post('/webhooks/whatsapp', async (req, res) => {
  try {
    const body = req.body;
    console.log('📩 Received webhook:', body);
    
    const company = body.companyId
      ? await Company.findByPk(body.companyId)
      : await Company.findOne({ order: [['id', 'ASC']] });
    if (!company) {
      return res.status(400).json({ error: 'No company configured' });
    }
    
    await MessageLog.create({
      company_id: company.id,
      channel: 'whatsapp',
      direction: 'inbound',
      raw_text: JSON.stringify(body).slice(0, 1000),
      message_id: body.message_id || null,
      sender: body.sender || null
    });
    
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// ============================================
// ============================================
// Meta WhatsApp Cloud API webhook (migration step 1)
// ============================================

// GET /webhooks/meta - Meta webhook verification handshake
app.get('/webhooks/meta', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const result = cloudApi.verifyWebhook(mode, token, challenge);
  if (result.ok) return res.status(200).send(result.challenge);
  return res.sendStatus(403);
});

// POST /webhooks/meta - receive inbound messages / statuses from Cloud API
app.post('/webhooks/meta', async (req, res) => {
  try {
    if (!cloudApi.isConfigured()) {
      return res.status(503).json({ error: 'Cloud API not configured (META_WHATSAPP_TOKEN / META_PHONE_NUMBER_ID)' });
    }
    const inbound = cloudApi.processWebhook(req.body);
    for (const msg of inbound) {
      console.log(`📩 [Cloud API] inbound from ${msg.from}: ${msg.body}`);
      // TODO: 當入站路徑抽離完成後，喺度改叫 handleInboundMessage(msg)
      await MessageLog.create({ channel: 'whatsapp', direction: 'inbound', raw_text: msg.body, message_id: msg.id, sender: msg.from });
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Cloud API webhook error:', err.message);
    res.sendStatus(500);
  }
});

// Send Message API
// ============================================
app.post('/send', async (req, res) => {
  try {
    const { number, message } = req.body;
    let { companyId } = req.body;
    if (!number || !message) {
      return res.status(400).json({ error: 'Number and message are required' });
    }
    if (!companyId) {
      const ready = instances.list().find((i) => i.status === 'ready');
      if (!ready) {
        return res.status(409).json({ error: 'No WhatsApp instance is connected yet' });
      }
      companyId = ready.companyId;
    }
    const chatId = number.replace(/[^0-9]/g, '') + '@c.us';
    if (!instances.getReadyClient(companyId)) {
      return res.status(409).json({ error: `Company #${companyId} is not connected` });
    }
    await sendToCompany(companyId, chatId, message);
    res.json({ success: true, message: 'Message sent', companyId: Number(companyId) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Status API
// ============================================
app.get('/status', requireAdmin, async (req, res) => {
  try {
    const list = instances.list();
    const ready = list.filter((i) => i.status === 'ready');
    res.json({
      status: ready.length > 0 ? 'connected' : 'disconnected',
      client: ready.length > 0 ? { pushname: ready[0].pushname, wid: ready[0].number } : null,
      companies: list
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Companies API (multi-tenant onboarding)
// ============================================

// POST /api/companies - Register a company and start its QR pairing
app.post('/api/companies', async (req, res) => {
  try {
    const { name, slug } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const planKey = PLANS[req.body && req.body.plan] ? req.body.plan : 'starter';
    const plan = planOf(planKey);
    const company = await Company.create({
      name: String(name).trim(),
      status: 'pending_qr',
      payment_status: 'paid', // admin-created companies bypass billing
      payment_method: 'manual',
      paid_amount: plan.amount,
      paid_currency: plan.currency,
      paid_at: new Date(),
      plan_type: planKey,
      whatsapp_config: '{}',
      line_config: '{}'
    });
    company.slug = await uniqueSlug(slug || company.name, company.id);
    await company.save();
    await ensureCompanyDefaultBranch(company);

    await instances.start(company);
    console.log(`🏢 Company #${company.id} registered (slug: ${company.slug})`);

    res.status(201).json({
      id: company.id,
      name: company.name,
      slug: company.slug,
      status: company.status,
      qrPage: `/qr/${company.slug}`,
      qrApi: `/api/companies/${company.id}/qr`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/companies - List companies with live instance status
app.get('/api/companies', requireAdmin, async (req, res) => {
  try {
    const companies = await Company.findAll({ order: [['id', 'ASC']] });
    const live = new Map(instances.list().map((i) => [i.companyId, i]));
    res.json(companies.map((c) => {
      const inst = live.get(c.id) || null;
      return {
        id: c.id,
        name: c.name,
        slug: c.slug,
        status: c.status,
        active: c.active,
        payment_status: c.payment_status,
        payment_method: c.payment_method,
        payment_reference: c.payment_reference,
        plan_type: c.plan_type,
        plan: planOf(c.plan_type),
        paid_amount: c.paid_amount,
        paid_currency: c.paid_currency,
        paid_at: c.paid_at,
        instance: inst ? {
          status: inst.status,
          number: inst.number,
          pushname: inst.pushname,
          qrUpdatedAt: inst.qrUpdatedAt,
          lastError: inst.lastError
        } : null,
        qrPage: c.slug ? `/qr/${c.slug}` : null
      };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/companies/:id/qr - Latest QR (data URL) for polling / auto-refresh
app.get('/api/companies/:id/qr', async (req, res) => {
  try {
    const company = await Company.findByPk(req.params.id);
    if (!company) return res.status(404).json({ error: 'Company not found' });

    // Unpaid companies do not get a WhatsApp instance (and therefore no QR code)
    if (company.payment_status !== 'paid') {
      return res.json({
        id: company.id,
        name: company.name,
        slug: company.slug,
        status: 'pending_payment',
        paymentStatus: company.payment_status,
        qr: null,
        qrUpdatedAt: null,
        number: null,
        pushname: null,
        lastError: null,
        checkoutHint: `/register`
      });
    }

    if (!instances.get(company.id)) {
      await instances.start(company); // lazy start so the QR page always has a client
    }
    const instance = instances.get(company.id);
    res.json({
      id: company.id,
      name: company.name,
      slug: company.slug,
      status: instance ? instance.status : 'starting',
      paymentStatus: company.payment_status,
      qr: instance ? instance.qr : null,
      qrUpdatedAt: instance ? instance.qrUpdatedAt : null,
      number: instance && instance.info ? instance.info.number : null,
      pushname: instance && instance.info ? instance.info.pushname : null,
      lastError: instance ? instance.lastError : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/companies/:id/restart - Restart the WhatsApp instance
app.post('/api/companies/:id/restart', requireAdmin, async (req, res) => {
  try {
    const company = await Company.findByPk(req.params.id);
    if (!company) return res.status(404).json({ error: 'Company not found' });
    await instances.restart(company);
    res.json({ success: true, qrPage: `/qr/${company.slug}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/companies/:id/logout - Unlink the phone and require a new QR scan
app.post('/api/companies/:id/logout', requireAdmin, async (req, res) => {
  try {
    const company = await Company.findByPk(req.params.id);
    if (!company) return res.status(404).json({ error: 'Company not found' });
    await instances.logout(company);
    res.json({ success: true, status: 'pending_qr' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/companies/:id - Remove a company and stop its instance
app.delete('/api/companies/:id', async (req, res) => {
  try {
    const company = await Company.findByPk(req.params.id);
    if (!company) return res.status(404).json({ error: 'Company not found' });
    await instances.stop(company.id);
    await company.destroy();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Billing API
// ============================================

// GET /api/payment-config - Plans + which payment methods are usable on this server
app.get('/api/payment-config', (req, res) => {
  res.json({
    defaultMethod: String(process.env.DEFAULT_PAYMENT_METHOD || 'mock').toLowerCase(),
    methods: [
      { id: 'mock', label: '測試／示範付款（即時開通）', enabled: true },
      { id: 'stripe', label: '信用卡（Stripe Checkout）', enabled: Boolean(process.env.STRIPE_SECRET_KEY) },
      { id: 'alipayhk', label: 'AlipayHK（轉帳／付款連結）', enabled: Boolean(process.env.ALIPAYHK_PAYMENT_URL) },
      { id: 'payme', label: 'PayMe（付款連結）', enabled: Boolean(process.env.PAYME_PAYMENT_URL) }
    ],
    plans: Object.entries(PLANS).map(([key, p]) => ({
      key,
      label: p.label,
      amount: p.amount,
      currency: p.currency,
      display: formatMoney(p.amount, p.currency),
      maxEmployees: p.maxEmployees ?? null,
      maxBranches: p.maxBranches ?? null
    }))
  });
});

// GET /api/companies/:id - Company detail including billing state
app.get('/api/companies/:id', async (req, res) => {
  try {
    const company = await Company.findByPk(req.params.id);
    if (!company) return res.status(404).json({ error: 'Company not found' });
    const instance = instances.get(company.id);
    res.json({
      id: company.id,
      name: company.name,
      slug: company.slug,
      status: company.status,
      plan_type: company.plan_type,
      plan: planOf(company.plan_type),
      employee_count: await User.count({ where: { company_id: company.id, role: 'employee', active: true } }),
      branch_count: await Branch.count({ where: { company_id: company.id } }),
      branches: await Branch.findAll({ where: { company_id: company.id }, order: [['id', 'ASC']] }),
      payment_status: company.payment_status,
      payment_method: company.payment_method,
      payment_reference: company.payment_reference,
      paid_amount: company.paid_amount,
      paid_currency: company.paid_currency,
      paid_amount_display: company.paid_amount != null ? formatMoney(company.paid_amount, company.paid_currency) : null,
      paid_at: company.paid_at,
      instance: instance ? {
        status: instance.status,
        number: instance.info ? instance.info.number : null,
        pushname: instance.info ? instance.info.pushname : null,
        lastError: instance.lastError
      } : null,
      qrPage: `/qr/${company.slug}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Branches (multi-store) API
// ============================================

// GET /api/branches?company=<id> - list branches for a company
app.get('/api/branches', requireAdmin, async (req, res) => {
  try {
    const companyId = Number(req.query.company || req.query.companyId || 0);
    if (!companyId) return res.status(400).json({ error: 'company is required' });
    const branches = await Branch.findAll({ where: { company_id: companyId }, order: [['id', 'ASC']] });
    const live = new Map(instances.listBranches().map((i) => [i.branchId, i]));
    res.json(branches.map((b) => {
      const cfg = branchConfig(b);
      return { ...b.toJSON(), own_number_enabled: Boolean(cfg.enabled), instance: live.get(b.id) || null };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/branches - create a branch (gated by the company plan's maxBranches)
app.post('/api/branches', requireAdmin, async (req, res) => {
  try {
    const companyId = Number((req.body || {}).companyId || (req.body || {}).company || 0);
    const name = (req.body || {}).name;
    const code = (req.body || {}).code;
    if (!companyId || !name || !String(name).trim()) {
      return res.status(400).json({ error: 'companyId and name are required' });
    }
    const companyRow = await Company.findByPk(companyId);
    if (!companyRow) return res.status(404).json({ error: 'Company not found' });

    const plan = planOf(companyRow.plan_type);
    const current = await Branch.count({ where: { company_id: companyId, active: true } });
    const max = plan.maxBranches;
    if (typeof max === 'number' && max > 0 && current >= max) {
      return res.status(403).json({
        error: `目前嘅「${plan.label}」方案最多支援 ${max} 間分店。請升級專業版以開通多分店。`
      });
    }

    const branch = await Branch.create({ company_id: companyId, name: String(name).trim(), code: code || null, active: true });
    res.status(201).json({ id: branch.id, name: branch.name, code: branch.code, is_default: branch.is_default });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/branches/:id - update / deactivate a branch
app.post('/api/branches/:id', requireAdmin, async (req, res) => {
  try {
    const branch = await Branch.findByPk(req.params.id);
    if (!branch) return res.status(404).json({ error: 'Branch not found' });
    if (req.body.name != null) branch.name = String(req.body.name).trim();
    if (req.body.code != null) branch.code = req.body.code;
    if (req.body.active != null) branch.active = Boolean(req.body.active);
    await branch.save();
    res.json(branch);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Branch dedicated WhatsApp number (pro plan)
// ============================================

// POST /api/branches/:id/number/enable - enable a branch's own number (pro only)
app.post('/api/branches/:id/number/enable', requireAdmin, async (req, res) => {
  try {
    const branch = await Branch.findByPk(req.params.id);
    if (!branch) return res.status(404).json({ error: 'Branch not found' });
    const company = await Company.findByPk(branch.company_id);
    const plan = planOf(company.plan_type);
    if (plan.maxBranches != null) {
      return res.status(403).json({ error: '「分店獨立號碼」只限專業版使用，請升級。' });
    }
    const cfg = branchConfig(branch);
    cfg.enabled = true;
    branch.whatsapp_config = JSON.stringify(cfg);
    await branch.save();
    await instances.startBranch(company, branch);
    res.json({ success: true, qrPage: `/qr/branch/${branch.id}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/branches/:id/number/disable - stop + disable a branch's own number
app.post('/api/branches/:id/number/disable', requireAdmin, async (req, res) => {
  try {
    const branch = await Branch.findByPk(req.params.id);
    if (!branch) return res.status(404).json({ error: 'Branch not found' });
    const cfg = branchConfig(branch);
    cfg.enabled = false;
    branch.whatsapp_config = JSON.stringify(cfg);
    await branch.save();
    await instances.stopBranch(branch.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/branches/:id/qr - current branch QR / status for polling
app.get('/api/branches/:id/qr', async (req, res) => {
  try {
    const branch = await Branch.findByPk(req.params.id);
    if (!branch) return res.status(404).json({ error: 'Branch not found' });
    const instance = instances.getBranch(branch.id);
    res.json({
      status: instance ? instance.status : 'not_started',
      qr: instance ? (instance.qr || null) : null,
      number: instance && instance.info ? instance.info.number : null,
      pushname: instance && instance.info ? instance.info.pushname : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /qr/branch/:id - branch dedicated-number QR pairing page
app.get('/qr/branch/:id', async (req, res) => {
  try {
    const branch = await Branch.findByPk(req.params.id);
    if (!branch) return res.status(404).send('<h2>找不到此分店</h2>');
    const company = await Company.findByPk(branch.company_id);
    if (!instances.getBranch(branch.id)) {
      await instances.startBranch(company, branch).catch(() => {});
    }
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${branch.name} - 分店 WhatsApp 連結</title>
<style>body{font-family:Arial,"Microsoft JhengHei",sans-serif;background:#f0f2f5;margin:0;padding:24px}.card{max-width:460px;margin:0 auto;background:#fff;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.08);padding:24px;text-align:center}h1{font-size:20px;margin:0 0 6px}.sub{color:#888;font-size:13px;margin-bottom:16px}.qr{margin:10px auto;max-width:280px}.qr img{width:100%;border:1px solid #eee;border-radius:8px}#hint{color:#666;font-size:13px}</style></head>
<body><div class="card">
  <h1>${branch.name}</h1>
  <div class="sub">${company.name} · 分店專屬 WhatsApp 號碼</div>
  <div class="qr" id="qrWrap">載入中…</div>
  <div id="hint">請用分店嘅 WhatsApp 掃描 QR Code。</div>
</div>
<script>
  let timer;
  async function poll() {
    try {
      const res = await fetch('/api/branches/${branch.id}/qr');
      const data = await res.json();
      if (data.qr && data.status === 'qr') {
        document.getElementById('qrWrap').innerHTML = '<img src="' + data.qr + '" alt="QR">';
        document.getElementById('hint').textContent = '請用分店嘅 WhatsApp 掃描此 QR Code。';
      } else if (data.status === 'ready') {
        document.getElementById('qrWrap').innerHTML = '✅ 已連結' + (data.number ? '<br>號碼：' + data.number : '');
        document.getElementById('hint').textContent = '此分店已可使用，可關閉此頁。';
        clearInterval(timer);
      } else if (data.status === 'starting' || data.status === 'authenticated') {
        document.getElementById('qrWrap').textContent = '正在初始化…';
      } else {
        document.getElementById('qrWrap').textContent = 'QR Code 生成中…';
      }
    } catch (e) {
      document.getElementById('qrWrap').textContent = '載入失敗，請重新整理。';
    }
  }
  poll();
  timer = setInterval(poll, 4000);
</script>
</body></html>`;
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// ============================================
// Users (employee / manager) management API
// ============================================

// GET /api/users?company=<id>&branch=<id> - list users
app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const companyId = Number(req.query.company || req.query.companyId || 0);
    const branchId = Number(req.query.branch || 0);
    const where = {};
    if (companyId) where.company_id = companyId;
    if (branchId) where.branch_id = branchId;
    const users = await User.findAll({ where, order: [['id', 'ASC']] });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users/:id - update a user (assign manager to branch / change role)
app.post('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (req.body.name != null) user.name = String(req.body.name).trim();
    if (req.body.role != null) user.role = String(req.body.role);
    if (req.body.branch_id !== undefined) user.branch_id = req.body.branch_id == null ? null : Number(req.body.branch_id);
    if (req.body.active != null) user.active = Boolean(req.body.active);
    if (req.body.has_paid_leave != null) user.has_paid_leave = Boolean(req.body.has_paid_leave);
    await user.save();
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/checkout - Create (or reuse) a company and start a payment
// body: { name?, slug?, plan?, method?, companyId? }
app.post('/api/checkout', async (req, res) => {
  try {
    const { companyId, name, slug, plan: planKey, method } = req.body || {};
    const paymentMethod = String(method || process.env.DEFAULT_PAYMENT_METHOD || 'mock').toLowerCase();
    const allowed = ['mock', 'stripe', 'alipayhk', 'payme'];
    if (!allowed.includes(paymentMethod)) {
      return res.status(400).json({ error: `Unsupported payment method: ${paymentMethod}` });
    }

    let company;
    if (companyId) {
      company = await Company.findByPk(companyId);
      if (!company) return res.status(404).json({ error: 'Company not found' });
      if (company.payment_status === 'paid') {
        return res.status(400).json({ error: 'Company already paid', qrPage: `/qr/${company.slug}` });
      }
      if (PLANS[planKey]) {
        company.plan_type = planKey;
        await company.save();
      }
    } else {
      if (!name || !String(name).trim()) {
        return res.status(400).json({ error: 'name is required' });
      }
      company = await Company.create({
        name: String(name).trim(),
        status: 'pending_payment',
        payment_status: 'unpaid',
        plan_type: PLANS[planKey] ? planKey : 'starter',
        whatsapp_config: '{}',
        line_config: '{}'
      });
      company.slug = await uniqueSlug(slug || company.name, company.id);
      await company.save();
      console.log(`🧾 Company #${company.id} registered (awaiting payment, slug: ${company.slug})`);
    }

    await ensureCompanyDefaultBranch(company);
    const plan = planOf(company.plan_type);
    const basePayload = {
      companyId: company.id,
      name: company.name,
      slug: company.slug,
      planType: company.plan_type,
      plan: { label: plan.label, amount: plan.amount, currency: plan.currency, display: formatMoney(plan.amount, plan.currency) }
    };

    if (paymentMethod === 'stripe') {
      if (!process.env.STRIPE_SECRET_KEY) {
        return res.status(400).json({ error: 'STRIPE_SECRET_KEY is not configured on this server' });
      }
      const session = await createStripeCheckout(company, publicBaseUrl(req));
      company.payment_status = 'pending';
      company.payment_method = 'stripe';
      company.payment_reference = session.id;
      company.paid_amount = plan.amount;
      company.paid_currency = plan.currency;
      await company.save();
      return res.status(201).json({ ...basePayload, method: 'stripe', sessionId: session.id, checkoutUrl: session.url });
    }

    if (paymentMethod === 'alipayhk' || paymentMethod === 'payme') {
      const paymentUrl = paymentMethod === 'alipayhk'
        ? process.env.ALIPAYHK_PAYMENT_URL
        : process.env.PAYME_PAYMENT_URL;
      if (!paymentUrl) {
        return res.status(400).json({ error: `${paymentMethod} payment link is not configured on this server` });
      }
      const reference = `${paymentMethod.toUpperCase()}-${company.id}-${Date.now()}`;
      company.payment_status = 'pending';
      company.payment_method = paymentMethod;
      company.payment_reference = reference;
      company.paid_amount = plan.amount;
      company.paid_currency = plan.currency;
      await company.save();
      const brand = paymentMethod === 'alipayhk' ? 'AlipayHK' : 'PayMe';
      return res.status(201).json({
        ...basePayload,
        method: paymentMethod,
        reference,
        checkoutUrl: paymentUrl,
        instructions: `請以 ${brand} 付款 ${formatMoney(plan.amount, plan.currency)}，並在備註填上參考編號 ${reference}。付款後請通知管理員開通。`
      });
    }

    // mock: instant local demo checkout
    const sessionId = crypto.randomBytes(9).toString('hex');
    checkoutSessions.set(sessionId, {
      id: sessionId,
      companyId: company.id,
      planType: company.plan_type,
      amount: plan.amount,
      currency: plan.currency,
      status: 'pending',
      createdAt: new Date()
    });
    company.payment_status = 'pending';
    company.payment_method = 'mock';
    company.payment_reference = sessionId;
    company.paid_amount = plan.amount;
    company.paid_currency = plan.currency;
    await company.save();
    return res.status(201).json({
      ...basePayload,
      method: 'mock',
      sessionId,
      checkoutUrl: `/pay/mock/${sessionId}`,
      instructions: '此為示範付款，按「確認付款」即會立即開通。'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /pay/mock/:sessionId - Demo checkout page (mock provider)
app.get('/pay/mock/:sessionId', async (req, res) => {
  try {
    const session = await findCheckoutSession(req.params.sessionId);
    if (!session) return res.status(404).send('<h2>找不到付款交易</h2>');
    const company = await Company.findByPk(session.companyId);
    if (!company) return res.status(404).send('<h2>找不到公司</h2>');

    const plan = planOf(company.plan_type);
    const amount = formatMoney(session.amount, session.currency);
    const paid = company.payment_status === 'paid';

    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>示範付款 - ${company.name}</title>
<style>
  body { font-family: Arial, "Microsoft JhengHei", sans-serif; background: #f0f2f5; padding: 24px; }
  .card { max-width: 460px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 28px; box-shadow: 0 4px 16px rgba(0,0,0,.08); }
  h2 { margin: 0 0 18px; font-size: 19px; }
  .row { display: flex; justify-content: space-between; padding: 9px 0; border-bottom: 1px dashed #eee; font-size: 14px; }
  .amount { font-size: 30px; font-weight: bold; color: #337ab7; margin: 18px 0; text-align: center; }
  button { width: 100%; background: #5cb85c; color: #fff; border: none; padding: 13px; border-radius: 6px; font-size: 15px; cursor: pointer; margin-top: 10px; }
  a { color: #337ab7; }
  .note { color: #999; font-size: 12px; margin-top: 14px; text-align: center; }
</style></head><body>
  <div class="card">
    <h2>🧪 示範付款（Mock）</h2>
    <div class="row"><span>公司</span><strong>${company.name}</strong></div>
    <div class="row"><span>方案</span><span>${plan.label}</span></div>
    <div class="row"><span>參考編號</span><code>${session.id}</code></div>
    <div class="amount">${amount}</div>
    ${paid
      ? `<p style="text-align:center;color:#5cb85c;font-weight:bold;">✅ 此交易已完成付款</p>
         <p style="text-align:center;"><a href="/qr/${company.slug}">前往 QR Code 頁 →</a></p>`
      : `<form method="POST" action="/pay/mock/${session.id}/confirm">
           <button type="submit">✅ 確認付款（模擬成功）</button>
         </form>`}
    <div class="note">此頁僅用於本地示範，不會產生真實交易。</div>
  </div>
</body></html>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// POST /pay/mock/:sessionId/confirm - Complete the mock payment and provision the bot
app.post('/pay/mock/:sessionId/confirm', async (req, res) => {
  try {
    const session = await findCheckoutSession(req.params.sessionId);
    if (!session) return res.status(404).send('交易不存在');
    const company = await Company.findByPk(session.companyId);
    if (!company) return res.status(404).send('找不到公司');

    await markCompanyPaid(company, {
      method: 'mock',
      reference: session.id,
      amount: session.amount,
      currency: session.currency
    });
    res.redirect(303, `/qr/${company.slug}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// GET /payment/success - Stripe success_url landing (polls until the webhook confirms payment)
app.get('/payment/success', async (req, res) => {
  const companyId = Number(req.query.company || 0);
  const company = companyId ? await Company.findByPk(companyId) : null;
  if (!company) return res.status(404).send('<h2>找不到公司</h2>');
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>付款完成</title>
<style>body{font-family:Arial,"Microsoft JhengHei",sans-serif;background:#f0f2f5;padding:24px}.card{max-width:460px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,.08)}</style>
</head><body><div class="card">
  <h2>✅ 付款完成</h2>
  <p>正在確認付款狀態…</p>
  <p id="msg" style="color:#888;font-size:13px"></p>
  <p><a href="/qr/${company.slug}" id="qrLink" style="display:none;color:#337ab7;">前往 WhatsApp QR Code 頁 →</a></p>
</div>
<script>
  const COMPANY_ID = ${company.id};
  async function check() {
    try {
      const res = await fetch('/api/companies/' + COMPANY_ID, { cache: 'no-store' });
      const data = await res.json();
      if (data.payment_status === 'paid') {
        document.getElementById('msg').textContent = '付款已確認，正在啟動 WhatsApp…';
        document.getElementById('qrLink').style.display = 'inline';
        return true;
      }
      document.getElementById('msg').textContent = '付款狀態：' + (data.payment_status || 'unknown') + '（等待 Stripe 通知）';
    } catch (e) {}
    return false;
  }
  const t = setInterval(async () => { if (await check()) clearInterval(t); }, 3000);
  check();
</script>
</body></html>`);
});

// GET /payment/cancel - Stripe cancel_url landing
app.get('/payment/cancel', (req, res) => {
  res.status(200).send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>付款取消</title>
<style>body{font-family:Arial,"Microsoft JhengHei",sans-serif;background:#f0f2f5;padding:24px}.card{max-width:460px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,.08)}</style>
</head><body><div class="card">
  <h2>付款已取消</h2>
  <p>你可以隨時返回重新付款。</p>
  <p><a href="/register" style="color:#337ab7;">← 返回方案與付款</a></p>
</div></body></html>`);
});

// POST /webhooks/stripe - Stripe webhook (signature verified when STRIPE_WEBHOOK_SECRET is set)
app.post('/webhooks/stripe', async (req, res) => {
  try {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      console.warn('⚠️  STRIPE_WEBHOOK_SECRET not set - accepting Stripe webhook without signature verification');
    } else if (!verifyStripeSignature(req.rawBody, req.headers['stripe-signature'], secret)) {
      console.warn('⚠️  Stripe webhook signature verification FAILED');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const event = req.body || {};
    const type = event.type;
    console.log(`💳 Stripe webhook received: ${type}`);

    if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
      const session = (event.data && event.data.object) || {};
      const fromMetadata = session.metadata && session.metadata.company_id;
      const companyId = fromMetadata || String(session.client_reference_id || '').replace('company-', '');
      const company = companyId ? await Company.findByPk(companyId) : null;

      if (company) {
        await markCompanyPaid(company, {
          method: 'stripe',
          reference: session.id,
          amount: session.amount_total != null ? session.amount_total : planOf(company.plan_type).amount,
          currency: session.currency ? String(session.currency).toUpperCase() : planOf(company.plan_type).currency
        });
      } else {
        console.warn('⚠️  Stripe webhook: no company found for reference', session.client_reference_id);
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/companies/:id/mark-paid - Manually confirm a payment (AlipayHK / PayMe / bank transfer)
// Protected by ADMIN_TOKEN when that env var is set (header: x-admin-token)
app.post('/api/companies/:id/mark-paid', async (req, res) => {
  try {
    const requiredToken = process.env.ADMIN_TOKEN;
    if (requiredToken && req.get('x-admin-token') !== requiredToken) {
      return res.status(401).json({ error: 'Invalid admin token' });
    }
    const company = await Company.findByPk(req.params.id);
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const { method, reference, amount, currency } = req.body || {};
    await markCompanyPaid(company, {
      method: method || company.payment_method || 'manual',
      reference,
      amount: amount != null ? Number(amount) : undefined,
      currency
    });

    res.json({
      success: true,
      company: {
        id: company.id,
        slug: company.slug,
        status: company.status,
        payment_status: company.payment_status,
        payment_method: company.payment_method,
        paid_amount_display: company.paid_amount != null ? formatMoney(company.paid_amount, company.paid_currency) : null
      },
      qrPage: `/qr/${company.slug}`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Requests API (for external management)
// ============================================

// GET /api/requests - JSON list of requests
app.get('/api/requests', requireAdmin, async (req, res) => {
  try {
    const { status, type, branch } = req.query;
    const where = {};
    if (status) where.status = status;
    if (type) where.type = type;
    if (branch) where.branch_id = Number(branch);

    const requests = await Request.findAll({
      where,
      include: [
        { model: User, attributes: ['id', 'name', 'phone', 'role'] },
        { model: User, as: 'targetUser', attributes: ['id', 'name'] },
        { model: Company, attributes: ['id', 'name'] },
        { model: Branch, attributes: ['id', 'name', 'code'] }
      ],
      order: [['createdAt', 'DESC']],
      limit: 200
    });

    res.json(requests);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/requests/:id - Single request detail
app.get('/api/requests/:id', requireAdmin, async (req, res) => {
  try {
    const request = await Request.findByPk(req.params.id, {
      include: [
        { model: User, attributes: ['id', 'name', 'phone', 'role'] },
        { model: User, as: 'targetUser', attributes: ['id', 'name'] },
        { model: Company, attributes: ['id', 'name'] }
      ]
    });
    if (!request) return res.status(404).json({ error: 'Not found' });
    res.json(request);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/requests/:id/approve - Approve a request
app.post('/api/requests/:id/approve', requireAdmin, async (req, res) => {
  try {
    const request = await Request.findByPk(req.params.id, {
      include: [{ model: User }]
    });
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (request.status !== 'pending') {
      return res.status(400).json({ error: `Request already ${request.status}` });
    }

    // Branch-scoped authorization (enforced when an acting manager ID is provided)
    const managerId = req.body.manager_id || null;
    if (managerId && !(await canManageRequest(managerId, request))) {
      return res.status(403).json({ error: '你無權審批此分店嘅申請。' });
    }

    request.status = 'approved';
    request.processed_by = managerId || req.body.processed_by || null;
    await request.save();

    // Notify the user via WhatsApp
    if (request.User && request.User.external_id) {
      const chatId = request.User.external_id.includes('@c.us')
        ? request.User.external_id
        : request.User.external_id + '@c.us';
      
      let msg = '';
      if (request.type === 'leave') {
        msg = `✅ *請假申請已獲批准！*\n\n` +
          `申請編號：#${request.id}\n` +
          `類型：${request.leave_pay_type === 'paid' ? '有薪' : '無薪'} - ${request.leave_category}\n` +
          `日期：${request.date_from ? formatDateChinese(request.date_from) : '-'}\n` +
          `時間：${request.time_slot}\n` +
          `原因：${request.reason || '-'}`;
      } else {
        msg = `✅ *換班申請已獲批准！*\n\n` +
          `申請編號：#${request.id}\n` +
          `日期：${request.date_from ? formatDateChinese(request.date_from) : '-'}\n` +
          `原因：${request.reason || '-'}`;
      }
      await sendToCompany(request.company_id, chatId, msg);
    }

    res.json({ success: true, request });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/requests/:id/reject - Reject a request
app.post('/api/requests/:id/reject', requireAdmin, async (req, res) => {
  try {
    const request = await Request.findByPk(req.params.id, {
      include: [{ model: User }]
    });
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (request.status !== 'pending') {
      return res.status(400).json({ error: `Request already ${request.status}` });
    }

    // Branch-scoped authorization (enforced when an acting manager ID is provided)
    const managerId = req.body.manager_id || null;
    if (managerId && !(await canManageRequest(managerId, request))) {
      return res.status(403).json({ error: '你無權審批此分店嘅申請。' });
    }

    request.status = 'rejected';
    request.processed_by = managerId || req.body.processed_by || null;
    await request.save();

    // Notify the user via WhatsApp
    if (request.User && request.User.external_id) {
      const chatId = request.User.external_id.includes('@c.us')
        ? request.User.external_id
        : request.User.external_id + '@c.us';
      
      let msg = '';
      if (request.type === 'leave') {
        msg = `❌ *請假申請已被拒絕*\n\n` +
          `申請編號：#${request.id}\n` +
          `日期：${request.date_from ? formatDateChinese(request.date_from) : '-'}\n` +
          `原因：${request.reason || '-'}\n\n請聯絡管理員了解詳情。`;
      } else {
        msg = `❌ *換班申請已被拒絕*\n\n` +
          `申請編號：#${request.id}\n` +
          `日期：${request.date_from ? formatDateChinese(request.date_from) : '-'}\n` +
          `原因：${request.reason || '-'}\n\n請聯絡管理員了解詳情。`;
      }
      await sendToCompany(request.company_id, chatId, msg);
    }

    res.json({ success: true, request });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Requests Management Page (HTML)
// ============================================
app.get('/requests', requireAdmin, async (req, res) => {
  try {
    const { status, type, branch } = req.query;
    const where = {};
    if (status) where.status = status;
    if (type) where.type = type;
    if (branch) where.branch_id = Number(branch);

    const requests = await Request.findAll({
      where,
      include: [
        { model: User, attributes: ['id', 'name', 'phone', 'role'] },
        { model: User, as: 'targetUser', attributes: ['id', 'name'] },
        { model: Company, attributes: ['id', 'name'] },
        { model: Branch, attributes: ['id', 'name', 'code'] }
      ],
      order: [['createdAt', 'DESC']],
      limit: 200
    });

    const branches = await Branch.findAll({ include: [{ model: Company, attributes: ['id', 'name'] }], order: [['company_id', 'ASC'], ['id', 'ASC']] });

    const rows = requests.map(r => {
      const user = r.User || {};
      const target = r.targetUser || {};
      const statusBadge = {
        pending: '<span style="color:#fff;background:#f0ad4e;padding:2px 8px;border-radius:4px;">待審核</span>',
        approved: '<span style="color:#fff;background:#5cb85c;padding:2px 8px;border-radius:4px;">已批准</span>',
        rejected: '<span style="color:#fff;background:#d9534f;padding:2px 8px;border-radius:4px;">已拒絕</span>',
        cancelled: '<span style="color:#fff;background:#777;padding:2px 8px;border-radius:4px;">已取消</span>'
      }[r.status] || r.status;

      const typeText = r.type === 'leave'
        ? `請假${r.leave_pay_type ? '(' + (r.leave_pay_type === 'paid' ? '有薪' : '無薪') + ')' : ''}`
        : '換班';

      const categoryText = r.leave_category || '-';
      const doctorText = r.doctor_cert ? '有證明 ✅' : '';
      const branchName = r.Branch ? r.Branch.name : '-';

      const detailCell = r.type === 'leave'
        ? `${categoryText}${doctorText ? '<br>' + doctorText : ''}`
        : (target.name ? `對象: ${target.name}` : '-');

      const actionBtns = r.status === 'pending' ? `
        <button onclick="handleAction(${r.id},'approve')" style="background:#5cb85c;color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;margin:2px;">✅ 批准</button>
        <button onclick="handleAction(${r.id},'reject')" style="background:#d9534f;color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;margin:2px;">❌ 拒絕</button>
      ` : '-';

      const nameCell = r.full_english_name
        ? `${r.full_english_name}<br><small style="color:#999;">${r.work_nickname || ''}</small>`
        : (user.name || '-');

      const dateDisplay = r.date_from
        ? formatDateChinese(r.date_from)
        : '-';

      return `
  <tr>
    <td>#${r.id}</td>
    <td>${nameCell}</td>
    <td>${branchName}</td>
    <td>${typeText}</td>
    <td>${detailCell}</td>
    <td>${dateDisplay}</td>
    <td>${r.time_slot || '-'}</td>
    <td>${r.reason || '-'}</td>
    <td>${statusBadge}</td>
    <td>${actionBtns}</td>
    <td style="font-size:12px;">${new Date(r.createdAt).toLocaleString()}</td>
  </tr>`;
    }).join('');

    const branchOptions = branches.map(b =>
      `<option value="${b.id}" ${branch === String(b.id) ? 'selected' : ''}>${b.name}${b.Company ? '（' + b.Company.name + '）' : ''}</option>`
    ).join('');

    const filterOptions = `
      <select id="statusFilter" onchange="applyFilter()">
        <option value="">全部狀態</option>
        <option value="pending" ${status === 'pending' ? 'selected' : ''}>待審核</option>
        <option value="approved" ${status === 'approved' ? 'selected' : ''}>已批准</option>
        <option value="rejected" ${status === 'rejected' ? 'selected' : ''}>已拒絕</option>
      </select>
      <select id="branchFilter" onchange="applyFilter()">
        <option value="">全部分店</option>
        ${branchOptions}
      </select>
      <select id="typeFilter" onchange="applyFilter()">
        <option value="">全部類型</option>
        <option value="leave" ${type === 'leave' ? 'selected' : ''}>請假</option>
        <option value="swap" ${type === 'swap' ? 'selected' : ''}>換班</option>
      </select>
    `;

    const html = `
  <html>
  <head>
    <meta charset="utf-8">
    <title>排班管理後台</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
      .container { max-width: 100%; margin: 0 auto; background: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
      h2 { color: #333; margin-bottom: 20px; }
      .nav { margin-bottom: 20px; }
      .nav a { margin-right: 15px; color: #337ab7; text-decoration: none; font-weight: bold; }
      .nav a:hover { text-decoration: underline; }
      .filters { margin-bottom: 15px; }
      .filters select { padding: 6px 12px; margin-right: 8px; border: 1px solid #ccc; border-radius: 4px; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th { background: #337ab7; color: #fff; padding: 10px 8px; text-align: left; white-space: nowrap; }
      td { padding: 8px; border-bottom: 1px solid #ddd; vertical-align: top; }
      tr:hover { background: #f0f0f0; }
      .stats { display: flex; gap: 20px; margin-bottom: 20px; flex-wrap: wrap; }
      .stat-card { flex: 1; min-width: 120px; background: #f9f9f9; padding: 15px; border-radius: 6px; text-align: center; border: 1px solid #e0e0e0; }
      .stat-card .num { font-size: 28px; font-weight: bold; color: #337ab7; }
      .stat-card .label { font-size: 13px; color: #666; margin-top: 4px; }
      small { font-size: 11px; }
    </style>
  </head>
  <body>
    <div class="container">
      <h2>📋 排班管理後台</h2>
      
      <div class="nav">
        <a href="/companies">🏢 公司</a>
        <a href="/requests">📋 申請列表</a>
        <a href="/logs">📄 訊息記錄</a>
        <a href="/status">🔌 連線狀態</a>
        <a href="/api/requests">📡 API (JSON)</a>
      </div>

      <div class="stats">
        <div class="stat-card"><div class="num">${requests.filter(r => r.status === 'pending').length}</div><div class="label">待審核</div></div>
        <div class="stat-card"><div class="num">${requests.filter(r => r.status === 'approved').length}</div><div class="label">已批准</div></div>
        <div class="stat-card"><div class="num">${requests.filter(r => r.status === 'rejected').length}</div><div class="label">已拒絕</div></div>
        <div class="stat-card"><div class="num">${requests.length}</div><div class="label">總申請</div></div>
      </div>

      <div class="filters">${filterOptions}</div>

      <table border="1" cellpadding="6" cellspacing="0">
        <thead>
          <tr>
            <th>ID</th><th>申請人</th><th>分店</th><th>類型</th><th>細項</th><th>日期</th><th>時間</th><th>原因/備註</th><th>狀態</th><th>操作</th><th>建立時間</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="11" style="text-align:center;color:#999;">暫無申請記錄</td></tr>'}</tbody>
      </table>
    </div>

    <script>
      async function handleAction(id, action) {
        if (!confirm(\`確定要\${action === 'approve' ? '批准' : '拒絕'}此申請嗎？\`)) return;
        try {
          const res = await fetch(\`/api/requests/\${id}/\${action}\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ processed_by: null })
          });
          const data = await res.json();
          if (data.success) {
            alert('✅ 操作成功！');
            location.reload();
          } else {
            alert('❌ 錯誤：' + (data.error || 'Unknown error'));
          }
        } catch (err) {
          alert('❌ 網路錯誤：' + err.message);
        }
      }

      function applyFilter() {
        const status = document.getElementById('statusFilter').value;
        const branch = document.getElementById('branchFilter').value;
        const type = document.getElementById('typeFilter').value;
        const params = new URLSearchParams();
        if (status) params.set('status', status);
        if (branch) params.set('branch', branch);
        if (type) params.set('type', type);
        window.location.search = params.toString();
      }
    </script>
  </body>
  </html>`;
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// ============================================
// Logs Page
// ============================================
app.get('/logs', requireAdmin, async (req, res) => {
  try {
    const logs = await MessageLog.findAll({
      include: [
        { model: User, attributes: ['id', 'name'] },
        { model: Company, attributes: ['id', 'name'] }
      ],
      order: [['createdAt', 'DESC']],
      limit: 100
    });
    
    const rows = logs.map(l => {
      const user = l.User || {};
      const company = l.Company || {};
      const parsed = l.parsed_payload ? JSON.parse(l.parsed_payload) : null;
      return `
  <tr>
    <td>${l.id}</td>
    <td>${company.name || ''}</td>
    <td>${user.name || l.sender || ''}</td>
    <td>${l.channel || ''}</td>
    <td>${l.direction || ''}</td>
    <td><pre style="white-space:pre-wrap;max-width:300px;margin:0;font-size:12px;">${(l.raw_text||'').replace(/</g,'<').replace(/>/g,'>')}</pre></td>
    <td>${parsed ? `<pre style="margin:0;font-size:11px;color:#666;">${JSON.stringify(parsed, null, 1)}</pre>` : ''}</td>
    <td style="font-size:12px;">${new Date(l.createdAt).toLocaleString()}</td>
  </tr>`;
    }).join('');

    const html = `
  <html>
  <head><meta charset="utf-8"><title>Message Logs</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
      .container { max-width: 100%; margin: 0 auto; background: #fff; padding: 20px; border-radius: 8px; }
      h2 { color: #333; }
      .nav { margin-bottom: 20px; }
      .nav a { margin-right: 15px; color: #337ab7; text-decoration: none; font-weight: bold; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th { background: #337ab7; color: #fff; padding: 10px 8px; text-align: left; white-space: nowrap; }
      td { padding: 6px 8px; border-bottom: 1px solid #ddd; }
      tr:hover { background: #f0f0f0; }
    </style>
  </head>
  <body>
    <div class="container">
      <h2>📄 訊息記錄 (最新 100 筆)</h2>
      <div class="nav">
        <a href="/companies">🏢 公司</a>
        <a href="/requests">📋 申請列表</a>
        <a href="/logs">📄 訊息記錄</a>
        <a href="/status">🔌 連線狀態</a>
      </div>
      <table>
        <thead><tr><th>ID</th><th>公司</th><th>使用者</th><th>頻道</th><th>方向</th><th>內容</th><th>對話狀態</th><th>時間</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="8" style="text-align:center;">暫無記錄</td></tr>'}</tbody>
      </table>
    </div>
  </body>
  </html>`;
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// ============================================
// Companies admin page
// ============================================
app.get('/companies', requireAdmin, async (req, res) => {
  try {
    const companies = await Company.findAll({ order: [['id', 'ASC']] });
    const live = new Map(instances.list().map((i) => [i.companyId, i]));

    const statusBadge = (key) => {
      const map = {
        ready: ['#5cb85c', '已連線'],
        qr: ['#f0ad4e', '等待掃描 QR'],
        starting: ['#999', '啟動中'],
        authenticated: ['#337ab7', '驗證中'],
        disconnected: ['#d9534f', '已斷線'],
        error: ['#d9534f', '錯誤']
      };
      const [color, label] = map[key] || ['#999', key || '未啟動'];
      return `<span style="color:#fff;background:${color};padding:2px 8px;border-radius:4px;font-size:12px;">${label}</span>`;
    };

    const payBadge = (c) => {
      const map = {
        paid: ['#5cb85c', '已付款'],
        pending: ['#f0ad4e', '待確認'],
        refunded: ['#777', '已退款'],
        unpaid: ['#d9534f', '未付款']
      };
      const [color, label] = map[c.payment_status] || ['#999', c.payment_status || '未知'];
      const amount = c.paid_amount != null ? `<br><small>${formatMoney(c.paid_amount, c.paid_currency)}</small>` : '';
      const method = c.payment_method ? `<br><small>${c.payment_method}</small>` : '';
      return `<span style="color:#fff;background:${color};padding:2px 8px;border-radius:4px;font-size:12px;">${label}</span>${amount}${method}`;
    };

    const rows = companies.map((c) => {
      const inst = live.get(c.id);
      return `
  <tr>
    <td>#${c.id}</td>
    <td>${c.name}</td>
    <td><code>${c.slug || '-'}</code></td>
    <td>${c.status}</td>
    <td>${payBadge(c)}</td>
    <td>${statusBadge(inst ? inst.status : '未啟動')}</td>
    <td>${inst && inst.number ? inst.number : '-'}${inst && inst.pushname ? `<br><small>${inst.pushname}</small>` : ''}</td>
    <td>
      <a href="/qr/${c.slug}" style="background:#337ab7;color:#fff;padding:4px 10px;border-radius:4px;text-decoration:none;font-size:12px;">📱 QR 頁</a>
      ${c.payment_status !== 'paid' ? `<button onclick="markPaid(${c.id})" style="background:#5cb85c;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;">💰 標記已付款</button>` : ''}
      <button onclick="companyAction(${c.id},'restart')" style="background:#f0ad4e;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;">♻️ 重啟</button>
      <button onclick="companyAction(${c.id},'logout')" style="background:#d9534f;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;">🚪 登出</button>
      <button onclick="removeCompany(${c.id})" style="background:#777;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;">🗑️ 刪除</button>
    </td>
  </tr>`;
    }).join('');

    const html = `
  <html>
  <head><meta charset="utf-8"><title>公司管理</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
      .container { max-width: 1100px; margin: 0 auto; background: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
      h2 { color: #333; }
      .nav { margin-bottom: 20px; }
      .nav a { margin-right: 15px; color: #337ab7; text-decoration: none; font-weight: bold; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th { background: #337ab7; color: #fff; padding: 10px 8px; text-align: left; white-space: nowrap; }
      td { padding: 8px; border-bottom: 1px solid #ddd; vertical-align: middle; }
      tr:hover { background: #f0f0f0; }
      .create-box { background: #f9f9f9; border: 1px solid #e0e0e0; border-radius: 6px; padding: 15px; margin-bottom: 20px; }
      .create-box input { padding: 8px; width: 280px; border: 1px solid #ccc; border-radius: 4px; }
      .create-box button { background: #5cb85c; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; margin-left: 8px; }
    </style>
  </head>
  <body>
    <div class="container">
      <h2>🏢 公司管理（多租戶）</h2>
      <div class="nav">
        <a href="/companies">🏢 公司</a>
        <a href="/requests">📋 申請列表</a>
        <a href="/logs">📄 訊息記錄</a>
        <a href="/status">🔌 連線狀態</a>
        <a href="/register">💳 方案與付款</a>
      </div>

      <div class="create-box">
        <strong>管理員直接開通（不經付款）：</strong><br><br>
        <input id="companyName" placeholder="公司名稱，例如：ABC 茶餐廳">
        <button onclick="createCompany()">➕ 建立並產生 QR Code</button>
        <div id="createResult" style="margin-top:10px;"></div>
      </div>

      <table>
        <thead><tr><th>ID</th><th>公司</th><th>Slug</th><th>DB 狀態</th><th>付款</th><th>WhatsApp 狀態</th><th>號碼 / 名稱</th><th>操作</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="8" style="text-align:center;color:#999;">暫無公司</td></tr>'}</tbody>
      </table>
    </div>

    <script>
      async function createCompany() {
        const name = document.getElementById('companyName').value.trim();
        if (!name) { alert('請輸入公司名稱'); return; }
        const out = document.getElementById('createResult');
        out.textContent = '建立中，正在啟動 WhatsApp 實例…';
        try {
          const res = await fetch('/api/companies', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || '建立失敗');
          out.innerHTML = '✅ 已建立！<a href="' + data.qrPage + '">前往掃描 QR Code →</a>';
          setTimeout(() => location.reload(), 1500);
        } catch (err) {
          out.textContent = '❌ ' + err.message;
        }
      }

      async function companyAction(id, action) {
        if (!confirm('確定要執行 ' + action + ' 嗎？')) return;
        try {
          const res = await fetch('/api/companies/' + id + '/' + action, { method: 'POST' });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || '操作失敗');
          alert('✅ 完成');
          location.reload();
        } catch (err) {
          alert('❌ ' + err.message);
        }
      }

      async function markPaid(id) {
        if (!confirm('確定標記公司 #' + id + ' 為已付款？將自動開通 WhatsApp QR Code。')) return;
        try {
          const res = await fetch('/api/companies/' + id + '/mark-paid', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method: 'manual' })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || '操作失敗');
          alert('✅ 已標記付款並開始開通');
          location.reload();
        } catch (err) {
          alert('❌ ' + err.message);
        }
      }

      async function removeCompany(id) {
        if (!confirm('確定刪除公司 #' + id + '？此操作無法復原。')) return;
        try {
          const res = await fetch('/api/companies/' + id, { method: 'DELETE' });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || '刪除失敗');
          location.reload();
        } catch (err) {
          alert('❌ ' + err.message);
        }
      }
    </script>
  </body>
  </html>`;
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// ============================================
// Public registration / pricing page
// ============================================
app.get('/register', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>更容易Eee (ShiftE+) - 方案與付款</title>
  <style>
    body { font-family: Arial, "Microsoft JhengHei", sans-serif; margin: 0; background: #f0f2f5; color: #333; }
    .hero { background: linear-gradient(135deg, #128c7e, #075e54); color: #fff; padding: 40px 20px; text-align: center; }
    .hero h1 { margin: 0 0 8px; font-size: 28px; }
    .hero p { margin: 0; opacity: .85; }
    .wrap { max-width: 880px; margin: -28px auto 40px; padding: 0 16px; }
    .card { background: #fff; border-radius: 12px; padding: 26px; box-shadow: 0 4px 16px rgba(0,0,0,.08); }
    h2 { font-size: 19px; margin: 0 0 18px; }
    .plans { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 22px; }
    .plan { flex: 1; min-width: 220px; border: 2px solid #e5e5e5; border-radius: 10px; padding: 18px; cursor: pointer; }
    .plan.selected { border-color: #128c7e; background: #f2fbf9; }
    .plan .name { font-weight: bold; margin-bottom: 6px; }
    .plan .price { font-size: 26px; color: #128c7e; font-weight: bold; }
    label { display: block; font-size: 13px; color: #666; margin: 14px 0 6px; }
    input, select { width: 100%; box-sizing: border-box; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; }
    button { margin-top: 20px; width: 100%; background: #128c7e; color: #fff; border: none; padding: 13px; border-radius: 6px; font-size: 15px; cursor: pointer; }
    button:disabled { background: #aaa; cursor: not-allowed; }
    #result { margin-top: 18px; font-size: 14px; line-height: 1.7; }
    .note { color: #999; font-size: 12px; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="hero">
    <a href="/" style="color:rgba(255,255,255,.9);text-decoration:none;font-size:13px;display:inline-block;margin-bottom:12px;">← 回到 shifteee.com 主頁</a>
    <h1>更容易Eee <span style="font-weight:normal;opacity:.85;font-size:20px;">(ShiftE+)</span></h1>
    <p>WhatsApp 排班／請假系統 — 為每間公司提供專屬機器人與 QR Code</p>
  </div>
  <div class="wrap">
    <div class="card">
      <h2>選擇方案並完成付款</h2>
      <div class="plans" id="plans"></div>

      <label>公司名稱</label>
      <input id="companyName" placeholder="例如：ABC 茶餐廳">

      <label>專屬網址代號（可留空自動產生）</label>
      <input id="companySlug" placeholder="例如：abc-tea">

      <label>付款方式</label>
      <select id="method"></select>

      <button id="payBtn" onclick="startCheckout()">前往付款</button>
      <div id="result"></div>
      <div class="note">付款成功後會自動開通並顯示 WhatsApp QR Code 連結。<br>查詢／補付款：管理員可在「公司管理」頁面標記已付款。<br><a href="/requests" style="color:#128c7e;">管理員登入 → shifteee.com/requests</a></div>
    </div>
  </div>

<script>
  let config = null;
  let selectedPlan = 'starter';

  function renderPlans() {
    const wrap = document.getElementById('plans');
    wrap.innerHTML = config.plans.map(function (p) {
      return '<div class="plan' + (p.key === selectedPlan ? ' selected' : '') + '" data-key="' + p.key + '" onclick="selectPlan(\\'' + p.key + '\\')">' +
        '<div class="name">' + p.label + '</div>' +
        '<div class="price">' + p.display + '<span style="font-size:13px;color:#888;"> /月</span></div>' +
        '<div class="note">WhatsApp 排班機器人 + 管理後台' + (p.maxEmployees ? '（最多 ' + p.maxEmployees + ' 名員工）' : '（員工人數不限）') + '</div>' +
      '</div>';
    }).join('');
  }

  function selectPlan(key) {
    selectedPlan = key;
    renderPlans();
  }

  function renderMethods() {
    const sel = document.getElementById('method');
    sel.innerHTML = config.methods.map(function (m) {
      return '<option value="' + m.id + '"' + (m.enabled ? '' : ' disabled') + (m.id === config.defaultMethod ? ' selected' : '') + '>' +
        m.label + (m.enabled ? '' : '（未設定）') + '</option>';
    }).join('');
  }

  async function startCheckout() {
    const name = document.getElementById('companyName').value.trim();
    const slug = document.getElementById('companySlug').value.trim();
    const method = document.getElementById('method').value;
    const result = document.getElementById('result');
    const btn = document.getElementById('payBtn');

    if (!name) { alert('請輸入公司名稱'); return; }
    btn.disabled = true;
    result.textContent = '正在建立付款…';
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, slug: slug || undefined, plan: selectedPlan, method: method })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '建立付款失敗');

      if (data.method === 'mock' || data.method === 'stripe') {
        result.innerHTML = '✅ 已建立付款，正在跳轉…';
        window.location.href = data.checkoutUrl;
        return;
      }

      result.innerHTML =
        '📌 付款金額：<strong>' + data.plan.display + '</strong><br>' +
        '參考編號：<code>' + data.reference + '</code><br>' +
        (data.instructions || '') +
        '<br><a href="' + data.checkoutUrl + '" target="_blank" rel="noopener">前往付款頁 →</a>' +
        '<br><span class="note">付款完成後，請把參考編號通知管理員開通（管理員按「標記已付款」）。</span>';
      btn.disabled = false;
    } catch (err) {
      result.textContent = '❌ ' + err.message;
      btn.disabled = false;
    }
  }

  (async function init() {
    try {
      const res = await fetch('/api/payment-config');
      config = await res.json();
      const urlPlan = new URLSearchParams(window.location.search).get('plan');
      selectedPlan = (urlPlan && config.plans.some(function (p) { return p.key === urlPlan; }))
        ? urlPlan
        : (config.plans.length ? config.plans[0].key : 'starter');
      renderPlans();
      renderMethods();
    } catch (err) {
      document.getElementById('result').textContent = '❌ 無法載入付款設定：' + err.message;
    }
  })();
</script>
</body>
</html>`);
});

// ============================================
// Per-company QR pairing page (auto-refreshing)
// ============================================
app.get('/qr/:slug', async (req, res) => {
  try {
    const company = await Company.findOne({ where: { slug: req.params.slug } });
    if (!company) {
      return res.status(404).send('<h2>找不到此公司</h2><p>請確認 QR Code 連結是否正確。</p>');
    }
    if (company.payment_status !== 'paid') {
      return res.status(402).send(paymentRequiredPage(company));
    }
    if (!instances.get(company.id)) {
      await instances.start(company); // lazy start so the page always has a client
    }

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${company.name} - WhatsApp 連結</title>
  <style>
    body { font-family: Arial, "Microsoft JhengHei", sans-serif; margin: 0; padding: 24px; background: #f0f2f5; }
    .card { max-width: 460px; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.08); padding: 24px; text-align: center; }
    h1 { font-size: 20px; color: #333; margin: 0 0 6px; }
    .sub { color: #888; font-size: 13px; margin-bottom: 18px; }
    #status { display: inline-block; padding: 6px 14px; border-radius: 20px; font-size: 13px; color: #fff; background: #999; margin-bottom: 16px; }
    .qr-wrap { min-height: 300px; display: flex; align-items: center; justify-content: center; flex-direction: column; }
    .qr-wrap img { width: 280px; height: 280px; image-rendering: pixelated; }
    .hint { color: #666; font-size: 13px; line-height: 1.7; margin-top: 12px; }
    .big { font-size: 46px; margin: 24px 0 8px; }
    button { border: none; border-radius: 6px; padding: 9px 16px; font-size: 13px; cursor: pointer; margin: 6px 4px 0; color: #fff; }
    .btn-blue { background: #337ab7; }
    .btn-orange { background: #f0ad4e; }
    .btn-red { background: #d9534f; }
    .btn-gray { background: #888; }
    .refresh-note { color: #aaa; font-size: 12px; margin-top: 18px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${company.name}</h1>
    <div class="sub">WhatsApp 連結（每 4 秒自動更新）</div>
    <div id="status">載入中…</div>
    <div class="qr-wrap" id="qrWrap">
      <div class="big">⏳</div>
      <div class="hint">正在啟動 WhatsApp，請稍候…</div>
    </div>
    <div class="hint" id="hint"></div>
    <div>
      <button class="btn-orange" onclick="restartInstance()">♻️ 重新產生 QR</button>
      <button class="btn-red" onclick="logoutInstance()">🚪 登出此號碼</button>
    </div>
    <div class="refresh-note">此頁面會自動更新，無需手動重新整理</div>
  </div>

  <script>
    const COMPANY_ID = ${company.id};
    const SLUG = ${JSON.stringify(company.slug)};
    const statusEl = document.getElementById('status');
    const qrWrap = document.getElementById('qrWrap');
    const hintEl = document.getElementById('hint');
    let lastQr = null;
    let timer = null;

    const LABELS = {
      starting: ['#999', '啟動中…'],
      qr: ['#f0ad4e', '等待掃描'],
      authenticated: ['#337ab7', '驗證中…'],
      ready: ['#5cb85c', '已連線'],
      disconnected: ['#d9534f', '已斷線'],
      error: ['#d9534f', '發生錯誤']
    };

    function render(data) {
      const [color, label] = LABELS[data.status] || ['#999', data.status];
      statusEl.textContent = label;
      statusEl.style.background = color;

      if (data.status === 'qr' && data.qr) {
        if (data.qr !== lastQr) {
          lastQr = data.qr;
          qrWrap.innerHTML = '<img src="' + data.qr + '" alt="WhatsApp QR Code">';
        }
        hintEl.textContent = '請開啟 WhatsApp → 設定 → 已連結的裝置 → 連結裝置，然後掃描上方 QR Code。';
      } else if (data.status === 'ready') {
        qrWrap.innerHTML = '<div class="big">✅</div><div class="hint">WhatsApp 已成功連結' +
          (data.number ? '<br>號碼：' + data.number : '') +
          (data.pushname ? '<br>名稱：' + data.pushname : '') + '</div>';
        hintEl.textContent = '此公司已可使用排班機器人，可關閉此頁。';
        if (timer) { clearInterval(timer); timer = null; }
      } else if (data.status === 'authenticated') {
        qrWrap.innerHTML = '<div class="big">🔐</div><div class="hint">已掃描成功，正在載入 WhatsApp 資料…</div>';
        hintEl.textContent = '';
      } else if (data.status === 'disconnected' || data.status === 'error') {
        qrWrap.innerHTML = '<div class="big">⚠️</div><div class="hint">連線已中斷</div>';
        hintEl.textContent = data.lastError || '請按「重新產生 QR」重新連結。';
      } else {
        qrWrap.innerHTML = '<div class="big">⏳</div><div class="hint">正在啟動 WhatsApp，請稍候…</div>';
        hintEl.textContent = '';
      }
    }

    async function poll() {
      try {
        const res = await fetch('/api/companies/' + COMPANY_ID + '/qr', { cache: 'no-store' });
        const data = await res.json();
        if (res.ok) render(data);
      } catch (err) {
        statusEl.textContent = '連線到伺服器失敗';
        statusEl.style.background = '#d9534f';
      }
    }

    async function restartInstance() {
      if (!confirm('確定要重新啟動並產生新的 QR Code？')) return;
      try {
        await fetch('/api/companies/' + COMPANY_ID + '/restart', { method: 'POST' });
        lastQr = null;
        if (!timer) timer = setInterval(poll, 4000);
        poll();
      } catch (err) { alert('重新啟動失敗：' + err.message); }
    }

    async function logoutInstance() {
      if (!confirm('確定要登出此 WhatsApp 號碼？需要重新掃描 QR Code 才能再次使用。')) return;
      try {
        await fetch('/api/companies/' + COMPANY_ID + '/logout', { method: 'POST' });
        lastQr = null;
        if (!timer) timer = setInterval(poll, 4000);
        poll();
      } catch (err) { alert('登出失敗：' + err.message); }
    }

    poll();
    timer = setInterval(poll, 4000);
  </script>
</body>
</html>`;
    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// ============================================
// Public marketing website (static assets)
// ============================================
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// Landing page
// ============================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// Start Server
// ============================================
const start = async () => {
  try {
    await sequelize.sync();
    console.log('✅ Database synced');
    
    await ensureSchemaUpgrades();
    await seedDefaultData();
    await normalizePlanTypes();
    await ensureDefaultBranches();
    
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
      console.log(`✅ Server running on http://localhost:${port}`);
      console.log(`📋 Requests admin: http://localhost:${port}/requests`);
      console.log(`📄 Message logs: http://localhost:${port}/logs`);
      console.log(`🏢 Companies admin: http://localhost:${port}/companies`);
      console.log(`🔌 Status: http://localhost:${port}/status`);
    });
    
    // Resume WhatsApp for every active company. Companies without a saved
    // session will emit a QR code that is served on /qr/<slug>
    const activeCompanies = await Company.findAll({ where: { status: 'active' } });
    console.log(`🔄 Starting WhatsApp instances for ${activeCompanies.length} active company(ies)...`);
    for (const company of activeCompanies) {
      if (!company.slug) {
        company.slug = await uniqueSlug(company.name, company.id);
        await company.save();
      }
      instances.start(company).catch((err) => {
        console.error(`❌ Company #${company.id} start error:`, err.message);
      });
    }

    // Resume branch-owned WhatsApp numbers (pro plan, enabled)
    const branches = await Branch.findAll({ where: { active: true } });
    for (const branch of branches) {
      if (branchConfig(branch).enabled) {
        const company = await Company.findByPk(branch.company_id);
        if (company && company.status === 'active') {
          instances.startBranch(company, branch).catch((err) => {
            console.error(`❌ Branch #${branch.id} start error:`, err.message);
          });
        }
      }
    }
  } catch (err) {
    console.error('❌ Startup error:', err);
    process.exit(1);
  }
};

// Graceful shutdown so Chromium child processes are not left running
async function shutdown(signal) {
  console.log(`\n🛑 ${signal} received, stopping WhatsApp instances...`);
  // Hard stop safety net: never hang forever on a broken browser session
  const forceExit = setTimeout(() => {
    console.error('⚠️  Shutdown timed out, forcing exit');
    process.exit(1);
  }, 10000);
  forceExit.unref();
  try {
    await instances.stopAll();
  } catch (err) {
    console.error('❌ Error during shutdown:', err.message);
  }
  clearTimeout(forceExit);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();