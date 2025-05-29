import https from 'https';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Để thay thế __dirname trong ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// === API KEY & SECRET ===
// !!! QUAN TRỌNG: ĐẢM BẢO ĐÂY LÀ API KEY VÀ SECRET KEY THẬT CỦA BẠN !!!
// DÁN API Key và Secret Key THẬT của bạn vào đây.
// Đã thêm .trim() để loại bỏ bất kỳ khoảng trắng thừa nào khi bạn copy.
const API_KEY = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROXRSZHTJjnQ7OG4Q'.trim(); // Đã sửa API_KEY nếu bạn dùng API thật của mình
const SECRET_KEY = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88A3zvmC3SpT9nEf4fcDf0pEnFzoTc'.trim(); // Đã sửa SECRET_KEY nếu bạn dùng API thật của mình

// === BASE URL CỦA BINANCE FUTURES API ===
const BASE_HOST = 'fapi.binance.com';

let serverTimeOffset = 0; // Giữ nguyên để tương thích

// Biến cache cho exchangeInfo
let exchangeInfoCache = null;

// Hàm addLog để ghi nhật ký
function addLog(message) {
    const now = new Date();
    const time = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-US', { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    const logEntry = `[${time}] ${message}`;
    console.log(logEntry);
}

const delay = ms => new Promise(resolve => setTimeout(ms));

// Hàm tạo chữ ký HMAC SHA256
function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret)
                 .update(queryString)
                 .digest('hex');
}

// Hàm gửi HTTP request
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

// Hàm gọi API có chữ ký
async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    const recvWindow = 5000;
    const timestamp = Date.now();

    let queryString = Object.keys(params)
                            .map(key => `${key}=${params[key]}`)
                            .join('&');

    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;

    const signature = createSignature(queryString, SECRET_KEY);

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

// Hàm gọi API công khai
async function callPublicAPI(fullEndpointPath, params = {}) {
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
        addLog("❌ Lỗi khi gửi yêu cầu công khai tới Binance API:");
        addLog(`  Mã lỗi: ${error.code || 'UNKNOWN'}`);
        addLog(`  Thông báo: ${error.msg || error.message || 'Lỗi không xác định'}`);
        if (error.code === 404) {
            addLog("  Gợi ý: Lỗi 404 Not Found. Đường dẫn API không đúng. Kiểm tra lại tài liệu API của Binance.");
        } else if (error.code === 'NETWORK_ERROR') {
             addLog("  Gợi ý: Kiểm tra kết nối mạng của bạn.");
        }
        throw error;
    }
}

// Hàm lấy thời gian server Binance
async function syncServerTime() {
  try {
    const data = await callPublicAPI('/fapi/v1/time');
    const binanceServerTime = data.serverTime;
    const localTime = Date.now();
    serverTimeOffset = binanceServerTime - localTime;
    addLog(`✅ Đồng bộ thời gian với Binance server. Độ lệch: ${serverTimeOffset} ms.`);
  } catch (error) {
    addLog(`❌ Lỗi khi đồng bộ thời gian với Binance: ${error.message}.`);
    serverTimeOffset = 0; // Đặt về 0 nếu không đồng bộ được để tránh lỗi timestamp
  }
}

// Hàm lấy thông tin đòn bẩy cho một symbol
async function getLeverageBracketForSymbol(symbol) {
    try {
        const response = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol: symbol });

        if (response && Array.isArray(response) && response.length > 0) {
            const symbolData = response.find(item => item.symbol === symbol);

            if (symbolData && symbolData.brackets && Array.isArray(symbolData.brackets) && symbolData.brackets.length > 0) {
                const firstBracket = symbolData.brackets[0];
                if (firstBracket.maxInitialLeverage !== undefined) {
                    const maxLev = parseInt(firstBracket.maxInitialLeverage);
                    return maxLev;
                } else if (firstBracket.initialLeverage !== undefined) {
                    const maxLev = parseInt(firstBracket.initialLeverage);
                    return maxLev;
                }
            }
        }
        addLog(`[DEBUG getLeverageBracketForSymbol] Không tìm thấy thông tin đòn bẩy hợp lệ cho ${symbol} từ response.`);
        return null;
    } catch (error) {
        addLog(`❌ Lỗi khi lấy getLeverageBracketForSymbol cho ${symbol}: ${error.msg || error.message}`);
        return null;
    }
}

