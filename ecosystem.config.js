module.exports = {
  apps: [{
    name: 'shorttrim-backend',
    script: 'index.js',
    cwd: '/root/shorttrim-backend',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3001
    },
    error_file: '/root/shorttrim-backend/logs/error.log',
    out_file: '/root/shorttrim-backend/logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
}
