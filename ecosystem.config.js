// PM2 進程設定 — 更容易Eee (ShiftE+)
// 用法：pm2 start ecosystem.config.js
// 環境變數（ADMIN_TOKEN、PUBLIC_BASE_URL、Stripe…）喺 .env 填（dotenv 自動載入）

module.exports = {
  apps: [
    {
      name: 'shifteee',
      script: 'index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1G',   // 防 Chromium 記憶體爆
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};