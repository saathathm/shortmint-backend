module.exports = {
  apps: [{
    name: 'shortmint-backend',
    script: 'index.js',
    cwd: '/root/shortmint-backend',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3001
    },
    error_file: '/root/shortmint-backend/logs/error.log',
    out_file: '/root/shortmint-backend/logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
}
