// bot_main.js - Phiên bản hoàn chỉnh bao gồm API Key/Secret

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
const API_KEY = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q'.trim(); 
const SECRET_KEY = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc'.trim();

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

    // addLog(`[DEBUG] Query String before signature: ${queryString}`); // Bỏ dòng này để log gọn hơn
    const signature = createSignature(queryString, SECRET_KEY);
    // addLog(`[DEBUG] Generated Signature: ${signature}`); // Bỏ dòng này để log gọn hơn

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
        // addLog(`[DEBUG] Request Method: ${method}, Path: ${requestPath}`); // Bỏ dòng này để log gọn hơn
        // if (method === 'POST') { addLog(`[DEBUG] Request Body (for POST): ${requestBody}`); } // Bỏ dòng này
        // addLog(`[DEBUG] Request Headers: ${JSON.stringify(headers)}`); // Bỏ dòng này

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
        // addLog(`[DEBUG getLeverageBracketForSymbol] Đang cố gắng lấy leverageBracket cho ${symbol}...`);
        const response = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol: symbol });

        if (response && Array.isArray(response) && response.length > 0) {
            const symbolData = response.find(item => item.symbol === symbol);

            if (symbolData && symbolData.brackets && Array.isArray(symbolData.brackets) && symbolData.brackets.length > 0) {
                const firstBracket = symbolData.brackets[0];
                if (firstBracket.maxInitialLeverage !== undefined) {
                    const maxLev = parseInt(firstBracket.maxInitialLeverage);
                    // addLog(`[DEBUG getLeverageBracketForSymbol] Đã lấy được đòn bẩy ${maxLev}x cho ${symbol} (từ maxInitialLeverage).`);
                    return maxLev;
                } else if (firstBracket.initialLeverage !== undefined) {
                    const maxLev = parseInt(firstBracket.initialLeverage);
                    // addLog(`[DEBUG getLeverageBracketForSymbol] Đã lấy được đòn bẩy ${maxLev}x cho ${symbol} (từ initialLeverage của bracket đầu tiên).`);
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
    // addLog('>>> Đã có cache exchangeInfo. Trả về cache.'); // Bỏ dòng này
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
const MIN_USDT_BALANCE_TO_OPEN = 0.1; // Số dư USDT tối thiểu để mở lệnh (ví dụ: 1 USDT)
const CAPITAL_PERCENTAGE_PER_TRADE = 0.5; // Phần trăm vốn sử dụng cho mỗi lệnh (ví dụ: 0.8 = 80%)
const MIN_FUNDING_RATE_THRESHOLD = -0.0001; // Ngưỡng funding rate âm tối thiểu để xem xét (ví dụ: -0.01% = -0.0001)
const TP_SL_RISK_PERCENTAGE = 0.005; // 0.5% rủi ro/lợi nhuận trên tổng giá trị vị thế (sau đòn bẩy)
const POSITION_CHECK_INTERVAL_SECONDS = 1; // Khoảng thời gian kiểm tra vị thế và TP/SL (tính bằng giây)
const MAX_POSITION_LIFETIME_SECONDS = 300; // Thời gian tối đa giữ một vị thế (tính bằng giây), ví dụ: 300 giây = 5 phút

let currentOpenPosition = null; // Biến toàn cục để theo dõi vị thế đang mở

// --- Hàm chính để đóng lệnh Short ---
async function closeShortPosition(symbol, quantityToClose) {
    addLog(`>>> Đang cố gắng đóng lệnh SHORT cho ${symbol} với khối lượng ${quantityToClose}.`);
    try {
        const symbolInfo = await getSymbolFiltersAndMaxLeverage(symbol);
        if (!symbolInfo) {
            addLog(`❌ Không thể lấy thông tin symbol cho ${symbol} để đóng lệnh.`);
            return;
        }

        const quantityPrecision = symbolInfo.quantityPrecision;
        const adjustedQuantity = parseFloat(quantityToClose.toFixed(quantityPrecision));

        // Kiểm tra xem vị thế còn tồn tại không trước khi cố gắng đóng
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPosition = positions.find(p => p.symbol === symbol);

        if (!currentPosition || parseFloat(currentPosition.positionAmt) === 0) {
            addLog(`>>> Không có vị thế SHORT để đóng cho ${symbol} hoặc đã đóng.`);
            currentOpenPosition = null;
            return;
        }

        addLog(`[DEBUG] Gửi lệnh đóng SHORT: symbol=${symbol}, side=BUY, type=MARKET, quantity=${adjustedQuantity}, reduceOnly=true`);
        
        await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: 'BUY', // Để đóng lệnh SHORT, cần lệnh BUY
            type: 'MARKET',
            quantity: adjustedQuantity,
            reduceOnly: 'true' // Đảm bảo chỉ giảm hoặc đóng vị thế hiện có
        });

        addLog(`✅ Đã gửi lệnh đóng vị thế SHORT thành công cho ${symbol} với khối lượng ${adjustedQuantity}.`);
        currentOpenPosition = null; // Đặt lại trạng thái không có vị thế mở
    } catch (error) {
        addLog(`❌ Lỗi khi đóng lệnh SHORT cho ${symbol}: ${error.msg || error.message}`);
    }
}

// --- Hàm chính để mở lệnh Short ---
async function openShortPosition(symbol, fundingRate, nextFundingTime) {
    addLog(`>>> Đang cố gắng mở lệnh SHORT cho ${symbol} với Funding Rate: ${fundingRate}`);
    try {
        // 1. Lấy số dư USDT khả dụng
        const accountInfo = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = accountInfo.assets.find(a => a.asset === 'USDT');
        const availableBalance = usdtAsset ? parseFloat(usdtAsset.availableBalance) : 0;
        addLog(`[DEBUG] Số dư USDT khả dụng: ${availableBalance.toFixed(2)}`);

        if (availableBalance < MIN_USDT_BALANCE_TO_OPEN) {
            addLog(`⚠️ Số dư USDT khả dụng (${availableBalance.toFixed(2)}) dưới ngưỡng tối thiểu (${MIN_USDT_BALANCE_TO_OPEN}). Không mở lệnh.`);
            return;
        }

        // 2. Lấy thông tin symbol và đòn bẩy
        const symbolInfo = await getSymbolFiltersAndMaxLeverage(symbol);
        if (!symbolInfo || typeof symbolInfo.maxLeverage !== 'number' || symbolInfo.maxLeverage <= 1) {
            addLog(`❌ Không thể lấy thông tin đòn bẩy hợp lệ cho ${symbol}. Không mở lệnh.`);
            return;
        }
        const maxLeverage = symbolInfo.maxLeverage;
        const pricePrecision = symbolInfo.pricePrecision;
        const quantityPrecision = symbolInfo.quantityPrecision;
        const minNotional = symbolInfo.minNotional;
        const minQty = symbolInfo.minQty;
        const stepSize = symbolInfo.stepSize;
        const tickSize = symbolInfo.tickSize;

        // 3. Đặt đòn bẩy cho cặp giao dịch
        addLog(`[DEBUG] Đang thiết lập đòn bẩy ${maxLeverage}x cho ${symbol}.`);
        await callSignedAPI('/fapi/v1/leverage', 'POST', {
            symbol: symbol,
            leverage: maxLeverage
        });
        addLog(`✅ Đã thiết lập đòn bẩy ${maxLeverage}x cho ${symbol}.`);

        // 4. Lấy giá hiện tại
        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) {
            addLog(`❌ Không thể lấy giá hiện tại cho ${symbol}. Không mở lệnh.`);
            return;
        }
        addLog(`[DEBUG] Giá hiện tại của ${symbol}: ${currentPrice.toFixed(pricePrecision)}`);

        // 5. Tính toán khối lượng lệnh
        const capitalToUse = availableBalance * CAPITAL_PERCENTAGE_PER_TRADE;
        let quantity = (capitalToUse * maxLeverage) / currentPrice;

        // Làm tròn số lượng theo stepSize và quantityPrecision của sàn
        quantity = Math.floor(quantity / stepSize) * stepSize;
        quantity = parseFloat(quantity.toFixed(quantityPrecision));

        // Đảm bảo khối lượng nằm trong giới hạn minQty
        quantity = Math.max(minQty, quantity); 
        // Không cần Math.min(maxQty, quantity) ở đây, vì vốn của bạn thường sẽ không cho phép vượt maxQty

        const currentNotional = quantity * currentPrice;
        if (currentNotional < minNotional) {
            addLog(`⚠️ Giá trị hợp đồng (${currentNotional.toFixed(pricePrecision)}) quá nhỏ so với minNotional (${minNotional}) cho ${symbol}. Không mở lệnh.`);
            return;
        }
        if (quantity <= 0) {
            addLog(`⚠️ Khối lượng tính toán cho ${symbol} là ${quantity}. Quá nhỏ hoặc không hợp lệ. Không mở lệnh.`);
            return;
        }

        // 6. Thực hiện lệnh mở vị thế SHORT (SELL MARKET)
        addLog(`[DEBUG] Gửi lệnh SHORT: symbol=${symbol}, quantity=${quantity}, price=${currentPrice.toFixed(pricePrecision)}`);
        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol: symbol,
            side: 'SELL', // Mở lệnh SHORT là lệnh SELL
            type: 'MARKET',
            quantity: quantity,
            newOrderRespType: 'FULL' // Để nhận đủ thông tin về lệnh
        });

        const entryPrice = parseFloat(orderResult.avgFillPrice || currentPrice);
        const openTime = new Date();
        const formattedOpenTime = `${openTime.toLocaleDateString('en-GB')} ${openTime.toLocaleTimeString('en-US', { hour12: false })}.${String(openTime.getMilliseconds()).padStart(3, '0')}`;
        
        addLog(`✅ Đã mở lệnh SHORT thành công cho ${symbol} vào lúc ${formattedOpenTime}`);
        addLog(`  + Funding Rate: ${fundingRate}`);
        addLog(`  + Đòn bẩy sử dụng: ${maxLeverage}x`);
        addLog(`  + Vốn USDT vào lệnh: ${capitalToUse.toFixed(2)} USDT`);
        addLog(`  + Khối lượng: ${quantity} ${symbol}`);
        addLog(`  + Giá vào lệnh: ${entryPrice.toFixed(pricePrecision)}`);

        // 7. Thiết lập TP/SL và theo dõi vị thế
        const positionValue = entryPrice * quantity; // Giá trị của vị thế (không đòn bẩy)
        const tpSlAmount = positionValue * TP_SL_RISK_PERCENTAGE;

        let tpPrice = entryPrice - (tpSlAmount / quantity); // Short: TP thấp hơn giá vào
        let slPrice = entryPrice + (tpSlAmount / quantity); // Short: SL cao hơn giá vào

        // Làm tròn TP/SL theo tickSize của sàn
        tpPrice = Math.floor(tpPrice / tickSize) * tickSize;
        slPrice = Math.ceil(slPrice / tickSize) * tickSize;
        
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

    } catch (error) {
        addLog(`❌ Lỗi khi mở lệnh SHORT cho ${symbol}: ${error.msg || error.message}`);
    }
}

