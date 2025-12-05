const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = 2024;
const USER_DATA_DIR = path.join(__dirname, 'user_data');
if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR);

// Chỉ chạy lệnh này nếu là Linux/Mac. Nếu Windows hãy comment dòng này lại.
// exec(`fuser -k ${PORT}/tcp`, (err) => {
//    if(!err) console.log(`[SERVER] Killed old process on port ${PORT}`);
// });

function getSafeFileName(username) {
    return username.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-username');
    
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = req.url;

    // 1. Phục vụ file giao diện (UI)
    if (url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, c) => {
            if (err) { 
                res.writeHead(500); 
                res.end('Loi: Khong tim thay file index.html trong thu muc nay.'); 
                return; 
            }
            res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(c);
        });
        return;
    }

    // 2. Xử lý API
    if (req.method === 'POST' || req.method === 'GET') {
        let body = '';
        if (req.method === 'POST') {
            req.on('data', c => body += c);
            await new Promise(r => req.on('end', r));
        }

        try {
            if (url === '/bot-api/register') {
                const { username, password, email } = JSON.parse(body);
                const p = path.join(USER_DATA_DIR, `${getSafeFileName(username)}_config.json`);
                if (fs.existsSync(p)) { 
                    res.writeHead(400); res.end(JSON.stringify({success:false, message: "User exists"})); 
                } else {
                    fs.writeFileSync(p, JSON.stringify({username, password, email, vipStatus: 'none', savedTotalAssets: 0, forceStart: false}, null, 2));
                    res.end(JSON.stringify({success:true}));
                }
                return;
            }

            if (url === '/bot-api/login') {
                const { username, password } = JSON.parse(body);
                const p = path.join(USER_DATA_DIR, `${getSafeFileName(username)}_config.json`);
                if (!fs.existsSync(p)) {
                    res.writeHead(401); res.end(JSON.stringify({success:false}));
                } else {
                    const c = JSON.parse(fs.readFileSync(p));
                    if (c.password === password) {
                        res.end(JSON.stringify({success:true}));
                    } else {
                        res.writeHead(401); res.end(JSON.stringify({success:false}));
                    }
                }
                return;
            }

            // Các API cần xác thực username
            const username = req.headers['x-username'];
            if (!username) { res.writeHead(401); res.end(JSON.stringify({success:false})); return; }
            
            const safeUser = getSafeFileName(username);
            const configFile = path.join(USER_DATA_DIR, `${safeUser}_config.json`);
            const statusFile = path.join(USER_DATA_DIR, `${safeUser}_status.json`);
            const pm2Name = `bot_${safeUser}`;
            const botScriptPath = path.resolve(__dirname, 'botfd.js');

            if (url === '/bot-api/start') {
                const payload = JSON.parse(body);
                let currentConfig = {};
                if (fs.existsSync(configFile)) currentConfig = JSON.parse(fs.readFileSync(configFile));
                currentConfig.tradeConfig = payload.tradeConfig;
                if(payload.autoBalance !== undefined) currentConfig.autoBalance = payload.autoBalance;
                
                currentConfig.forceStart = true;
                fs.writeFileSync(configFile, JSON.stringify(currentConfig, null, 2));

                // Lưu ý: Cần cài đặt PM2 trước (npm install pm2 -g)
                exec(`pm2 start "${botScriptPath}" --name ${pm2Name} -- "${username}"`, (err) => {
                    if (err) {
                        exec(`pm2 restart ${pm2Name}`, (err2) => {
                            if(err2) res.end(JSON.stringify({ success: false, message: err2.message }));
                            else res.end(JSON.stringify({ success: true, message: 'Bot restarted.' }));
                        });
                    } else {
                        res.end(JSON.stringify({ success: true, message: 'Bot started.' }));
                    }
                });
            }
            else if (url === '/bot-api/stop') {
                exec(`pm2 stop ${pm2Name}`, () => {
                    if(fs.existsSync(statusFile)) {
                        const s = JSON.parse(fs.readFileSync(statusFile));
                        s.botState = 'STOPPED';
                        fs.writeFileSync(statusFile, JSON.stringify(s, null, 2));
                    }
                    res.end(JSON.stringify({ success: true }));
                });
            }
            else if (url === '/bot-api/upgrade-vip') {
                let currentConfig = {};
                if (fs.existsSync(configFile)) currentConfig = JSON.parse(fs.readFileSync(configFile));
                currentConfig.vipStatus = 'vip';
                currentConfig.vipExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
                fs.writeFileSync(configFile, JSON.stringify(currentConfig, null, 2));
                exec(`pm2 restart ${pm2Name}`, () => res.end(JSON.stringify({ success: true })));
            }
            else if (url === '/bot-api/save-config') {
                let currentConfig = {};
                if (fs.existsSync(configFile)) currentConfig = JSON.parse(fs.readFileSync(configFile));
                const newConfig = JSON.parse(body);
                const finalConfig = { ...currentConfig, ...newConfig };
                fs.writeFileSync(configFile, JSON.stringify(finalConfig, null, 2));
                exec(`pm2 restart ${pm2Name}`, () => res.end(JSON.stringify({ success: true })));
            }
            else if (url === '/bot-api/status') {
                if (fs.existsSync(statusFile)) {
                    const status = JSON.parse(fs.readFileSync(statusFile));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(status));
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ botState: 'STOPPED', username: username }));
                }
            }
            else if (url === '/bot-api/config') {
                if (fs.existsSync(configFile)) {
                    const c = JSON.parse(fs.readFileSync(configFile));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(c));
                } else { res.end('{}'); }
            }
            else if (url === '/bot-api/update-balance-config') {
                let currentConfig = {};
                if (fs.existsSync(configFile)) currentConfig = JSON.parse(fs.readFileSync(configFile));
                const cfg = JSON.parse(body);
                currentConfig.autoBalance = cfg.autoBalance;
                fs.writeFileSync(configFile, JSON.stringify(currentConfig, null, 2));
                res.end(JSON.stringify({ success: true }));
            }
            else { 
                res.writeHead(404); res.end('Not Found'); 
            }

        } catch (e) { 
            console.error(e);
            res.writeHead(500); res.end(JSON.stringify({success:false, message:e.message})); 
        }
    }
});

server.listen(PORT, () => {
    console.log(`[SERVER] MANAGER RUNNING ON PORT ${PORT}`);
    console.log(`Truy cap tai: http://localhost:${PORT}`);
});
