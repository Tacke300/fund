import https from 'https';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// === NHẬP API KEY VÀ SECRET KEY MỚI TẠO TỪ BƯỚC 1 VÀO ĐÂY ===
// Đảm bảo không có khoảng trắng thừa!
const API_KEY = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q'.trim();
const SECRET_KEY = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc'.trim();

const BASE_HOST = 'fapi.binance.com';

function addLog(message) {
    const now = new Date();
    const time = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    console.log(`[${time}] ${message}`);
}

function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret)
                 .update(queryString)
                 .digest('hex');
}

function makeHttpRequest(method, hostname, path, headers, postData = '') {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: hostname,
            path: path,
            method: method,
            headers: headers,
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data);
                } else {
                    const errorMsg = `HTTP Error: ${res.statusCode} ${res.statusMessage}`;
                    let errorDetails = { code: res.statusCode, msg: errorMsg };
                    try {
                        const parsedData = JSON.parse(data);
                        errorDetails = { ...errorDetails, ...parsedData };
                    } catch (e) {
                        errorDetails.msg += ` - Raw Response: ${data.substring(0, 200)}...`;
                    }
                    addLog(`❌ makeHttpRequest lỗi: ${errorDetails.msg}`);
                    reject(errorDetails);
                }
            });
        });

        req.on('error', (e) => {
            addLog(`❌ makeHttpRequest lỗi network: ${e.message}`);
            reject({ code: 'NETWORK_ERROR', msg: e.message });
        });

        if (method === 'POST' && postData) {
            req.write(postData);
        }
        req.end();
    });
}

async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    const recvWindow = 5000;
    const timestamp = Date.now(); // Sử dụng thời gian cục bộ

    let queryString = Object.keys(params)
                            .map(key => `${key}=${params[key]}`)
                            .join('&');

    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;

    addLog(`[DEBUG] Query String before signature: ${queryString}`); // Log chuỗi trước khi ký
    const signature = createSignature(queryString, SECRET_KEY);
    addLog(`[DEBUG] Generated Signature: ${signature}`); // Log chữ ký

    let requestPath;
    let requestBody = '';
    const headers = {
        'X-MBX-APIKEY': API_KEY,
    };

    if (method === 'GET') {
        requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/json';
    } else if (method === 'POST') {
        requestPath = fullEndpointPath;
        requestBody = `${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
        throw new Error(`Unsupported method: ${method}`);
    }

    try {
        addLog(`[DEBUG] Request Method: ${method}, Path: ${requestPath}`);
        if (method === 'POST') {
            addLog(`[DEBUG] Request Body (for POST): ${requestBody}`);
        }
        addLog(`[DEBUG] Request Headers: ${JSON.stringify(headers)}`);

        const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody);
        return JSON.parse(rawData);
    } catch (error) {
        addLog("❌ Lỗi khi gửi yêu cầu ký tới Binance API:");
        addLog(`  Mã lỗi: ${error.code || 'UNKNOWN'}`);
        addLog(`  Thông báo: ${error.msg || error.message || 'Lỗi không xác định'}`);
        if (error.code === -2015) {
            addLog("  Gợi ý: Lỗi xác thực API Key. Vui lòng kiểm tra lại API_KEY, SECRET_KEY và quyền truy cập Futures của bạn.");
        } else if (error.code === -1021) {
            addLog("  Gợi ý: Lỗi lệch thời gian. Đảm bảo đồng hồ máy tính của bạn chính xác (sử dụng NTP) hoặc nếu vẫn gặp lỗi, hãy báo lại để chúng ta thêm cơ chế đồng bộ thời gian nâng cao.");
        } else if (error.code === -1022) {
            addLog("  Gợi ý: Lỗi chữ ký không hợp lệ. Điều này có thể do API Key/Secret bị sai, hoặc có vấn đề trong cách bạn xây dựng chuỗi tham số để ký (ví dụ: thiếu tham số, sai thứ tự, hoặc khoảng trắng không mong muốn).");
        } else if (error.code === 404) {
            addLog("  Gợi ý: Lỗi 404 Not Found. Đường dẫn API không đúng. Kiểm tra lại tài liệu API của Binance.");
        } else if (error.code === 'NETWORK_ERROR') {
             addLog("  Gợi ý: Kiểm tra kết nối mạng của bạn.");
        }
        throw error;
    }
}

// === Logic chính để kiểm tra API ===
(async () => {
    addLog('>>> Đang kiểm tra API Key với Binance Futures...');
    try {
        // Lệnh gọi API đầu tiên: Lấy thông tin tài khoản (cần ký)
        const accountInfo = await callSignedAPI('/fapi/v2/account', 'GET');
        addLog('✅ Lấy thông tin tài khoản Futures thành công!');
        const usdtAsset = accountInfo.assets.find(a => a.asset === 'USDT');
        addLog('  Số dư USDT khả dụng: ' + (usdtAsset ? parseFloat(usdtAsset.availableBalance).toFixed(2) : 'N/A'));

        // Lệnh gọi API thứ hai: Lấy thông tin đòn bẩy cho BTCUSDT (cần ký)
        addLog('>>> Đang kiểm tra thông tin đòn bẩy cho BTCUSDT...');
        const leverageBracket = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol: 'BTCUSDT' });
        if (leverageBracket && leverageBracket.length > 0 && leverageBracket[0].brackets && leverageBracket[0].brackets.length > 0) {
            addLog('✅ Lấy thông tin đòn bẩy BTCUSDT thành công! Max Leverage: ' + leverageBracket[0].brackets[0].maxInitialLeverage);
        } else {
            addLog('⚠️ Không tìm thấy thông tin đòn bẩy cho BTCUSDT hoặc phản hồi không đúng định dạng.');
        }

    } catch (error) {
        addLog('❌ Đã xảy ra lỗi trong quá trình kiểm tra API: ' + (error.msg || error.message));
    }
})();