// Hàm lấy thông tin sàn (exchangeInfo)
async function getExchangeInfo() {
  if (exchangeInfoCache) {
    return exchangeInfoCache;
  }

  addLog('>>> Đang lấy exchangeInfo từ Binance...');
  try {
    const data = await callPublicAPI('/fapi/v1/exchangeInfo');
    addLog(`✅ Đã nhận được exchangeInfo. Số lượng symbols: ${data.symbols.length}`);

    exchangeInfoCache = {};
    data.symbols.forEach(s => {
      const lotSizeFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
      const marketLotSizeFilter = s.filters.find(f => f.filterType === 'MARKET_LOT_SIZE');
      const minNotionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
      const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');


      exchangeInfoCache[s.symbol] = {
        minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.minQty) : 0),
        maxQty: lotSizeFilter ? parseFloat(lotSizeFilter.maxQty) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.maxQty) : Infinity),
        stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.stepSize) : 0.001),
        minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.notional) : 0,
        pricePrecision: s.pricePrecision,
        quantityPrecision: s.quantityPrecision,
        minPrice: priceFilter ? parseFloat(priceFilter.minPrice) : 0,
        maxPrice: priceFilter ? parseFloat(priceFilter.maxPrice) : Infinity,
        tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.001
      };
    });
    addLog('>>> Đã tải thông tin sàn và cache thành công.');
    return exchangeInfoCache;
  } catch (error) {
    addLog('❌ Lỗi khi lấy exchangeInfo: ' + (error.msg || error.message));
    exchangeInfoCache = null;
    return null;
  }
}

// Hàm kết hợp để lấy tất cả filters và maxLeverage
async function getSymbolFiltersAndMaxLeverage(symbol) {
  const filters = await getExchangeInfo();

  if (!filters || !filters[symbol]) {
    addLog(`[DEBUG getSymbolFiltersAndMaxLeverage] Không tìm thấy filters cho ${symbol}.`);
    return null;
  }

  const maxLeverage = await getLeverageBracketForSymbol(symbol);

  return {
    ...filters[symbol],
    maxLeverage: maxLeverage
  };
}

// Hàm lấy giá hiện tại
async function getCurrentPrice(symbol) {
  try {
    const data = await callPublicAPI('/fapi/v1/ticker/price', { symbol: symbol });
    const price = parseFloat(data.price);
    return price;
  } catch (error) {
    addLog(`❌ Lỗi khi lấy giá cho ${symbol}: ` + (error.msg || error.message));
    return null;
  }
}

// === Cấu hình Bot ===
const MIN_USDT_BALANCE_TO_OPEN = 10; // Số dư USDT tối thiểu để mở lệnh (ví dụ: 10 USDT)
const CAPITAL_PERCENTAGE_PER_TRADE = 0.5; // Phần trăm vốn sử dụng cho mỗi lệnh (ví dụ: 0.8 = 80%)
const MIN_FUNDING_RATE_THRESHOLD = -0.0001; // Ngưỡng funding rate âm tối thiểu để xem xét (ví dụ: -0.01% = -0.0001)
const TP_SL_RISK_PERCENTAGE = 0.005; // 0.5% rủi ro/lợi nhuận trên tổng giá trị vị thế (sau đòn bẩy)
const MAX_POSITION_LIFETIME_SECONDS = 300; // Thời gian tối đa giữ một vị thế (tính bằng giây), ví dụ: 300 giây = 5 phút

// Cấu hình thời gian chạy bot theo giờ UTC
const SCAN_MINUTE_UTC = 43; // Phút thứ 43 để quét và chọn đồng coin
const OPEN_ORDER_MINUTE_UTC = 45; // Phút thứ 45 để mở lệnh
const TARGET_SECOND_UTC = 0;  // Giây thứ 0
const TARGET_MILLISECOND_UTC = 500; // mili giây thứ 500

let currentOpenPosition = null; // Biến toàn cục để theo dõi vị thế đang mở
let positionCheckInterval = null; // Biến để lưu trữ setInterval cho việc kiểm tra vị thế

// Biến để lưu trữ đồng coin đã chọn và thông tin của nó
let selectedCandidate = null;

