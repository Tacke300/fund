const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URLSearchParams } = require('url');

// Import các API Key và Secret từ file config.js
const {
    bingxApiKey, bingxApiSecret,
} = require('./config.js');

const BINGX_BASE_HOST = 'open-api.bingx.com';
const PORT = 1997; // Cổng cho server HTTP

// Các coin cụ thể mà Bình muốn lấy funding rate
// Lưu ý: Đã đổi BIO thành BIOXUSDT và WAVE thành WAVESUSDT để khớp với BingX
const TARGET_COINS = ['LPTUSDT', 'CATUSDT', 'BIOXUSDT', 'WAVESUSDT']; 

// Biến để lưu trữ dữ liệu funding rate mới nhất
let latestFundingData = {
    timestamp: null,
    data: []
};

const cleanSymbol = (symbol) => {
    let cleaned = symbol.toUpperCase();
    cleaned = cleaned.replace('_UMCBL', ''); 
    cleaned = cleaned.replace(/[\/:_]/g, ''); 
    cleaned = cleaned.replace(/-USDT$/, 'USDT'); 
    cleaned = cleaned.replace(/^\d+/, ''); 
    cleaned = cleaned.replace(/(\D+)\d+USDT$/, '$1USDT'); 
    const usdtIndex = cleaned.indexOf('USDT');
    if (usdtIndex !== -1) {
        cleaned = cleaned.substring(0, usdtIndex) + 'USDT';
    } else if (symbol.toUpperCase().includes('USDT') && !cleaned.endsWith('USDT')) { 
        cleaned = cleaned + 'USDT';
    }
    return cleaned;
};

function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret)
        .update(queryString)
        .digest('hex');
}

async function makeHttpRequest(method, hostname, path, headers = {}, postData = '') {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: hostname,
            port: 443,
            path: path,
            method: method,
            headers: { ...headers, 'User-Agent': 'Mozilla/5.0' },
            timeout: 20000
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data);
                } else {
                    reject({
                        code: res.statusCode,
                        msg: `HTTP Lỗi: ${res.statusCode} ${res.statusMessage}`,
                        url: `${hostname}${path}`,
                        rawResponse: data
                    });
                }
            });
        });

        req.on('error', (e) => reject({ code: 'NETWORK_ERROR', msg: `${e.message} (khi gọi ${hostname}${path})` }));
        req.on('timeout', () => {
            req.destroy();
            reject({ code: 'TIMEOUT_ERROR', msg: `Request timed out sau ${options.timeout / 1000}s (khi gọi ${hostname}${path})` });
        });

        if (postData && (method === 'POST' || method === 'PUT' || method === 'DELETE')) req.write(postData);
        req.end();
    });
}

async function getBingxFundingRateDirect(symbol) {
    if (!bingxApiKey || !bingxApiSecret) {
        console.error(`[BINGX_FUNDING] ❌ Thiếu API Key hoặc Secret Key cho BingX. Vui lòng kiểm tra file config.js`);
        return null;
    }

    const params = new URLSearchParams({
        symbol: symbol,
        timestamp: Date.now(),
        recvWindow: 5000
    }).toString();

    const signature = createSignature(params, bingxApiSecret);
    const urlPath = `/openApi/swap/v2/quote/fundingRate?${params}&signature=${signature}`;
    const headers = { 'X-BX-APIKEY': bingxApiKey };

    console.log(`[BINGX_API_CALL] Gọi BingX API cho ${symbol}: ${BINGX_BASE_HOST}${urlPath}`);

    try {
        const rawResponse = await makeHttpRequest('GET', BINGX_BASE_HOST, urlPath, headers);
        console.log(`[BINGX_RAW_RESPONSE] Nhận raw data cho ${symbol}: ${rawResponse}`);
        const json = JSON.parse(rawResponse);
        
        if (json.code === 0 && Array.isArray(json.data) && json.data.length > 0) {
            const firstData = json.data[0];

            if (typeof firstData.fundingRate !== 'string' && typeof firstData.fundingRate !== 'number') {
                console.warn(`[BINGX_FUNDING_WARN] ${symbol}: fundingRate không phải string/number. Type: ${typeof firstData.fundingRate}. Value: ${firstData.fundingRate}`);
                return null;
            }
            const fundingRate = parseFloat(firstData.fundingRate);
            if (isNaN(fundingRate)) {
                console.warn(`[BINGX_FUNDING_WARN] ${symbol}: fundingRate không parse được số. Value: ${firstData.fundingRate}`);
                return null;
            }
            if (!firstData.fundingTime) {
                console.warn(`[BINGX_FUNDING_WARN] ${symbol}: fundingTime bị thiếu hoặc null. Value: ${firstData.fundingTime}`);
                return null;
            }
            const fundingTime = parseInt(firstData.fundingTime, 10);
            if (isNaN(fundingTime) || fundingTime <= 0) {
                console.warn(`[BINGX_FUNDING_WARN] ${symbol}: fundingTime không parse được số hoặc không hợp lệ. Value: ${firstData.fundingTime}`);
                return null;
            }
            
            return {
                symbol: cleanSymbol(firstData.symbol), 
                fundingRate: fundingRate,
                fundingTime: fundingTime,
                rawApiData: firstData // Lưu trữ raw data của từng coin
            };
        } else {
            console.error(`[BINGX_FUNDING] ❌ Lỗi API hoặc không có dữ liệu funding cho ${symbol}. Code: ${json.code}, Msg: ${json.msg || 'N/A'}. Raw: ${rawResponse.substring(0, Math.min(rawResponse.length, 500))}`);
            return null;
        }
    } catch (e) {
        console.error(`[BINGX_FUNDING] ❌ Lỗi request khi lấy funding rate cho ${symbol}: ${e.msg || e.message}.`);
        if (e.rawResponse) {
             console.error(`[BINGX_FUNDING_RAW_ERROR] ${symbol} Raw response: ${e.rawResponse.substring(0, Math.min(e.rawResponse.length, 500))}`);
        }
        return null;
    }
}

