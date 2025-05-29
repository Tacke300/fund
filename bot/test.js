// test.js - Code thuần JavaScript chỉ dùng module 'https' và 'crypto' của Node.js
import https from 'https';
import crypto from 'crypto'; // Thư viện mã hóa của Node.js

// --- CẤU HÌNH API KEY VÀ SECRET KEY TRỰC TIẾP TẠI ĐÂY ---
// !!! QUAN TRỌNG: THAY THẾ CHUỖI BÊN DƯỚI BẰNG API KEY THẬT CỦA BẠN !!!
const API_KEY = "cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q"; // Ví dụ: "cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q";
// !!! QUAN TRỌNG: THAY THẾ CHUỖI BÊN DƯỚI BẰNG SECRET KEY THẬT CỦA BẠN !!!
const SECRET_KEY = "oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc"; // Ví dụ: "oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fccDf0pEnFzoTc";

// Host cho Binance Futures API
const BASE_HOST = 'fapi.binance.com';

// Kiểm tra nhanh để đảm bảo bạn đã thay thế khóa API
if (API_KEY === "YOUR_BINANCE_API_KEY" || SECRET_KEY === "YOUR_BINANCE_SECRET_KEY") {
    console.error("LỖI: Vui lòng thay thế 'YOUR_BINANCE_API_KEY' và 'YOUR_BINANCE_SECRET_KEY' bằng khóa API thật của bạn trong tệp test.js.");
    process.exit(1);
}

/**
 * Tạo chữ ký HMAC SHA256 cho chuỗi truy vấn.
 * @param {string} queryString - Chuỗi truy vấn cần ký.
 * @param {string} apiSecret - Secret Key của API Binance.
 * @returns {string} Chữ ký HMAC SHA256.
 */
function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret)
                 .update(queryString)
                 .digest('hex');
}

/**
 * Hàm helper để gửi yêu cầu HTTP.
 * @param {string} method - Phương thức HTTP (GET).
 * @param {string} hostname - Hostname của API (ví dụ: 'fapi.binance.com').
 * @param {string} fullPath - Đường dẫn đầy đủ của API (ví dụ: '/fapi/v1/account?params=...').
 * @param {object} headers - Các HTTP headers.
 * @returns {Promise<string>} Dữ liệu phản hồi dạng chuỗi JSON.
 */
function makeHttpRequest(method, hostname, fullPath, headers) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: hostname,
            path: fullPath,
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
                    reject(errorDetails);
                }
            });
        });

        req.on('error', (e) => {
            reject({ code: 'NETWORK_ERROR', msg: e.message });
        });

        req.end();
    });
}

/**
 * Gửi yêu cầu GET đã ký tới API Binance Futures.
 * @param {string} fullEndpointPath - Đường dẫn đầy đủ của API (ví dụ: '/fapi/v2/account').
 * @param {object} params - Các tham số truy vấn.
 * @returns {Promise<object>} Dữ liệu trả về từ API.
 */
async function signedRequest(fullEndpointPath, params = {}) {
    const recvWindow = 5000; // Thời gian hiệu lực của yêu cầu (5000ms = 5 giây)
    const timestamp = Date.now(); // Lấy timestamp hiện tại của máy cục bộ

    let queryString = Object.keys(params)
                            .map(key => `${key}=${params[key]}`)
                            .join('&');

    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;

    const signature = createSignature(queryString, SECRET_KEY);
    const fullPathWithQuery = `${fullEndpointPath}?${queryString}&signature=${signature}`;

    const headers = {
        'X-MBX-APIKEY': API_KEY,
        'Content-Type': 'application/json',
    };

    try {
        const rawData = await makeHttpRequest('GET', BASE_HOST, fullPathWithQuery, headers);
        return JSON.parse(rawData);
    } catch (error) {
        console.error("Lỗi khi gửi yêu cầu ký tới Binance API:");
        console.error("  Mã lỗi:", error.code || 'UNKNOWN');
        console.error("  Thông báo:", error.msg || error.message || 'Lỗi không xác định');
        if (error.code === -2015) {
            console.error("  Gợi ý: Lỗi xác thực API Key. Vui lòng kiểm tra lại API_KEY, SECRET_KEY và quyền truy cập Futures của bạn.");
        } else if (error.code === -1021) {
            console.error("  Gợi ý: Lỗi lệch thời gian. Đảm bảo đồng hồ máy tính của bạn chính xác hoặc xem xét cơ chế đồng bộ thời gian với server Binance.");
        } else if (error.code === 404) {
            console.error("  Gợi ý: Lỗi 404 Not Found. Đường dẫn API không đúng. Kiểm tra lại tài liệu API của Binance.");
        } else if (error.code === 'NETWORK_ERROR') {
             console.error("  Gợi ý: Kiểm tra kết nối mạng của bạn.");
        }
        throw error;
    }
}