// --- Hàm chính để đóng lệnh Short ---
async function closeShortPosition(symbol, quantityToClose, reason = 'manual') {
    addLog(`>>> Đang cố gắng đóng lệnh SHORT cho ${symbol} với khối lượng ${quantityToClose}.`);
    try {
        const symbolInfo = await getSymbolFiltersAndMaxLeverage(symbol);
        if (!symbolInfo) {
            addLog(`❌ Không thể lấy thông tin symbol cho ${symbol} để đóng lệnh.`);
            return;
        }

        const quantityPrecision = symbolInfo.quantityPrecision;
        const adjustedQuantity = parseFloat(quantityToClose.toFixed(quantityPrecision));

        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol);

        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            addLog(`>>> Không có vị thế SHORT để đóng cho ${symbol} hoặc đã đóng trên sàn.`);
            currentOpenPosition = null; 
            clearInterval(positionCheckInterval); // Dừng việc kiểm tra vị thế
            positionCheckInterval = null;
            return;
        }

        addLog(`[DEBUG] Gửi lệnh đóng SHORT: symbol=${symbol}, side=BUY, type=MARKET, quantity=${adjustedQuantity}, reduceOnly=true`);
        
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: 'BUY', // Để đóng lệnh SHORT, cần lệnh BUY
            type: 'MARKET',
            quantity: adjustedQuantity,
            reduceOnly: 'true' 
        });

        addLog(`✅ Đã đóng vị thế SHORT cho ${symbol}. Lý do: ${reason}.`);
        currentOpenPosition = null; 
        clearInterval(positionCheckInterval); // Dừng việc kiểm tra vị thế
        positionCheckInterval = null;

    } catch (error) {
        addLog(`❌ Lỗi khi đóng lệnh SHORT cho ${symbol}: ${error.msg || error.message}`);
    }
}

// --- Hàm chính để mở lệnh Short ---
async function openShortPosition(symbol, fundingRate, usdtBalance) {
    addLog(`>>> Đang cố gắng mở lệnh SHORT cho ${symbol} với Funding Rate: ${fundingRate}`);
    try {
        // 1. Lấy thông tin symbol và đòn bẩy
        const symbolInfo = await getSymbolFiltersAndMaxLeverage(symbol);
        if (!symbolInfo || typeof symbolInfo.maxLeverage !== 'number' || symbolInfo.maxLeverage <= 1) {
            addLog(`❌ Không thể lấy thông tin đòn bẩy hợp lệ cho ${symbol}. Không mở lệnh.`);
            selectedCandidate = null; // Reset ứng viên đã chọn
            return;
        }
        const maxLeverage = symbolInfo.maxLeverage;
        const pricePrecision = symbolInfo.pricePrecision;
        const quantityPrecision = symbolInfo.quantityPrecision;
        const minNotional = symbolInfo.minNotional;
        const minQty = symbolInfo.minQty;
        const stepSize = symbolInfo.stepSize;
        const tickSize = symbolInfo.tickSize;

        // 2. Đặt đòn bẩy cho cặp giao dịch
        addLog(`[DEBUG] Đang thiết lập đòn bẩy ${maxLeverage}x cho ${symbol}.`);
        await callSignedAPI('/fapi/v1/leverage', 'POST', {
            symbol: symbol,
            leverage: maxLeverage
        });
        addLog(`✅ Đã thiết lập đòn bẩy ${maxLeverage}x cho ${symbol}.`);

        // 3. Lấy giá hiện tại
        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) {
            addLog(`❌ Không thể lấy giá hiện tại cho ${symbol}. Không mở lệnh.`);
            selectedCandidate = null; // Reset ứng viên đã chọn
            return;
        }
        addLog(`[DEBUG] Giá hiện tại của ${symbol}: ${currentPrice.toFixed(pricePrecision)}`);

        // 4. Tính toán khối lượng lệnh
        const capitalToUse = usdtBalance * CAPITAL_PERCENTAGE_PER_TRADE;
        let quantity = (capitalToUse * maxLeverage) / currentPrice;

        quantity = Math.floor(quantity / stepSize) * stepSize;
        quantity = parseFloat(quantity.toFixed(quantityPrecision));

        quantity = Math.max(minQty, quantity); 

        const currentNotional = quantity * currentPrice;
        if (currentNotional < minNotional) {
            addLog(`⚠️ Giá trị hợp đồng (${currentNotional.toFixed(pricePrecision)}) quá nhỏ so với minNotional (${minNotional}) cho ${symbol}. Không mở lệnh.`);
            selectedCandidate = null; // Reset ứng viên đã chọn
            return;
        }
        if (quantity <= 0) {
            addLog(`⚠️ Khối lượng tính toán cho ${symbol} là ${quantity}. Quá nhỏ hoặc không hợp lệ. Không mở lệnh.`);
            selectedCandidate = null; // Reset ứng viên đã chọn
            return;
        }

        // 5. Thực hiện lệnh mở vị thế SHORT (SELL MARKET)
        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: 'SELL', 
            type: 'MARKET',
            quantity: quantity,
            newOrderRespType: 'FULL' 
        });

        const entryPrice = parseFloat(orderResult.avgFillPrice || currentPrice);
        const openTime = new Date();
        
        addLog(`✅ Đã tạo lệnh SHORT với ${symbol} và sẽ đóng sau: ${MAX_POSITION_LIFETIME_SECONDS} giây (đếm ngược).`);
        
        // 6. Thiết lập TP/SL
        const positionValue = entryPrice * quantity; 
        const tpSlAmount = positionValue * TP_SL_RISK_PERCENTAGE;

        let tpPrice = entryPrice - (tpSlAmount / quantity); 
        let slPrice = entryPrice + (tpSlAmount / quantity); 
        
        tpPrice = parseFloat(tpPrice.toFixed(pricePrecision));
        slPrice = parseFloat(slPrice.toFixed(pricePrecision));

        addLog(`>>> Giá TP: ${tpPrice.toFixed(pricePrecision)}, Giá SL: ${slPrice.toFixed(pricePrecision)}`);

        // Lưu thông tin vị thế đang mở
        currentOpenPosition = {
            symbol: symbol,
            quantity: quantity,
            entryPrice: entryPrice,
            tpPrice: tpPrice,
            slPrice: slPrice,
            openTime: openTime,
            pricePrecision: pricePrecision,
            tickSize: tickSize
        };

        // Bắt đầu interval kiểm tra vị thế
        positionCheckInterval = setInterval(async () => {
            await manageOpenPosition();
        }, 1000); // Kiểm tra mỗi giây

        selectedCandidate = null; // Xóa ứng viên đã chọn sau khi mở lệnh

    } catch (error) {
        addLog(`❌ Lỗi khi mở lệnh SHORT cho ${symbol}: ${error.msg || error.message}`);
        selectedCandidate = null; // Reset ứng viên đã chọn nếu có lỗi
    }
}