async function fetchFundingRatesForBinh() {
    console.log(`\n[BINH_SCRIPT] 🚀 Bắt đầu lấy funding rates BingX cho các coin: ${TARGET_COINS.join(', ')}`);
    const currentResults = [];

    for (const coin of TARGET_COINS) {
        const bingxSymbol = coin; 
        try {
            const data = await getBingxFundingRateDirect(bingxSymbol);
            if (data) {
                currentResults.push(data);
                console.log(`[BINH_SCRIPT] ✅ ${data.symbol}: Funding Rate = ${data.fundingRate}, Next Funding Time = ${new Date(data.fundingTime).toISOString()}`);
            } else {
                console.warn(`[BINH_SCRIPT] ⚠️ Không lấy được funding rate cho ${coin}.`);
            }
        } catch (error) {
            console.error(`[BINH_SCRIPT] ❌ Lỗi bất ngờ khi lấy funding cho ${coin}: ${error.message}`);
        }
    }
    console.log('\n[BINH_SCRIPT] Hoàn tất lấy funding rates BingX.');
    latestFundingData = {
        timestamp: new Date().toISOString(),
        data: currentResults
    };
    console.log('--- Kết quả tổng hợp ---');
    if (currentResults.length > 0) {
        currentResults.forEach(res => {
            console.log(`Coin: ${res.symbol}, Funding Rate: ${res.fundingRate.toFixed(6)}, Next Funding (UTC): ${new Date(res.fundingTime).toISOString()}`);
        });
    } else {
        console.log('Không có dữ liệu funding nào được lấy thành công.');
    }
    return currentResults;
}

// ----- KHỞI TẠO SERVER HTTP -----
const server = http.createServer((req, res) => {
    if (req.url === '/api/funding' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(latestFundingData, null, 2)); // Gửi dữ liệu funding rate dưới dạng JSON đẹp
        console.log(`[SERVER] Gửi dữ liệu funding rates đến client. Cập nhật cuối: ${latestFundingData.timestamp}`);
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Endpoint không tìm thấy. Vui lòng truy cập /api/funding');
    }
});

server.listen(PORT, async () => {
    console.log(`✅ Máy chủ dữ liệu BingX Funding cho Bình đang chạy tại http://localhost:${PORT}`);
    console.log(`Bạn có thể xem dữ liệu funding tại http://localhost:${PORT}/api/funding`);

    // Chạy lần đầu tiên khi khởi động server
    await fetchFundingRatesForBinh();

    // Lập lịch để chạy mỗi 5 phút (300 giây)
    setInterval(async () => {
        console.log(`\n--- Bắt đầu vòng lặp định kỳ (5 phút) lúc ${new Date().toLocaleTimeString()} ---`);
        await fetchFundingRatesForBinh();
        console.log(`--- Kết thúc vòng lặp định kỳ ---`);
    }, 5 * 60 * 1000); 

    console.log(`[BINH_SCRIPT] ✅ Lập lịch lấy funding rates BingX cho các coin mục tiêu mỗi 5 phút.`);
});