// --- Hàm kiểm tra và quản lý vị thế đang mở ---
async function manageOpenPosition() {
    if (!currentOpenPosition) {
        return; // Không có vị thế nào đang mở để quản lý
    }

    const { symbol, quantity, tpPrice, slPrice, openTime, pricePrecision, tickSize } = currentOpenPosition;

    try {
        const currentTime = new Date();
        const elapsedTimeSeconds = (currentTime.getTime() - openTime.getTime()) / 1000;

        const currentPrice = await getCurrentPrice(symbol);
        if (currentPrice === null) {
            addLog(`⚠️ Không thể lấy giá hiện tại cho ${symbol} khi quản lý vị thế. Sẽ thử lại sau.`);
            return;
        }

        // Hiển thị trạng thái kiểm tra trên cùng một dòng
        process.stdout.write(`>>> Đang kiểm tra vị thế ${symbol} (${quantity} | ${currentPrice.toFixed(pricePrecision)}). Đã mở ${elapsedTimeSeconds.toFixed(0)}/${MAX_POSITION_LIFETIME_SECONDS} giây.     \r`);

        if (currentPrice <= tpPrice) {
            addLog(`\n✅ Vị thế ${symbol} đạt TP tại giá ${currentPrice.toFixed(pricePrecision)}. Đóng lệnh.`);
            await closeShortPosition(symbol, quantity);
        } else if (currentPrice >= slPrice) {
            addLog(`\n❌ Vị thế ${symbol} đạt SL tại giá ${currentPrice.toFixed(pricePrecision)}. Đóng lệnh.`);
            await closeShortPosition(symbol, quantity);
        } else if (elapsedTimeSeconds >= MAX_POSITION_LIFETIME_SECONDS) {
            addLog(`\n⏱️ Vị thế ${symbol} vượt quá thời gian tối đa (${MAX_POSITION_LIFETIME_SECONDS}s). Đóng lệnh.`);
            await closeShortPosition(symbol, quantity);
        }

    } catch (error) {
        addLog(`❌ Lỗi khi quản lý vị thế mở cho ${symbol}: ${error.msg || error.message}`);
        // Nếu có lỗi nghiêm trọng, coi như vị thế này không còn quản lý được
        // Để tránh loop lỗi, có thể reset currentOpenPosition sau vài lần lỗi liên tiếp
        // Tuy nhiên, ở đây chúng ta giữ nguyên để bot cố gắng đóng trong lần tiếp theo
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
        if (!exchangeInfoCache) { // Đảm bảo cache đã được tải
            addLog('❌ Không thể tải thông tin sàn (exchangeInfo). Bot sẽ dừng.');
            return;
        }

        // Vòng lặp chính của bot
        setInterval(async () => {
            if (currentOpenPosition) {
                // Nếu có vị thế đang mở, ưu tiên quản lý nó
                await manageOpenPosition();
            } else {
                // Nếu không có vị thế mở, tìm kiếm cơ hội mới
                addLog('>>> Không có vị thế mở. Đang tìm kiếm symbol có funding rate âm...');
                const allFundingData = await callPublicAPI('/fapi/v1/premiumIndex');
                
                const candidates = [];
                for (const item of allFundingData) {
                    const fundingRate = parseFloat(item.lastFundingRate);
                    // Chỉ xem xét các cặp có funding rate âm và phải là USDT pair
                    if (fundingRate < MIN_FUNDING_RATE_THRESHOLD && item.symbol.endsWith('USDT')) {
                        // Lấy max leverage cho symbol để kiểm tra tính khả dụng
                        const symbolInfo = await getSymbolFiltersAndMaxLeverage(item.symbol);
                        // Chỉ thêm vào danh sách nếu có maxLeverage hợp lệ và minNotional >= MIN_USDT_BALANCE_TO_OPEN
                        // (hoặc một ngưỡng hợp lý để đảm bảo lệnh có thể mở)
                        if (symbolInfo && typeof symbolInfo.maxLeverage === 'number' && symbolInfo.maxLeverage > 1 && symbolInfo.minNotional < (usdtBalance * CAPITAL_PERCENTAGE_PER_TRADE * symbolInfo.maxLeverage)) {
                            candidates.push({
                                symbol: item.symbol,
                                fundingRate: fundingRate,
                                nextFundingTime: item.nextFundingTime,
                                maxLeverage: symbolInfo.maxLeverage
                            });
                        }
                    }
                }

                if (candidates.length > 0) {
                    // Sắp xếp các cặp theo funding rate giảm dần (âm nhất lên đầu)
                    candidates.sort((a, b) => a.fundingRate - b.fundingRate);
                    const bestCandidate = candidates[0];

                    addLog(`✅ Đã tìm thấy cơ hội tốt nhất: ${bestCandidate.symbol} (Funding Rate: ${bestCandidate.fundingRate}, Max Leverage: ${bestCandidate.maxLeverage}x)`);
                    await openShortPosition(bestCandidate.symbol, bestCandidate.fundingRate, bestCandidate.nextFundingTime);
                } else {
                    addLog('>>> Không tìm thấy cơ hội Shorting với funding rate đủ tốt. Đang chờ...');
                }
            }
        }, POSITION_CHECK_INTERVAL_SECONDS * 1000); // Lặp lại sau mỗi X giây
        
    } catch (error) {
        addLog('❌ [Lỗi nghiêm trọng khi khởi động bot] ' + (error.msg || error.message));
        addLog('   -> Bot sẽ dừng hoạt động. Vui lòng kiểm tra và khởi động lại.');
        addLog('   -> Gợi ý: Nếu lỗi là "-1022 Signature for this request is not valid.", hãy kiểm tra lại API Key/Secret và đặc biệt là danh sách IP trắng trên Binance.');
        addLog('   -> Gợi ý: Nếu lỗi là "-1021 Timestamp for this request is outside of the recvWindow.", hãy kiểm tra lại đồng bộ thời gian trên VPS (`sudo ntpdate pool.ntp.org` và `timedatectl status`).');
    }
}

// Khởi chạy bot
startBot();