// --- Hàm kiểm tra và quản lý vị thế đang mở ---
async function manageOpenPosition() {
    if (!currentOpenPosition) {
        clearInterval(positionCheckInterval);
        positionCheckInterval = null;
        return; 
    }

    const { symbol, quantity, tpPrice, slPrice, openTime, pricePrecision } = currentOpenPosition;

    try {
        const currentTime = new Date();
        const elapsedTimeSeconds = (currentTime.getTime() - openTime.getTime()) / 1000;

        const currentPrice = await getCurrentPrice(symbol);
        if (currentPrice === null) {
            addLog(`⚠️ Không thể lấy giá hiện tại cho ${symbol} khi quản lý vị thế. Sẽ thử lại sau.`);
            return;
        }
        
        // Log đếm ngược thời gian còn lại
        const timeLeft = MAX_POSITION_LIFETIME_SECONDS - Math.floor(elapsedTimeSeconds);
        // Chỉ log dòng đếm ngược khi có vị thế đang mở
        process.stdout.write(`>>> Vị thế ${symbol}: Đang mở, còn lại ${timeLeft} giây. Giá hiện tại: ${currentPrice.toFixed(pricePrecision)} | TP: ${tpPrice.toFixed(pricePrecision)} | SL: ${slPrice.toFixed(pricePrecision)}           \r`);


        if (currentPrice <= tpPrice) {
            addLog(`\n✅ Đã đóng vị thế SHORT ${symbol} với TP đạt tại giá ${currentPrice.toFixed(pricePrecision)}.`);
            await closeShortPosition(symbol, quantity, 'TP');
        } else if (currentPrice >= slPrice) {
            addLog(`\n❌ Đã đóng vị thế SHORT ${symbol} với SL đạt tại giá ${currentPrice.toFixed(pricePrecision)}.`);
            await closeShortPosition(symbol, quantity, 'SL');
        } else if (elapsedTimeSeconds >= MAX_POSITION_LIFETIME_SECONDS) {
            addLog(`\n⏱️ Đã đóng vị thế SHORT ${symbol} do hết thời gian tối đa (${MAX_POSITION_LIFETIME_SECONDS}s).`);
            await closeShortPosition(symbol, quantity, 'Hết thời gian');
        }

    } catch (error) {
        addLog(`❌ Lỗi khi quản lý vị thế mở cho ${symbol}: ${error.msg || error.message}`);
    }
}

