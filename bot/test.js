// test.js - Code thuần JavaScript chỉ dùng module 'https' và 'crypto' của Node.js
import https from 'https';
import crypto from 'crypto'; // Thư viện mã hóa của Node.js

// --- CẤU HÌNH API KEY VÀ SECRET KEY TRỰC TIẾP TẠI ĐÂY ---
// !!! QUAN TRỌNG: THAY THẾ CHUỖI BÊN DƯỚI BẰNG API KEY THẬT CỦA BẠN !!!
const API_KEY = "cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q"; // Ví dụ: "cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q";
// !!! QUAN TRỌNG: THAY THẾ CHUỖI BÊN DƯỚI BẰNG SECRET KEY THẬT CỦA BẠN !!!
const SECRET_KEY = "oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc"; // Ví dụ: "oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fccDf0pEnFzoTc";

// Host và Path Base cho Binance Futures API
const BASE_HOST = 'fapi.binance.com';
const BASE_PATH = '/fapi/v1';

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
 * @param {string} path - Đường dẫn của API (ví dụ: '/fapi/v1/account').
 * @param {object} headers - Các HTTP headers.
 * @returns {Promise<string>} Dữ liệu phản hồi dạng chuỗi JSON.
 */
function makeHttpRequest(method, hostname, path, headers) {
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
                    // Xử lý lỗi từ server
                    const errorMsg = `HTTP Error: ${res.statusCode} ${res.statusMessage} - ${data}`;
                    let errorDetails = { code: res.statusCode, msg: errorMsg };
                    try {
                        const parsedData = JSON.parse(data);
                        errorDetails = { ...errorDetails, ...parsedData };
                    } catch (e) {
                        // Không phải JSON, giữ nguyên errorDetails
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
 * @param {string} endpoint - Endpoint của API (ví dụ: '/exchangeInfo', '/account').
 * @param {object} params - Các tham số truy vấn.
 * @returns {Promise<object>} Dữ liệu trả về từ API.
 */
async function signedRequest(endpoint, params = {}) {
    const recvWindow = 5000; // Thời gian hiệu lực của yêu cầu (5000ms = 5 giây)
    const timestamp = Date.now(); // Lấy timestamp hiện tại của máy cục bộ

    let queryString = Object.keys(params)
                            .map(key => `${key}=${params[key]}`)
                            .join('&');

    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;

    const signature = createSignature(queryString, SECRET_KEY);
    const fullPath = `${BASE_PATH}${endpoint}?${queryString}&signature=${signature}`;

    const headers = {
        'X-MBX-APIKEY': API_KEY,
        'Content-Type': 'application/json', // Mặc dù là GET, vẫn nên có
    };

    try {
        const rawData = await makeHttpRequest('GET', BASE_HOST, fullPath, headers);
        return JSON.parse(rawData);
    } catch (error) {
        console.error("Lỗi khi gửi yêu cầu ký tới Binance API:");
        console.error("  Mã lỗi:", error.code || 'UNKNOWN');
        console.error("  Thông báo:", error.msg || error.message || 'Lỗi không xác định');
        if (error.code === -2015) {
            console.error("  Gợi ý: Lỗi xác thực API Key. Vui lòng kiểm tra lại API_KEY, SECRET_KEY và quyền truy cập Futures của bạn.");
        } else if (error.code === -1021) {
            console.error("  Gợi ý: Lỗi lệch thời gian. Đảm bảo đồng hồ máy tính của bạn chính xác hoặc xem xét cơ chế đồng bộ thời gian với server Binance.");
        } else if (error.code === 'NETWORK_ERROR') {
             console.error("  Gợi ý: Kiểm tra kết nối mạng của bạn.");
        }
        throw error; // Ném lại lỗi để hàm gọi có thể xử lý
    }
}

/**
 * Gửi yêu cầu GET KHÔNG ký tới API Binance Futures (cho các endpoint công khai).
 * @param {string} endpoint - Endpoint của API (ví dụ: '/exchangeInfo', '/ticker/price').
 * @param {object} params - Các tham số truy vấn.
 * @returns {Promise<object>} Dữ liệu trả về từ API.
 */
async function publicRequest(endpoint, params = {}) {
    const queryString = Object.keys(params)
                            .map(key => `${key}=${params[key]}`)
                            .join('&');
    const fullPath = `${BASE_PATH}${endpoint}` + (queryString ? `?${queryString}` : '');

    const headers = {
        'Content-Type': 'application/json',
    };

    try {
        const rawData = await makeHttpRequest('GET', BASE_HOST, fullPath, headers);
        return JSON.parse(rawData);
    } catch (error) {
        console.error("Lỗi khi gửi yêu cầu công khai tới Binance API:");
        console.error("  Mã lỗi:", error.code || 'UNKNOWN');
        console.error("  Thông báo:", error.msg || error.message || 'Lỗi không xác định');
        if (error.code === 'NETWORK_ERROR') {
             console.error("  Gợi ý: Kiểm tra kết nối mạng của bạn.");
        }
        throw error;
    }
}

async function getAllFuturesLeverageAndBalance() {
    try {
        console.log("\n--- THÔNG TIN ĐÒN BẨY TỐI ĐA CỦA CÁC CẶP GIAO DỊCH FUTURES ---");

        // Lấy thông tin trao đổi công khai
        const exchangeInfo = await publicRequest('/exchangeInfo');

        let leverageData = [];
        for (const s of exchangeInfo.symbols) {
            if (s.status === 'TRADING') {
                let maxLev = 'N/A';
                if (s.leverageBracket && s.leverageBracket.length > 0) {
                    maxLev = s.leverageBracket[0].maxInitialLeverage;
                }
                leverageData.push(`  - Cặp: ${s.symbol}, Đòn bẩy tối đa: ${maxLev}x`);
            }
        }

        leverageData.sort();
        leverageData.forEach(line => console.log(line));


        console.log(`\n--- SỐ DƯ TÀI KHOẢN FUTURES CỦA BẠN ---`);
        // Lấy thông tin tài khoản Futures (yêu cầu ký)
        const accountInfo = await signedRequest('/account'); // Endpoint cho thông tin tài khoản futures

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
        console.error("\nCó lỗi xảy ra trong hàm chính getAllFuturesLeverageAndBalance.");
        // Lỗi đã được xử lý chi tiết trong các hàm publicRequest/signedRequest
    }
}

// Gọi hàm chính để bắt đầu lấy thông tin
getAllFuturesLeverageAndBalance();
