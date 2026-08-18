// PM2 process file: pm2 start ecosystem.config.js
// NOTE: cwd is set to backend/ so dotenv picks up backend/.env correctly.
const path = require('path');
module.exports = {
  apps: [{
    name: 'premier-erp',
    script: 'server.js',
    cwd: path.join(__dirname, 'backend'),
    instances: 1,
    autorestart: true,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      PORT: 5050,
      // JWT_KEY: 'set-a-long-random-secret-here',   // required in production
      // DB_HOST: 'localhost',
      // DB_USER: 'root',
      // DB_PASSWORD: 'set-the-mysql-password',
      // DB_NAME: 'ptis_erp_db',                      // same database iso-server-backend-PTIS uses
      // CORS_ORIGIN: '',                              // only needed if another domain calls this API directly
    }
  }]
};