// Hàm chạy logic tìm kiếm cơ hội
async function runTradingLogic() {
    if (currentOpenPosition) {
        addLog('>>> Có vị thế đang mở. Đang chờ đóng trước khi tìm cơ hội mới.');
        return;
    }

    addLog('>>> Đang quét tìm symbol có funding rate âm...');
    const accountInfo = await callSignedAPI('/fapi/v2/account', 'GET');
    const usdtAsset = accountInfo.assets.find(a => a.asset === 'USDT');
    const availableBalance = usdtAsset ? parseFloat(usdtAsset.availableBalance) : 0;

    if (availableBalance < MIN_USDT_BALANCE_TO_OPEN) {
        addLog(`⚠️ Số dư USDT khả dụng (${availableBalance.toFixed(2)}) dưới ngưỡng tối thiểu (${MIN_USDT_BALANCE_TO_OPEN}). Không tìm kiếm cơ hội.`);
        return;
    }

    const allFundingData = await callPublicAPI('/fapi/v1/premiumIndex');
    
    const candidates = [];
    for (const item of allFundingData) {
        const fundingRate = parseFloat(item.lastFundingRate);
        if (fundingRate < MIN_FUNDING_RATE_THRESHOLD && item.symbol.endsWith('USDT')) {
            const symbolInfo = await getSymbolFiltersAndMaxLeverage(item.symbol);
            if (symbolInfo && typeof symbolInfo.maxLeverage === 'number' && symbolInfo.maxLeverage > 1 && symbolInfo.minNotional < (availableBalance * CAPITAL_PERCENTAGE_PER_TRADE * symbolInfo.maxLeverage)) {
                candidates.push({
                    symbol: item.symbol,
                    fundingRate: fundingRate,
                    nextFundingTime: item.nextFundingTime, // Thời gian funding tiếp theo
                    maxLeverage: symbolInfo.maxLeverage
                });
            }
        }
    }

    if (candidates.length > 0) {
        candidates.sort((a, b) => a.fundingRate - b.fundingRate);
        selectedCandidate = candidates[0]; // Lưu ứng viên tốt nhất

        const capitalToUse = availableBalance * CAPITAL_PERCENTAGE_PER_TRADE;
        const currentPrice = await getCurrentPrice(selectedCandidate.symbol);
        if (!currentPrice) {
            addLog(`❌ Không thể lấy giá hiện tại cho ${selectedCandidate.symbol}. Bỏ qua cơ hội này.`);
            selectedCandidate = null; // Reset ứng viên
            return;
        }
        
        let estimatedQuantity = (capitalToUse * selectedCandidate.maxLeverage) / currentPrice;
        const symbolInfo = exchangeInfoCache[selectedCandidate.symbol]; // Lấy từ cache
        if (symbolInfo) {
             estimatedQuantity = Math.floor(estimatedQuantity / symbolInfo.stepSize) * symbolInfo.stepSize;
             estimatedQuantity = parseFloat(estimatedQuantity.toFixed(symbolInfo.quantityPrecision));
        }

        const now = new Date();
        // Tính thời gian đến phút :45
        let targetOpenTime = new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 
                                      now.getUTCHours(), OPEN_ORDER_MINUTE_UTC, TARGET_SECOND_UTC, TARGET_MILLISECOND_UTC);
        
        // Nếu thời gian :45 đã qua trong giờ hiện tại, chuyển sang :45 của giờ tiếp theo
        if (targetOpenTime.getTime() <= now.getTime()) {
            targetOpenTime.setUTCHours(targetOpenTime.getUTCHours() + 1);
        }

        const timeLeftMs = targetOpenTime.getTime() - now.getTime();
        const timeLeftSeconds = Math.max(0, Math.ceil(timeLeftMs / 1000));

        addLog(`\n✅ Đã chọn đồng coin: **${selectedCandidate.symbol}**`);
        addLog(`  + Funding Rate: **${selectedCandidate.fundingRate}**`);
        addLog(`  + Đòn bẩy tối đa: **${selectedCandidate.maxLeverage}x**`);
        addLog(`  + Số tiền dự kiến mở lệnh: **${capitalToUse.toFixed(2)} USDT** (Khối lượng ước tính: **${estimatedQuantity} ${selectedCandidate.symbol}**)`);
        addLog(`  + Lệnh sẽ được mở vào lúc **${targetOpenTime.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'UTC' })}:${String(targetOpenTime.getMilliseconds()).padStart(3, '0')} UTC** (còn khoảng **${timeLeftSeconds} giây** đếm ngược).`);
        
        // Chờ đến đúng thời điểm mở lệnh
        addLog(`>>> Đang chờ đến ${OPEN_ORDER_MINUTE_UTC} phút để mở lệnh...`);
        await delay(timeLeftMs);
        
        // Sau khi chờ, kiểm tra lại xem có vị thế nào được mở trong khi chờ không
        if (!currentOpenPosition) {
            await openShortPosition(selectedCandidate.symbol, selectedCandidate.fundingRate, availableBalance);
        } else {
            addLog(`⚠️ Đã có vị thế được mở trong khi chờ. Bỏ qua việc mở lệnh mới.`);
            selectedCandidate = null;
        }

    } else {
        addLog('>>> Không tìm thấy cơ hội Shorting với funding rate đủ tốt. Bot sẽ ngủ.');
        selectedCandidate = null; // Đảm bảo không có ứng viên nào được chọn
    }
}

