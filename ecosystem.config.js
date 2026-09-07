const path = require('path')

module.exports = {
  apps: [{
    name: 'shorttrim-backend',
    script: 'index.js',
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    kill_timeout: 5000,
    listen_timeout: 8000,
    env: {
      NODE_ENV: 'production',
      PORT: 3001
    },
    error_file: path.join(__dirname, 'logs', 'error.log'),
    out_file: path.join(__dirname, 'logs', 'out.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true
  }]
}
