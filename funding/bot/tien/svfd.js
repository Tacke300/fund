const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = 2025;
const USER_DATA_DIR = path.join(__dirname, 'user_data');
if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR);

function getSafeFileName(username) {
    return username.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

function logServer(username, action, details = '') {
    const t = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const userStr = username ? `[USER: ${username}]` : '[GUEST]';
    console.log(`[${t}] [SERVER] ${userStr} ${action} ${details}`);
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-username');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = req.url;
    
    if (url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, c) => {
            if (err) { res.writeHead(500); res.end('UI Error'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(c);
        });
        return;
    }

    if (req.method === 'POST' || req.method === 'GET') {
        let body = '';
        if (req.method === 'POST') {
            req.on('data', c => body += c);
            await new Promise(r => req.on('end', r));
        }

        if (url === '/bot-api/register') {
            try {
                const { username, password, email } = JSON.parse(body);
                logServer(username, 'REGISTER', `Email: ${email}`);
                const p = path.join(USER_DATA_DIR, `${getSafeFileName(username)}_config.json`);
                if (fs.existsSync(p)) { 
                    res.writeHead(400); res.end(JSON.stringify({success:false})); 
                } else {
                    fs.writeFileSync(p, JSON.stringify({username, password, email, vipStatus: 'none', savedTotalAssets: 0}, null, 2));
                    res.end(JSON.stringify({success:true}));
                }
            } catch(e) { res.writeHead(500); res.end(JSON.stringify({success:false})); }
            return;
        }

        if (url === '/bot-api/login') {
            try {
                const { username, password } = JSON.parse(body);
                const p = path.join(USER_DATA_DIR, `${getSafeFileName(username)}_config.json`);
                if (!fs.existsSync(p)) {
                    logServer(username, 'LOGIN FAIL', 'User not found');
                    res.writeHead(401); res.end(JSON.stringify({success:false}));
                } else {
                    const c = JSON.parse(fs.readFileSync(p));
                    if (c.password === password) {
                        logServer(username, 'LOGIN SUCCESS');
                        res.end(JSON.stringify({success:true}));
                    } else {
                        logServer(username, 'LOGIN FAIL', 'Wrong pass');
                        res.writeHead(401); res.end(JSON.stringify({success:false}));
                    }
                }
            } catch(e) { res.writeHead(500); res.end(JSON.stringify({success:false})); }
            return;
        }

        const username = req.headers['x-username'];
        if (!username) { res.writeHead(401); res.end(JSON.stringify({success:false})); return; }
        
        const safeUser = getSafeFileName(username);
        const configFile = path.join(USER_DATA_DIR, `${safeUser}_config.json`);
        const statusFile = path.join(USER_DATA_DIR, `${safeUser}_status.json`);
        const pm2Name = `bot_${safeUser}`;
        const botScriptPath = path.resolve(__dirname, 'botfd.js');

        try {
            if (url === '/bot-api/start') {
                const payload = JSON.parse(body);
                logServer(username, 'CMD: START', `Mode: ${payload.tradeConfig?.mode}`);
                
                let currentConfig = {};
                if (fs.existsSync(configFile)) currentConfig = JSON.parse(fs.readFileSync(configFile));
                currentConfig.tradeConfig = payload.tradeConfig;
                if(payload.autoBalance !== undefined) currentConfig.autoBalance = payload.autoBalance;
                
                currentConfig.forceStart = true;

                fs.writeFileSync(configFile, JSON.stringify(currentConfig, null, 2));

                exec(`pm2 start "${botScriptPath}" --name ${pm2Name} -- "${username}"`, (err, stdout, stderr) => {
                    if (err) {
                        logServer(username, 'PM2', 'Process exists, restarting...');
                        exec(`pm2 restart ${pm2Name}`, (err2) => {
                            if(err2) {
                                logServer(username, 'ERROR START', err2.message);
                                res.end(JSON.stringify({ success: false, message: err2.message }));
                            } else {
                                res.end(JSON.stringify({ success: true, message: 'Bot restarted.' }));
                            }
                        });
                    } else {
                        logServer(username, 'PM2', 'Process created successfully');
                        res.end(JSON.stringify({ success: true, message: 'Bot started.' }));
                    }
                });
            }

            else if (url === '/bot-api/stop') {
                logServer(username, 'CMD: STOP');
                exec(`pm2 stop ${pm2Name}`, (err) => {
                    if(fs.existsSync(statusFile)) {
                        const s = JSON.parse(fs.readFileSync(statusFile));
                        s.botState = 'STOPPED';
                        fs.writeFileSync(statusFile, JSON.stringify(s, null, 2));
                    }
                    res.end(JSON.stringify({ success: true }));
                });
            }

            else if (url === '/bot-api/upgrade-vip') {
                logServer(username, 'CMD: UPGRADE VIP');
                let currentConfig = {};
                if (fs.existsSync(configFile)) currentConfig = JSON.parse(fs.readFileSync(configFile));
                
                currentConfig.vipStatus = 'vip';
                currentConfig.vipExpiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
                fs.writeFileSync(configFile, JSON.stringify(currentConfig, null, 2));

                exec(`pm2 restart ${pm2Name}`, () => {
                    logServer(username, 'VIP APPLIED', 'Bot restarted');
                    res.end(JSON.stringify({ success: true }));
                });
            }

            else if (url === '/bot-api/save-config') {
                logServer(username, 'CMD: SAVE CONFIG');
                let currentConfig = {};
                if (fs.existsSync(configFile)) currentConfig = JSON.parse(fs.readFileSync(configFile));
                const newConfig = JSON.parse(body);
                const finalConfig = { ...currentConfig, ...newConfig };
                fs.writeFileSync(configFile, JSON.stringify(finalConfig, null, 2));
                
                exec(`pm2 restart ${pm2Name}`, () => {
                     res.end(JSON.stringify({ success: true }));
                });
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
                logServer(username, 'CMD: UPDATE SETTING', 'Auto Balance');
                let currentConfig = {};
                if (fs.existsSync(configFile)) currentConfig = JSON.parse(fs.readFileSync(configFile));
                const cfg = JSON.parse(body);
                currentConfig.autoBalance = cfg.autoBalance;
                fs.writeFileSync(configFile, JSON.stringify(currentConfig, null, 2));
                res.end(JSON.stringify({ success: true }));
            }
            else { res.writeHead(404); res.end(); }

        } catch (e) { 
            logServer(username, 'SERVER ERROR', e.message);
            res.writeHead(500); res.end(JSON.stringify({success:false, message:e.message})); 
        }
    }
});

server.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(`[SERVER] MANAGER RUNNING ON PORT ${PORT}`);
    console.log(`[SERVER] Ready to manage bots via PM2`);
    console.log(`=================================================`);
});
