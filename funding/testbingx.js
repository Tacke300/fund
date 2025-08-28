const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URLSearchParams } = require('url');

// Import các API Key và Secret từ file config.js
// Đảm bảo file config.js tồn tại trong cùng thư mục và có nội dung tương tự:
// module.exports = {
//     bingxApiKey: 'YOUR_BINGX_API_KEY',
//     bingxApiSecret: 'YOUR_BINGX_API_SECRET',
// };
const {
    bingxApiKey, bingxApiSecret,
} = require('./config.js');

const BINGX_BASE_HOST = 'open-api.bingx.com';
const PORT = 1997; // Cổng cho server HTTP

// Các coin cụ thể mà Bình muốn lấy tất cả dữ liệu
// ĐÃ ĐIỀU CHỈNH FORMAT SYMBOL THÀNH 'XXX-USDT' ĐỂ KHỚP VỚI YÊU CẦU CỦA BINGX API
// Cập nhật BIOX thành BIO, WAVES thành WAVE theo yêu cầu
const TARGET_COINS = ['LPT-USDT', 'CAT-USDT', 'BIO-USDT', 'WAVE-USDT'];

// Biến để lưu trữ dữ liệu funding rate mới nhất (bao gồm tất cả các trường)
let latestFundingData = {
    timestamp: null,
    data: []
};

/**
 * Chuẩn hóa symbol.
 * Chuyển XXX-USDT thành XXXUSDT cho mục đích hiển thị/lưu trữ nếu cần.
 */
const cleanSymbol = (symbol) => {
    let cleaned = symbol.toUpperCase();
    // Loại bỏ các phần không cần thiết và chuẩn hóa
    cleaned = cleaned.replace('_UMCBL', '');
    cleaned = cleaned.replace(/[\/:_]/g, '');
    cleaned = cleaned.replace(/-USDT$/, 'USDT'); // Chuyển XXX-USDT thành XXXUSDT
    cleaned = cleaned.replace(/-USDC$/, 'USDC'); // Chuyển XXX-USDC thành XXXUSDC
    cleaned = cleaned.replace(/^\d+/, ''); // Loại bỏ số ở đầu nếu có
    const usdtIndex = cleaned.indexOf('USDT');
    const usdcIndex = cleaned.indexOf('USDC');

    if (usdtIndex !== -1) {
        cleaned = cleaned.substring(0, usdtIndex) + 'USDT';
    } else if (usdcIndex !== -1) {
        cleaned = cleaned.substring(0, usdcIndex) + 'USDC';
    } else if (symbol.toUpperCase().includes('USDT') && !cleaned.endsWith('USDT')) {
        cleaned = cleaned + 'USDT';
    } else if (symbol.toUpperCase().includes('USDC') && !cleaned.endsWith('USDC')) {
        cleaned = cleaned + 'USDC';
    }
    return cleaned;
};

/**
 * Tạo chữ ký HMAC SHA256 cho các yêu cầu đã xác thực.
 * @param {string} queryString Chuỗi tham số đã được mã hóa.
 * @param {string} apiSecret API Secret của sàn giao dịch.
 * @returns {string} Chữ ký hex.
 */
function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret)
        .update(queryString)
        .digest('hex');
}

/**
 * Thực hiện một HTTP/HTTPS request.
 * @param {string} method Phương thức HTTP (GET, POST, PUT, DELETE).
 * @param {string} hostname Tên máy chủ (ví dụ: open-api.bingx.com).
 * @param {string} path Đường dẫn API (ví dụ: /openApi/swap/v2/quote/fundingRate).
 * @param {object} headers Các header HTTP tùy chọn.
 * @param {string} postData Dữ liệu để gửi trong body request (cho POST/PUT/DELETE).
 * @returns {Promise<string>} Dữ liệu phản hồi từ server dưới dạng chuỗi.
 */