// --- Hàm chính để chạy bot ---
async function startBot() {
    addLog('--- Khởi động Bot Futures Funding Rate ---');
    addLog('>>> Đang kiểm tra kết nối API Key với Binance Futures...');
    
    if (API_KEY === 'DÁN_API_KEY_CỦA_BẠN_VÀO_ĐÂY' || SECRET_KEY === 'DÁN_SECRET_KEY_CỦA_BẠN_VÀO_ĐÂY') {
        addLog('❌ LỖI CẤU HÌNH: Vui lòng thay thế "DÁN_API_KEY_CỦA_BẠN_VÀO_ĐÂY" và "DÁN_SECRET_KEY_CỦA_BẠN_VÀO_ĐÂY" bằng API Key và Secret Key THẬT của bạn.');
        return; // Dừng bot nếu cấu hình sai
    }

    try {
        await syncServerTime(); // Đồng bộ thời gian trước

        // Kiểm tra API Key bằng cách lấy thông tin tài khoản
        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtBalance = account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        addLog(`✅ API Key hoạt động bình thường! Số dư USDT khả dụng: ${parseFloat(usdtBalance).toFixed(2)}`);

        // Load exchange info một lần khi khởi động
        await getExchangeInfo(); 
        if (!exchangeInfoCache) { 
            addLog('❌ Không thể tải thông tin sàn (exchangeInfo). Bot sẽ dừng.');
            return;
        }

        const scheduleNextRun = async () => {
            if (currentOpenPosition) {
                // Nếu đang có vị thế mở, tiếp tục quản lý vị thế
                // Log đếm ngược được hiển thị trong manageOpenPosition
                setTimeout(scheduleNextRun, 1000); // Kiểm tra lại sau 1 giây
                return;
            }
            
            const now = new Date();
            let nextScanTime = new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 
                                   now.getUTCHours(), SCAN_MINUTE_UTC, TARGET_SECOND_UTC, TARGET_MILLISECOND_UTC);
            
            // Nếu thời gian quét đã qua trong giờ hiện tại, chuyển sang giờ tiếp theo
            if (nextScanTime.getTime() <= now.getTime()) {
                nextScanTime.setUTCHours(nextScanTime.getUTCHours() + 1);
            }
            
            const delayMs = nextScanTime.getTime() - now.getTime();

            addLog(`>>> Bot tạm dừng tới phiên quét tiếp theo lúc: ${nextScanTime.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'UTC' })}:${String(nextScanTime.getMilliseconds()).padStart(3, '0')} UTC.`);
            
            setTimeout(async () => {
                await runTradingLogic(); // Chạy logic tìm kiếm cơ hội
                scheduleNextRun(); // Lên lịch cho lần chạy tiếp theo
            }, delayMs);
        };

        scheduleNextRun(); // Bắt đầu chu kỳ
        
    } catch (error) {
        addLog('❌ [Lỗi nghiêm trọng khi khởi động bot] ' + (error.msg || error.message));
        addLog('   -> Bot sẽ dừng hoạt động. Vui lòng kiểm tra và khởi động lại.');
        addLog('   -> Gợi ý: Nếu lỗi là "-1022 Signature for this request is not valid.", hãy kiểm tra lại API Key/Secret và đặc biệt là danh sách IP trắng trên Binance.');
        addLog('   -> Gợi ý: Nếu lỗi là "-1021 Timestamp for this request is outside of the recvWindow.", hãy kiểm tra lại đồng bộ thời gian trên VPS (`sudo ntpdate pool.ntp.org` và `timedatectl status`).');
    }
}

// Khởi chạy bot
startBot();
