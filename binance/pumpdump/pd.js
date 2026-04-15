import express from 'express';
import http from 'http';
import crypto from 'crypto';
import axios from 'axios';
import { fileURLToPath } from 'url';
import path from 'path';
import { API_KEY, SECRET_KEY } from './config.js';
import ccxt from 'ccxt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const binanceApi = axios.create({
    baseURL: 'https://fapi.binance.com',
    timeout: 15000,
    headers: { 'X-MBX-APIKEY': API_KEY }
});

let status = { 
    botLogs: [], exchangeInfo: null, isReady: false 
};

function addBotLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    status.botLogs.unshift({ time, msg, type });
    if (status.botLogs.length > 50) status.botLogs.pop();
    console.log(`[${time}] ${msg}`);
}

async function binancePrivate(endpoint, method = 'GET', data = {}) {
    const timestamp = Date.now();
    const query = new URLSearchParams({ ...data, timestamp, recvWindow: 10000 }).toString();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(query).digest('hex');
    try {
        const response = await binanceApi({ method, url: `${endpoint}?${query}&signature=${signature}` });
        return response.data;
    } catch (error) {
        // TRẢ VỀ LỖI CHI TIẾT TỪ SÀN
        if (error.response) {
            throw new Error(`Sàn báo: ${error.response.data.code} - ${error.response.data.msg}`);
        }
        throw new Error(`Mạng lỗi: ${error.message}`);
    }
}

async function init() {
    try {
        addBotLog("🔄 Đang kết nối sàn...");
        
        // Kiểm tra Key trước
        if (!API_KEY || !SECRET_KEY) {
            throw new Error("API_KEY hoặc SECRET_KEY đang trống trong config.js!");
        }

        // Bước 1: Thử lấy thông tin tài khoản (Để check Key/Time)
        addBotLog("📡 Đang kiểm tra API Key...");
        await binancePrivate('/fapi/v2/account');
        addBotLog("✅ API Key hợp lệ.", "success");

        // Bước 2: Tải thông số sàn
        addBotLog("📡 Đang tải thông số sàn...");
        const infoRes = await binanceApi.get('/fapi/v1/exchangeInfo');
        const brkRes = await binancePrivate('/fapi/v1/leverageBracket');

        let brackets = Array.isArray(brkRes) ? brkRes : (brkRes.brackets || []);
        const tempInfo = {};
        infoRes.data.symbols.forEach(s => {
            const lot = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const brk = brackets.find(b => b.symbol === s.symbol);
            tempInfo[s.symbol] = { 
                quantityPrecision: s.quantityPrecision, 
                pricePrecision: s.pricePrecision, 
                stepSize: parseFloat(lot.stepSize), 
                maxLeverage: (brk && brk.brackets) ? brk.brackets[0].initialLeverage : 20 
            };
        });

        status.exchangeInfo = tempInfo;
        status.isReady = true;
        addBotLog("👿 LUFFY v17.4 - KẾT NỐI THÀNH CÔNG", "success");

    } catch (e) {
        addBotLog(`❌ LỖI CHI TIẾT: ${e.message}`, "error");
        addBotLog("🔄 Thử lại sau 10 giây...", "info");
        setTimeout(init, 10000); // Tăng lên 10s để tránh bị spam block
    }
}

init();

const APP = express();
APP.get('/api/status', (req, res) => res.json(status));
APP.listen(9001);