async function makeHttpRequest(method, hostname, path, headers = {}, postData = '') {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: hostname,
            port: 443, // Mặc định dùng HTTPS
            path: path,
            method: method,
            headers: { ...headers, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }, // Thêm User-Agent để tránh bị từ chối
            timeout: 20000 // Timeout 20 giây
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
                        rawResponse: data // Bao gồm rawResponse trong lỗi để debug
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

/**
 * Lấy tất cả dữ liệu funding trực tiếp từ BingX API cho một symbol cụ thể.
 * Bao gồm logging chi tiết về API call và raw response.
 * @param {string} symbol Symbol của cặp giao dịch (ví dụ: "LPT-USDT").
 * @returns {Promise<object|null>} Đối tượng chứa tất cả dữ liệu từ API, hoặc null nếu có lỗi.
 */
async function getBingxFundingDataDirect(symbol) {
    if (!bingxApiKey || !bingxApiSecret) {
        console.error(`[BINGX_FUNDING] ❌ Thiếu API Key hoặc Secret Key cho BingX. Vui lòng kiểm tra file config.js`);
        return null;
    }

    // Tạo các tham số cần thiết cho yêu cầu đã ký
    const params = new URLSearchParams({
        symbol: symbol,
        timestamp: Date.now(),
        recvWindow: 5000 // Thời gian chấp nhận chênh lệch timestamp (5 giây)
    }).toString();

    const signature = createSignature(params, bingxApiSecret);
    const urlPath = `/openApi/swap/v2/quote/fundingRate?${params}&signature=${signature}`;
    const headers = { 'X-BX-APIKEY': bingxApiKey };

    // Log chi tiết về yêu cầu API
    console.log(`[BINGX_API_CALL] Gọi BingX API cho ${symbol}: ${BINGX_BASE_HOST}${urlPath}`);

    try {
        const rawResponse = await makeHttpRequest('GET', BINGX_BASE_HOST, urlPath, headers);
        // Log toàn bộ phản hồi raw từ API
        console.log(`[BINGX_RAW_RESPONSE] Nhận raw data cho ${symbol}: ${rawResponse.substring(0, Math.min(rawResponse.length, 500))}`); // Giới hạn log raw response để dễ đọc hơn
        const json = JSON.parse(rawResponse);

        if (json.code === 0 && Array.isArray(json.data) && json.data.length > 0) {
            const firstData = json.data[0];

            // Kiểm tra các trường quan trọng để đảm bảo dữ liệu có ý nghĩa
            // Nếu không có fundingRate hoặc fundingTime, có thể đây không phải là dữ liệu funding hợp lệ
            if (typeof firstData.fundingRate === 'undefined' || typeof firstData.fundingTime === 'undefined') {
                console.warn(`[BINGX_FUNDING_WARN] ${symbol}: Dữ liệu fundingRate hoặc fundingTime bị thiếu. Raw: ${JSON.stringify(firstData)}`);
                return null;
            }

            // Có thể thêm kiểm tra kiểu dữ liệu và parse nếu cần xử lý số
            const fundingRate = parseFloat(firstData.fundingRate);
            if (isNaN(fundingRate)) {
                console.warn(`[BINGX_FUNDING_WARN] ${symbol}: fundingRate không parse được số. Value: ${firstData.fundingRate}`);
                // return null; // Tùy chọn: trả về null nếu fundingRate không hợp lệ
            }

            const fundingTime = parseInt(firstData.fundingTime, 10);
            if (isNaN(fundingTime) || fundingTime <= 0) {
                console.warn(`[BINGX_FUNDING_WARN] ${symbol}: fundingTime không parse được số hoặc không hợp lệ. Value: ${firstData.fundingTime}`);
                // return null; // Tùy chọn: trả về null nếu fundingTime không hợp lệ
            }

            // Trả về tất cả các trường từ API, kèm theo symbol đã được chuẩn hóa
            return {
                cleanedSymbol: cleanSymbol(firstData.symbol), // Thêm symbol đã chuẩn hóa
                ...firstData // Spread operator để đưa tất cả các trường của firstData vào đây
            };
        } else {
            // Log lỗi API hoặc trường hợp không có dữ liệu
            console.error(`[BINGX_FUNDING_ERROR] ❌ Lỗi API hoặc không có dữ liệu funding cho ${symbol}. Code: ${json.code}, Msg: ${json.msg || 'N/A'}. Raw: ${rawResponse.substring(0, Math.min(rawResponse.length, 500))}`);
            return null;
        }
    } catch (e) {
        // Log các lỗi request (mạng, timeout, JSON parse)
        console.error(`[BINGX_FUNDING_REQUEST_ERROR] ❌ Lỗi request khi lấy funding data cho ${symbol}: ${e.msg || e.message}.`);
        if (e.rawResponse) {
             console.error(`[BINGX_FUNDING_RAW_ERROR_DETAIL] ${symbol} Raw response: ${e.rawResponse.substring(0, Math.min(e.rawResponse.length, 500))}`);
        }
        return null;
    }
}

/**
 * Fetch tất cả dữ liệu funding cho các coin mục tiêu của Bình và cập nhật biến toàn cục.
 */
async function fetchFundingRatesForBinh() {
    console.log(`\n[BINH_SCRIPT] 🚀 Bắt đầu lấy tất cả dữ liệu funding BingX cho các coin: ${TARGET_COINS.join(', ')}`);
    const currentResults = [];

    for (const coin of TARGET_COINS) {
        const bingxSymbol = coin;
        try {
            // Gọi hàm mới để lấy tất cả dữ liệu
            const data = await getBingxFundingDataDirect(bingxSymbol);
            if (data) {
                currentResults.push(data); // `data` bây giờ chứa tất cả các trường từ API
                // Log chỉ để hiển thị fundingRate và nextFundingTime như ví dụ,
                // nhưng `data` chứa nhiều hơn trong `currentResults`.
                const fundingRate = parseFloat(data.fundingRate || 0); // Đảm bảo là số để format
                const fundingTime = parseInt(data.fundingTime, 10);
                const nextFundingTime = !isNaN(fundingTime) && fundingTime > 0 ? new Date(fundingTime).toISOString() : 'N/A';

                console.log(`[BINH_SCRIPT] ✅ ${data.symbol}: Funding Rate = ${fundingRate.toFixed(6)}, Next Funding Time = ${nextFundingTime}`);
            } else {
                console.warn(`[BINH_SCRIPT] ⚠️ Không lấy được dữ liệu funding hợp lệ cho ${coin}.`);
            }
        } catch (error) {
            console.error(`[BINH_SCRIPT] ❌ Lỗi bất ngờ khi lấy funding cho ${coin}: ${error.message}`);
        }
    }
    console.log('\n[BINH_SCRIPT] Hoàn tất lấy dữ liệu funding BingX.');

    // Cập nhật biến toàn cục với dữ liệu mới nhất (đã bao gồm tất cả các trường)
    latestFundingData = {
        timestamp: new Date().toISOString(),
        data: currentResults // currentResults bây giờ chứa các đối tượng đầy đủ từ API
    };

    // Log tổng hợp kết quả - in ra toàn bộ đối tượng để thấy tất cả dữ liệu
    console.log('--- Kết quả tổng hợp ---');
    if (currentResults.length > 0) {
        currentResults.forEach(res => {
            console.log(`Coin: ${res.symbol}, Toàn bộ dữ liệu: ${JSON.stringify(res, null, 2)}`);
        });
    } else {
        console.log('Không có dữ liệu funding nào được lấy thành công.');
    }
    return currentResults;
}

// ----- KHỞI TẠO SERVER HTTP -----
const server = http.createServer((req, res) => {
    // Endpoint để lấy dữ liệu funding rate
    if (req.url === '/api/funding' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        // Gửi toàn bộ đối tượng latestFundingData bao gồm tất cả các trường
        res.end(JSON.stringify(latestFundingData, null, 2));
        console.log(`[SERVER] Gửi dữ liệu funding (bao gồm tất cả các trường) đến client. Cập nhật cuối: ${latestFundingData.timestamp}`);
    }
    // Endpoint gốc hoặc các endpoint khác
    else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Endpoint không tìm thấy. Vui lòng truy cập /api/funding để xem dữ liệu funding.');
    }
});

// Lắng nghe cổng và khởi chạy các tác vụ ban đầu
server.listen(PORT, async () => {
    console.log(`✅ Máy chủ dữ liệu BingX Funding cho Bình đang chạy tại http://localhost:${PORT}`);
    console.log(`Bạn có thể xem tất cả dữ liệu funding rate tại http://localhost:${PORT}/api/funding`);

    // Chạy fetch funding data lần đầu tiên khi server khởi động
    await fetchFundingRatesForBinh();

    // Lập lịch để fetch funding data định kỳ mỗi 5 phút (300 giây)
    setInterval(async () => {
        console.log(`\n--- Bắt đầu vòng lặp định kỳ (5 phút) lúc ${new Date().toLocaleTimeString()} ---`);
        await fetchFundingRatesForBinh();
        console.log(`--- Kết thúc vòng lặp định kỳ ---`);
    }, 5 * 60 * 1000);

    console.log(`[BINH_SCRIPT] ✅ Lập lịch lấy tất cả dữ liệu funding BingX cho các coin mục tiêu mỗi 5 phút.`);
});