/**
 * Gửi yêu cầu GET KHÔNG ký tới API Binance Futures (cho các endpoint công khai).
 * @param {string} fullEndpointPath - Đường dẫn đầy đủ của API (ví dụ: '/fapi/v1/exchangeInfo').
 * @param {object} params - Các tham số truy vấn.
 * @returns {Promise<object>} Dữ liệu trả về từ API.
 */
async function publicRequest(fullEndpointPath, params = {}) {
    const queryString = Object.keys(params)
                            .map(key => `${key}=${params[key]}`)
                            .join('&');
    const fullPathWithQuery = `${fullEndpointPath}` + (queryString ? `?${queryString}` : '');

    const headers = {
        'Content-Type': 'application/json',
    };

    try {
        const rawData = await makeHttpRequest('GET', BASE_HOST, fullPathWithQuery, headers);
        return JSON.parse(rawData);
    } catch (error) {
        console.error("Lỗi khi gửi yêu cầu công khai tới Binance API:");
        console.error("  Mã lỗi:", error.code || 'UNKNOWN');
        console.error("  Thông báo:", error.msg || error.message || 'Lỗi không xác định');
        if (error.code === 404) {
            console.error("  Gợi ý: Lỗi 404 Not Found. Đường dẫn API không đúng. Kiểm tra lại tài liệu API của Binance.");
        } else if (error.code === 'NETWORK_ERROR') {
             console.error("  Gợi ý: Kiểm tra kết nối mạng của bạn.");
        }
        throw error;
    }
}

/**
 * Lấy thông tin đòn bẩy cho một symbol cụ thể từ endpoint /fapi/v1/leverageBracket.
 * @param {string} symbol - Tên cặp giao dịch (ví dụ: 'BTCUSDT').
 * @returns {Promise<string>} Đòn bẩy tối đa (ví dụ: '125' hoặc 'N/A' nếu không tìm thấy).
 */
async function getLeverageBracketForSymbol(symbol) {
    try {
        const response = await signedRequest('/fapi/v1/leverageBracket', { symbol: symbol });

        // Phản hồi là một mảng, mỗi phần tử là thông tin đòn bẩy cho một bracket
        // response[0] là đối tượng cho symbol được yêu cầu
        // response[0].brackets là mảng các bracket đòn bẩy
        if (response && Array.isArray(response) && response.length > 0 && response[0].brackets && response[0].brackets.length > 0) {
            const firstBracket = response[0].brackets[0]; // Lấy bracket đầu tiên
            if (firstBracket.maxInitialLeverage !== undefined) {
                return firstBracket.maxInitialLeverage;
            } else if (firstBracket.initialLeverage !== undefined) {
                return firstBracket.initialLeverage;
            }
        }
        return 'N/A'; // Không tìm thấy thông tin đòn bẩy
    } catch (error) {
        console.error(`Lỗi khi lấy đòn bẩy cho ${symbol}:`, error.msg || error.message);
        return 'N/A';
    }
}


async function getSpecificCoinLeverageAndBalance() {
    try {
        // --- Cấu hình đồng coin bạn muốn lấy đòn bẩy ---
        const targetSymbol = 'BTCUSDT'; // THAY ĐỔI TÊN ĐỒNG COIN Ở ĐÂY NẾU BẠN MUỐN

        console.log(`\n--- LẤY ĐÒN BẨY TỐI ĐA CHO ${targetSymbol} ---`);
        const maxLeverage = await getLeverageBracketForSymbol(targetSymbol);
        console.log(`  - Cặp: ${targetSymbol}, Đòn bẩy tối đa: ${maxLeverage}x`);

        console.log(`\n--- SỐ DƯ TÀI KHOẢN FUTURES CỦA BẠN ---`);
        // Lấy thông tin tài khoản Futures (yêu cầu ký)
        const accountInfo = await signedRequest('/fapi/v2/account');

        console.log(`Tổng số dư ví (totalWalletBalance): ${accountInfo.totalWalletBalance} USDT`);
        console.log(`Số dư khả dụng (availableBalance): ${accountInfo.availableBalance} USDT`);
        console.log(`Tổng PnL chưa thực hiện (totalUnrealizedProfit): ${accountInfo.totalUnrealizedProfit} USDT`);

        console.log("\nChi tiết các tài sản trong ví futures:");
        accountInfo.assets.forEach(asset => {
            if (parseFloat(asset.walletBalance) > 0 || parseFloat(asset.unrealizedProfit) !== 0) {
                console.log(`  - Tài sản: ${asset.asset}, Số dư ví: ${asset.walletBalance}, Lãi/Lỗ chưa thực hiện: ${asset.unrealizedProfit}`);
            }
        });

    } catch (error) {
        console.error("\nCó lỗi xảy ra trong hàm chính getSpecificCoinLeverageAndBalance.");
        // Lỗi đã được xử lý chi tiết trong các hàm publicRequest/signedRequest
    }
}

// Gọi hàm chính để bắt đầu lấy thông tin
getSpecificCoinLeverageAndBalance();
