const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const crypto = require('crypto');
const Binance = require('node-binance-api');

const PORT = 5001;

// ----- CẤU HÌNH -----
const EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];
const FUNDING_DIFFERENCE_THRESHOLD = 0.002; // Giá trị này có thể không còn được sử dụng trực tiếp trong calculateArbitrageOpportunities
const MINIMUM_PNL_THRESHOLD = 15; // Lợi nhuận ước tính tối thiểu (tính bằng USD)
const IMMINENT_THRESHOLD_MINUTES = 15; // Thời gian còn lại đến funding time để đánh dấu là "imminent"
const LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES = 30;
const FUNDING_HISTORY_FULL_REFRESH_INTERVAL_MINUTES = 10; // Không được sử dụng trong bản hiện tại (chỉ có masterLoop)
const FUNDING_HISTORY_CACHE_TTL_MINUTES = 60; // Không được sử dụng trong bản hiện tại

// === QUAN TRỌNG: ĐIỀN API KEY VÀ SECRET VÀO ĐÂY ===
// API Key/Secret của Binance (đã cập nhật theo yêu cầu của bạn - HÃY ĐẢM BẢO IP CỦA SERVER ĐƯỢC WHITELIST TRÊN BINANCE)
const binanceApiKey = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q';
const binanceApiSecret = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88TzvmC3SpT9nEf4fcDf0pEnFzoTc';
// API Key/Secret của BingX (ĐÃ CẬP NHẬT CHÍNH XÁC TỪ HÌNH ẢNH BẠN CUNG CẤP - HÃY NHỚ CẤP THÊM QUYỀN "PERPETUAL FUTURES" TRÊN SÀN)
// Đảm bảo không có khoảng trắng thừa ở cuối API Key/Secret!
const bingxApiKey = 'p29V4jTkBelypG9Acd1t4dp6GqHwyTjYcOBq9AC501HVo0f4EN4m6Uv5F2CIr7dNaNTRvaQM0CqcPXfEFuA';
const bingxApiSecret = 'iTkMpmySRwQSawYBU3D5uFRZhH4UBdRYLOcPVrWbdAYa0go6Nohye1n7PS4XOcOmxQXYnUs1YRei5RvLPg';
// API Key/Secret/Passphrase của OKX (vui lòng kiểm tra lại thật kỹ trên sàn: key, secret, passphrase và thời gian server)
const okxApiKey = 'c2f77f8b-a71a-41a3-8caf-3459dbdbaa0b';
const okxApiSecret = '6337107745922F1D457C472297513220';
const okxPassword = 'Altf4enter$';
// API Key/Secret của Bitget (vui lòng kiểm tra lại thật kỹ trên sàn)
const bitgetApiKey = 'bg_a1ab0142c295779ac21123d5b59378e9';
const bitgetApiSecret = 'c12fbe21cd82274bde810b3d4aa7be778e5eee30ca5f47cf8ffc9b950787c961';
const bitgetApiPassword = 'Altf4enter';


// ----- BIẾN TOÀN CỤC -----
let leverageCache = {};
let fundingHistoryCache = {}; // Not actively used for storing history in the current logic, but declared
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;
let loopTimeoutId = null;
let lastFullFundingHistoryRefreshTime = 0; // Not actively used

// Khởi tạo client Binance riêng bằng node-binance-api
const binanceClient = new Binance().options({
    APIKEY: binanceApiKey,
    APISECRET: binanceApiSecret
});

// Khởi tạo các sàn giao dịch bằng CCXT
const exchanges = {};
EXCHANGE_IDS.forEach(id => {
    const exchangeClass = ccxt[id];
    const config = { 'options': { 'defaultType': 'swap' } };

    // Cấu hình API Key/Secret/Passphrase
    if (id === 'binanceusdm' && binanceApiKey && binanceApiSecret) {
        config.apiKey = binanceApiKey; config.secret = binanceApiSecret;
        console.log(`[AUTH] Đã cấu hình CCXT cho Binance.`);
    } else if (id === 'bingx' && bingxApiKey && bingxApiSecret) {
        config.apiKey = bingxApiKey; config.secret = bingxApiSecret;
        console.log(`[AUTH] Đã cấu hình HMAC cho BingX.`);
    } else if (id === 'okx' && okxApiKey && okxApiSecret) {
        config.apiKey = okxApiKey; config.secret = okxApiSecret;
        if(okxPassword) config.password = okxPassword;
        console.log(`[AUTH] Đã cấu hình HMAC cho OKX.`);
    } else if (id === 'bitget' && bitgetApiKey && bitgetApiSecret) {
        config.apiKey = bitgetApiKey; config.secret = bitgetApiSecret;
        if(bitgetApiPassword) config.password = bitgetApiPassword;
        console.log(`[AUTH] Đã cấu hình HMAC cho Bitget.`);
    } else {
        console.warn(`[AUTH] ⚠️ Không có API Key/Secret hoặc thiếu cho ${id.toUpperCase()}. Sẽ chỉ dùng public API nếu có thể.`);
    }

    exchanges[id] = new exchangeClass(config);
    // Enable rate limit by default for CCXT exchanges (unless specified in config)
    exchanges[id].enableRateLimit = true;
});


const cleanSymbol = (symbol) => symbol.replace('/USDT', '').replace(':USDT', '').replace(/USDT$/, '');

// Hàm hỗ trợ định dạng ký hiệu theo yêu cầu của BingX API (ví dụ: BTC-USDT)
const formatBingXApiSymbol = (ccxtSymbol) => {
    let base = ccxtSymbol
        .replace(/\/USDT/g, '')
        .replace(/:USDT/g, '')
        .replace(/\/USDC/g, '')
        .replace(/:USDC/g, '')
        .replace(/-USDT$/g, '')
        .replace(/-USDC$/g, '');
    return `${base.toUpperCase()}-USDT`;
};


// Hàm hỗ trợ ký cho BingX direct API (nếu cần dùng các endpoint private)
function signBingX(queryString, secret) {
    return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

// === LOGIC LẤY ĐÒN BẨY CHO BINANCE (Bằng node-binance-api) ===
async function getBinanceLeverageDirectAPI() {
    let leverages = {};
    try {
        console.log('[DEBUG] BINANCEUSDM: Đang lấy đòn bẩy bằng node-binance-api (futuresLeverageBracket)...');

        const leverageInfo = await binanceClient.futuresLeverageBracket();

        if (!leverageInfo || !Array.isArray(leverageInfo)) {
            console.warn(`[CACHE] ⚠️ BINANCEUSDM: futuresLeverageBracket không trả về dữ liệu hợp lệ (không phải mảng).`);
            return {};
        }

        leverageInfo.forEach(info => {
            const originalSymbol = info.symbol;
            const cleanS = cleanSymbol(originalSymbol);
            if (info.brackets && info.brackets.length > 0) {
                const rawLeverage = info.brackets[0].initialLeverage;
                const parsedLeverage = parseFloat(rawLeverage);
                if (!isNaN(parsedLeverage) && parsedLeverage > 0) {
                    leverages[cleanS] = parsedLeverage;
                } else {
                    console.warn(`[CACHE] ⚠️ BINANCEUSDM: Đòn bẩy không hợp lệ cho ${originalSymbol}: '${rawLeverage}' (parse: ${parsedLeverage})`);
                }
            } else {
                console.warn(`[CACHE] ⚠️ BINANCEUSDM: Không có thông tin bracket cho ${originalSymbol}.`);
            }
        });

        console.log(`[CACHE] ✅ BINANCEUSDM: Lấy thành công ${Object.values(leverages).filter(v => v !== null && v > 0).length} đòn bẩy bằng node-binance-api.`);
        return leverages;

    } catch (e) {
        console.error(`[CACHE] ❌ BINANCEUSDM: Lỗi khi lấy đòn bẩy bằng node-binance-api: ${e.message}. VUI LÒNG KIỂM TRA QUYỀN HẠN API (ENABLE FUTURES) VÀ IP WHITELIST CỦA BẠN TRÊN BINANCE. Stack: ${e.stack}`);
        return {};
    }
}

// === LOGIC LẤY ĐÒN BẨY CHO BINGX (GỌI DIRECT API TỪNG SYMBOL VỚI KÝ TÊN) ===
async function getBingXLeverageDirectAPI() {
    console.log('[DEBUG] BINGX: Đang cố gắng lấy đòn bẩy bằng REST API trực tiếp /swap/v2/trade/leverage (từng symbol)...');
    const leverages = {};
    if (!bingxApiKey || !bingxApiSecret) {
        console.error('[CACHE] ❌ BINGX: Thiếu API Key hoặc Secret để lấy đòn bẩy qua API /trade/leverage. Vui lòng kiểm tra lại cấu hình.');
        return {};
    }

    try {
        const bingxCCXT = exchanges['bingx'];
        await bingxCCXT.loadMarkets(true);
        const markets = Object.values(bingxCCXT.markets).filter(m => m.swap && m.quote === 'USDT');

        if (markets.length === 0) {
            console.warn(`[CACHE] ⚠️ BINGX: loadMarkets trả về 0 thị trường USDT Swap. Không thể lấy đòn bẩy.`);
            return {};
        }

        const BINGX_REQUEST_DELAY_MS = 100;
        for (const market of markets) {
            const ccxtSymbol = market.symbol; // Ký hiệu từ CCXT (ví dụ: BTC/USDT)
            const cleanS = cleanSymbol(ccxtSymbol); // Ký hiệu đã làm sạch để lưu cache (ví dụ: BTC)
            const bingxApiSymbol = formatBingXApiSymbol(ccxtSymbol); // Ký hiệu cho API BingX (ví dụ: BTC-USDT)

            try {
                const timestamp = Date.now().toString(); // Đảm bảo timestamp là string
                const recvWindow = "10000"; // Đảm bảo recvWindow là string. Tăng lên 10000 hoặc 20000 nếu vẫn lỗi thời gian

                // ĐÃ SỬA LỖI ĐÁNH MÁY QUAN TRỌNG: Thay '×tamp' bằng '×tamp'
                const queryString = `recvWindow=${recvWindow}&symbol=${bingxApiSymbol}×tamp=${timestamp}`;
                const signature = signBingX(queryString, bingxApiSecret);

                const url = `https://open-api.bingx.com/openApi/swap/v2/trade/leverage?${queryString}&signature=${signature}`;

                console.log(`[DEBUG] BINGX API Call URL (Leverage): ${url}`); // Log URL để debug

                const res = await fetch(url, { method: "GET", headers: { "X-BX-APIKEY": bingxApiKey } });

                // Thêm log chi tiết nếu res không OK
                if (!res.ok) {
                    const errorText = await res.text();
                    console.error(`[CACHE] ❌ BINGX: Phản hồi API không OK cho ${bingxApiSymbol} (Leverage). Status: ${res.status}, Status Text: ${res.statusText}. Phản hồi thô: ${errorText}. VUI LÒNG KIỂM TRA API KEY, SECRET, QUYỀN HẠN (PERPETUAL FUTURES) VÀ ĐỒNG BỘ THỜI GIAN MÁY CHỦ.`);
                    leverages[cleanS] = null;
                    await new Promise(resolve => setTimeout(resolve, BINGX_REQUEST_DELAY_MS));
                    continue; // Bỏ qua symbol này và tiếp tục vòng lặp
                }

                const json = await res.json();

                // LOG DEBUG NÀY HIỆN THỊ DỮ LIỆU THÔ MÀ BINGX TRẢ VỀ
                console.log(`[DEBUG] BINGX Raw response for ${bingxApiSymbol} from /trade/leverage:`, JSON.stringify(json, null, 2));

                let maxLeverageFound = null; // Khởi tạo để đảm bảo giá trị đúng
                if (json && json.code === 0 && json.data) {
                    const longLev = parseFloat(json.data.maxLongLeverage);
                    const shortLev = parseFloat(json.data.maxShortLeverage);

                    console.log(`[DEBUG] BINGX: Đã tính đòn bẩy cho ${bingxApiSymbol}: longLev=${longLev}, shortLev=${shortLev}.`);

                    if (!isNaN(longLev) && !isNaN(shortLev) && (longLev > 0 || shortLev > 0)) {
                        maxLeverageFound = Math.max(longLev, shortLev);
                    } else {
                        console.warn(`[CACHE] ⚠️ BINGX: Dữ liệu đòn bẩy (maxLongLeverage: '${json.data.maxLongLeverage}', maxShortLeverage: '${json.data.maxShortLeverage}') cho ${bingxApiSymbol} không phải số hoặc bằng 0, hoặc không lớn hơn 0.`);
                    }
                } else {
                    console.warn(`[CACHE] ⚠️ BINGX: Phản hồi API không thành công hoặc không có trường 'data' cho ${bingxApiSymbol}. Code: ${json.code}, Msg: ${json.msg || 'Không có thông báo lỗi.'}.`);
                }

                console.log(`[DEBUG] BINGX: Đã gán đòn bẩy cho ${cleanS}: ${maxLeverageFound}.`);
                leverages[cleanS] = maxLeverageFound;


            } catch (e) {
                console.error(`[CACHE] ❌ BINGX: Lỗi khi lấy đòn bẩy cho ${bingxApiSymbol} từ /trade/leverage: ${e.message}. Stack: ${e.stack}. VUI LÒNG KIỂM TRA API KEY VÀ SECRET CÓ ĐÚNG KHÔNG VÀ ĐÃ CẤP QUYỀN "PERPETUAL FUTURES" CHƯA. VÀ ĐỒNG BỘ THỜI GIAN MÁY CHỦ CỦA BẠN.`);
                leverages[cleanS] = null; // Đảm bảo gán null nếu có lỗi để tránh lỗi undefined
            }
            await new Promise(resolve => setTimeout(resolve, BINGX_REQUEST_DELAY_MS));
        }
        console.log(`[CACHE] ✅ BINGX: Hoàn tất lấy đòn bẩy. Đã lấy thành công ${Object.values(leverages).filter(v => v !== null && v > 0).length} đòn bẩy qua REST API /trade/leverage.`);
        return leverages;

    } catch (e) {
        console.error(`[CACHE] ❌ Lỗi tổng quát khi lấy đòn bẩy cho BINGX: ${e.message}. Stack: ${e.stack}. VUI LÒNG KIỂM TRA API KEY BINGX.`);
        return {};
    }
}

// Hàm này giờ chỉ dùng cho OKX và Bitget (dùng qua CCXT loadMarkets)
function getMaxLeverageFromMarketInfo(market, exchangeId) {
    if (typeof market?.limits?.leverage?.max === 'number' && market.limits.leverage.max > 0) {
        return market.limits.leverage.max;
    }
    // Một số sàn có thể để thông tin đòn bẩy trong market.info với các tên khác nhau
    if (typeof market?.info === 'object' && market.info !== null) {
        // Kiểm tra các trường phổ biến
        const possibleLeverageKeys = ['maxLeverage', 'leverage', 'initialLeverage', 'max_leverage'];
        for (const key of possibleLeverageKeys) {
            if (market.info.hasOwnProperty(key)) {
                const value = market.info[key];
                const leverage = parseInt(value, 10);
                if (!isNaN(leverage) && leverage > 1) { // Đòn bẩy phải lớn hơn 1
                    return leverage;
                }
            }
        }
    }
    return null; // Trả về null nếu không tìm thấy đòn bẩy hợp lệ
}

async function initializeLeverageCache() {
    console.log(`[CACHE] Bắt đầu làm mới bộ nhớ đệm đòn bẩy...`);
    const newCache = {};
    await Promise.all(EXCHANGE_IDS.map(async (id) => {
        const exchange = exchanges[id];
        newCache[id] = {};
        let count = 0;
        try {
            if (id === 'binanceusdm') {
                const leverages = await getBinanceLeverageDirectAPI();
                newCache[id] = leverages;
                count = Object.values(leverages).filter(v => v !== null && v > 0).length;
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Tổng số ${count} đòn bẩy đã lấy.`);
            } else if (id === 'bingx') {
                const leverages = await getBingXLeverageDirectAPI();
                newCache[id] = leverages;
                // Object.values(leverages) sẽ là các số (hoặc null) từ getBingXLeverageDirectAPI
                count = Object.values(leverages).filter(v => typeof v === 'number' && v > 0).length;
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Tổng số ${count} đòn bẩy đã lấy.`);
            }
            // OKX và Bitget ưu tiên dùng fetchLeverageTiers nếu có
            else if (exchange.has['fetchLeverageTiers']) {
                const leverageTiers = await exchange.fetchLeverageTiers();
                for (const symbol in leverageTiers) {
                    const tiers = leverageTiers[symbol];
                    if (Array.isArray(tiers) && tiers.length > 0) {
                        // Lấy đòn bẩy cao nhất từ các bậc
                        const maxLeverage = Math.max(...tiers.map(t => t.leverage));
                        const parsedMaxLeverage = parseInt(maxLeverage, 10);
                        if (!isNaN(parsedMaxLeverage) && parsedMaxLeverage > 0) {
                            newCache[id][cleanSymbol(symbol)] = parsedMaxLeverage;
                            count++;
                        } else {
                            console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Đòn bẩy không hợp lệ cho ${symbol} từ fetchLeverageTiers (parse: ${parsedMaxLeverage}).`);
                        }
                    } else {
                        console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: 'fetchLeverageTiers' không có thông tin bậc đòn bẩy hợp lệ cho ${symbol}.`);
                    }
                }
                if (count > 0) { console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${count} đòn bẩy bằng 'fetchLeverageTiers'.`); }
                else { console.log(`[CACHE] ⚠️ ${id.toUpperCase()}: 'fetchLeverageTiers' không trả về dữ liệu hợp lệ nào.`); }
            }
            // Dự phòng: dùng loadMarkets nếu fetchLeverageTiers không có hoặc thất bại
            else {
                await exchange.loadMarkets(true);
                for (const market of Object.values(exchange.markets)) {
                    if (market.swap && market.quote === 'USDT') {
                        const symbolCleaned = cleanSymbol(market.symbol);
                        const maxLeverage = getMaxLeverageFromMarketInfo(market, id);
                        newCache[id][symbolCleaned] = maxLeverage; // Luôn gán, dù là null
                        if (maxLeverage !== null && maxLeverage > 0) {
                            count++;
                        } else {
                            // Thêm log chi tiết cho các trường hợp không lấy được đòn bẩy
                            console.warn(`[CACHE] ⚠️ ${id.toUpperCase()}: Đòn bẩy không hợp lệ hoặc không tìm thấy cho ${market.symbol} (Clean: ${symbolCleaned}). Dữ liệu Market (limits.leverage hoặc info): ${JSON.stringify({ limits: market.limits?.leverage, info: market.info })}`);
                        }
                    }
                }
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${count} đòn bẩy bằng 'loadMarkets' (dự phòng).`);
            }
        } catch (e) {
            console.error(`[CACHE] ❌ Lỗi nghiêm trọng khi lấy đòn bẩy cho ${id.toUpperCase()}: ${e.message}. Stack: ${e.stack}. VUI LÒNG KIỂM TRA API KEY, SECRET VÀ PASSPHRASE CỦA OKX/BITGET (nếu có), VÀ ĐỒNG BỘ THỜI GIAN SERVER CỦA BẠN.`);
            newCache[id] = {}; // Đảm bảo đặt lại cache cho sàn này nếu có lỗi nghiêm trọng
        }
    }));
    leverageCache = newCache;
    console.log(`[CACHE] 🎉 Hoàn tất làm mới bộ nhớ đệm đòn bẩy. Cache hiện tại: ${JSON.stringify(leverageCache, null, 2)}`);
}

// Hàm lấy funding rates trực tiếp từ Binance Premium Index (đã chuyển sang HTTPS)
async function getBinanceFundingRatesDirectAPI() {
    try {
        const fundingRatesRaw = await binanceClient.futuresFundingRate();

        if (!Array.isArray(fundingRatesRaw)) {
            console.warn(`[CACHE] ⚠️ BINANCEUSDM: futuresFundingRate không trả về mảng. Dữ liệu thô: ${JSON.stringify(fundingRatesRaw)}`);
            return [];
        }

        const filteredData = fundingRatesRaw.map(item => ({
            symbol: item.symbol,
            fundingRate: parseFloat(item.fundingRate),
            fundingTimestamp: item.fundingTime // fundingTime là timestamp UTC của lần funding tiếp theo
        })).filter(item =>
            item.symbol.endsWith('USDT') &&
            !isNaN(item.fundingRate) &&
            typeof item.fundingTimestamp === 'number' &&
            item.fundingTimestamp > 0
        );
        return filteredData;

    } catch (e) {
        console.error(`[CACHE] ❌ BINANCEUSDM: Lỗi khi lấy funding rates bằng node-binance-api: ${e.message}. Stack: ${e.stack}. VUI LÒNG KIỂM TRA IP WHITELIST CỦA BẠN TRÊN BINANCE.`);
        return [];
    }
}

// Hàm lấy funding rates trực tiếp từ BingX (đã sửa endpoint)
function getBingXFundingRatesDirectAPI() {
    return new Promise(async (resolve, reject) => {
        if (!bingxApiKey) {
            console.error('[CACHE] ❌ BINGX: Thiếu API Key để lấy funding rate qua API. Vui lòng kiểm tra lại cấu hình.');
            return resolve([]); // Trả về mảng rỗng nếu không có key
        }

        try {
            const bingxCCXT = exchanges['bingx'];
            await bingxCCXT.loadMarkets(true); // Cần load markets để có danh sách symbol
            const markets = Object.values(bingxCCXT.markets).filter(m => m.swap && m.quote === 'USDT');

            if (markets.length === 0) {
                console.warn(`[CACHE] ⚠️ BINGX: loadMarkets trả về 0 thị trường USDT Swap. Không thể lấy funding rate.`);
                return resolve([]); // Trả về mảng rỗng nếu không có market
            }

            const BINGX_REQUEST_DELAY_MS = 100;
            const processedData = [];

            for (const market of markets) {
                const originalSymbol = market.symbol;
                const cleanS = cleanSymbol(originalSymbol);
                const bingxApiSymbol = formatBingXApiSymbol(originalSymbol); // Ký hiệu cho API BingX

                // Endpoint /quote/fundingRate là public nên không cần signature và timestamp
                const url = `https://open-api.bingx.com/openApi/swap/v2/quote/fundingRate?symbol=${bingxApiSymbol}`;

                try {
                    const res = await fetch(url, { method: "GET", headers: { "X-BX-APIKEY": bingxApiKey } });

                    // Thêm log chi tiết nếu res không OK
                    if (!res.ok) {
                        const errorText = await res.text();
                        console.error(`[CACHE] ❌ BINGX: Phản hồi API không OK cho ${bingxApiSymbol} (Funding Rate). Status: ${res.status}, Status Text: ${res.statusText}. Phản hồi thô: ${errorText}.`);
                        await new Promise(resolve => setTimeout(resolve, BINGX_REQUEST_DELAY_MS));
                        continue; // Bỏ qua symbol này và tiếp tục vòng lặp
                    }

                    const json = await res.json();

                    // LOG DEBUG NÀY HIỆN THỊ DỮ LIỆU THÔ MÀ BINGX TRẢ VỀ
                    console.log(`[DEBUG] BINGX Raw response for Funding Rate ${bingxApiSymbol}:`, JSON.stringify(json, null, 2));

                    if (json && json.code === 0 && json.data) {
                        const fundingRate = parseFloat(json.data.fundingRate);
                        const fundingTimestamp = parseInt(json.data.nextFundingTime, 10);
                        if (!isNaN(fundingRate) && !isNaN(fundingTimestamp) && fundingTimestamp > 0) {
                            processedData.push({
                                symbol: cleanS, // Lưu ký hiệu đã làm sạch vào processedData
                                fundingRate: fundingRate,
                                fundingTimestamp: fundingTimestamp
                            });
                        } else {
                            console.warn(`[CACHE] ⚠️ BINGX: Funding rate hoặc timestamp không hợp lệ cho ${bingxApiSymbol}. Data: ${JSON.stringify(json.data)}`);
                        }
                    } else {
                        console.warn(`[CACHE] ⚠️ BINGX: Lỗi hoặc dữ liệu không hợp lệ từ /quote/fundingRate cho ${bingxApiSymbol}. Code: ${json.code}, Msg: ${json.msg || 'Không có thông báo lỗi.'}`);
                    }
                } catch (e) {
                    console.error(`[CACHE] ❌ BINGX: Lỗi khi lấy funding rate cho ${bingxApiSymbol} từ /quote/fundingRate: ${e.message}. Stack: ${e.stack}`);
                }
                await new Promise(resolve => setTimeout(resolve, BINGX_REQUEST_DELAY_MS)); // Delay giữa các request
            }
            resolve(processedData);

        } catch (e) {
            reject(new Error(`Lỗi tổng quát khi lấy API BingX Funding Rate: ${e.message}. Stack: ${e.stack}. VUI LÒNG KIỂM TRA API KEY BINGX.`));
        }
    });
}


async function fetchFundingRatesForAllExchanges() {
    const freshData = {};
    await Promise.all(EXCHANGE_IDS.map(async (id) => {
        try {
            const exchange = exchanges[id];
            let fundingRatesRaw;
            let processedRates = {};

            if (id === 'binanceusdm') {
                fundingRatesRaw = await getBinanceFundingRatesDirectAPI();
                for (const item of fundingRatesRaw) {
                    processedRates[cleanSymbol(item.symbol)] = {
                        symbol: cleanSymbol(item.symbol),
                        fundingRate: parseFloat(item.fundingRate),
                        fundingTimestamp: item.fundingTimestamp,
                        maxLeverage: leverageCache[id]?.[cleanSymbol(item.symbol)] || null
                    };
                }
            } else if (id === 'bingx') {
                fundingRatesRaw = await getBingXFundingRatesDirectAPI();
                for (const item of fundingRatesRaw) {
                    processedRates[item.symbol] = { // item.symbol đã được cleanSymbol từ bên trong getBingXFundingRatesDirectAPI
                        symbol: item.symbol,
                        fundingRate: item.fundingRate,
                        fundingTimestamp: item.fundingTimestamp,
                        maxLeverage: leverageCache[id]?.[item.symbol] || null
                    };
                }
            }
            else {
                // Sử dụng CCXT fetchFundingRates cho OKX và Bitget
                fundingRatesRaw = await exchange.fetchFundingRates();
                for (const rate of Object.values(fundingRatesRaw)) {
                    const symbolCleaned = cleanSymbol(rate.symbol);
                    const maxLeverage = leverageCache[id]?.[symbolCleaned] || null;

                    // Sử dụng timestamp từ sàn nếu có, nếu không thì tính toán theo chuẩn
                    const fundingTimestamp = rate.fundingTimestamp || rate.nextFundingTime || calculateNextStandardFundingTime();

                    processedRates[symbolCleaned] = {
                        symbol: symbolCleaned,
                        fundingRate: rate.fundingRate,
                        fundingTimestamp: fundingTimestamp,
                        maxLeverage: maxLeverage
                    };
                }
            }
            console.log(`[DATA] ✅ ${id.toUpperCase()}: Đã lấy thành công ${Object.keys(processedRates).length} funding rates.`);
            return { id, status: 'success', rates: processedRates };
        } catch (e) {
            if (!(e instanceof ccxt.RequestTimeout || e instanceof ccxt.NetworkError)) {
                // Log lỗi chi tiết trừ các lỗi timeout/network tạm thời
                console.error(`- Lỗi nghiêm trọng khi lấy funding từ ${id.toUpperCase()}: ${e.message}. Stack: ${e.stack}. VUI LÒNG KIỂM TRA KẾT NỐI MẠNG, API KEY VÀ QUYỀN HẠN CỦA SÀN.`);
            } else {
                console.warn(`- Lỗi tạm thời (timeout/network) khi lấy funding từ ${id.toUpperCase()}: ${e.message}. Sẽ thử lại.`);
            }
            return { id, status: 'error', rates: {} };
        }
    })).then(results => {
        results.forEach(result => {
            if (result.status === 'success') {
                freshData[result.id] = { rates: result.rates };
            } else {
                // Giữ lại dữ liệu cũ nếu có lỗi để tránh mất toàn bộ dữ liệu khi một sàn bị lỗi
                console.warn(`[DATA] ⚠️ ${result.id.toUpperCase()}: Không thể cập nhật funding rates. Sử dụng dữ liệu cũ nếu có.`);
                if (!exchangeData[result.id]) { // Nếu chưa có dữ liệu cũ, khởi tạo rỗng
                    exchangeData[result.id] = { rates: {} };
                }
            }
        });
    });
    return freshData;
}

// Fallback function for next funding time if exchange API doesn't provide it
function calculateNextStandardFundingTime() {
    const now = new Date();
    const fundingHoursUTC = [0, 8, 16]; // Funding times at 00:00, 08:00, 16:00 UTC
    let nextHourUTC = fundingHoursUTC.find(h => now.getUTCHours() < h);

    const nextFundingDate = new Date(now);
    if (nextHourUTC === undefined) { // If current hour is past 16:00 UTC, next funding is 00:00 UTC next day
        nextHourUTC = fundingHoursUTC[0];
        nextFundingDate.setUTCDate(now.getUTCDate() + 1);
    }
    nextFundingDate.setUTCHours(nextHourUTC, 0, 0, 0); // Set to the next funding hour, minute, second, millisecond

    return nextFundingDate.getTime();
}


function calculateArbitrageOpportunities() {
    const allFoundOpportunities = [];
    // Deep copy exchangeData to avoid issues with concurrent modification if needed (though not strictly necessary here)
    const currentExchangeData = JSON.parse(JSON.stringify(exchangeData));

    for (let i = 0; i < EXCHANGE_IDS.length; i++) {
        for (let j = i + 1; j < EXCHANGE_IDS.length; j++) {
            const exchange1Id = EXCHANGE_IDS[i], exchange2Id = EXCHANGE_IDS[j];
            const exchange1Rates = currentExchangeData[exchange1Id]?.rates, exchange2Rates = currentExchangeData[exchange2Id]?.rates;

            if (!exchange1Rates || !exchange2Rates) {
                console.log(`[CALC] Bỏ qua cặp ${exchange1Id}/${exchange2Id} do thiếu dữ liệu rates.`);
                continue;
            }

            const commonSymbols = Object.keys(exchange1Rates).filter(symbol => exchange2Rates[symbol]);

            if (commonSymbols.length === 0) {
                console.log(`[CALC] Không tìm thấy symbol chung giữa ${exchange1Id} và ${exchange2Id}.`);
                continue;
            }

            for (const symbol of commonSymbols) {
                const rate1Data = exchange1Rates[symbol];
                const rate2Data = exchange2Rates[symbol];

                // Kiểm tra loại số và giá trị dương của đòn bẩy
                if (typeof rate1Data.maxLeverage !== 'number' || rate1Data.maxLeverage <= 0 ||
                    typeof rate2Data.maxLeverage !== 'number' || rate2Data.maxLeverage <= 0) {
                    // console.log(`[CALC] Bỏ qua ${symbol} trên ${exchange1Id}/${exchange2Id} do đòn bẩy không hợp lệ: ${rate1Data.maxLeverage} / ${rate2Data.maxLeverage}`);
                    continue;
                }

                if (!rate1Data.fundingRate || !rate2Data.fundingRate ||
                    !rate1Data.fundingTimestamp || !rate2Data.fundingTimestamp) {
                    // console.log(`[CALC] Bỏ qua ${symbol} trên ${exchange1Id}/${exchange2Id} do thiếu funding rate hoặc timestamp.`);
                    continue;
                }

                let longExchange, shortExchange, longRate, shortRate;
                if (rate1Data.fundingRate > rate2Data.fundingRate) {
                    // Sàn 1 có funding rate cao hơn => Short ở sàn 1, Long ở sàn 2
                    shortExchange = exchange1Id; shortRate = rate1Data;
                    longExchange = exchange2Id; longRate = rate2Data;
                } else {
                    // Sàn 2 có funding rate cao hơn (hoặc bằng) => Short ở sàn 2, Long ở sàn 1
                    shortExchange = exchange2Id; shortRate = rate2Data;
                    longExchange = exchange1Id; longRate = rate1Data;
                }

                const fundingDiff = shortRate.fundingRate - longRate.fundingRate;

                // Chỉ xem xét nếu có sự khác biệt dương đáng kể
                if (fundingDiff <= FUNDING_DIFFERENCE_THRESHOLD) {
                    continue;
                }

                const commonLeverage = Math.min(longRate.maxLeverage, shortRate.maxLeverage);
                const estimatedPnl = fundingDiff * commonLeverage * 100; // PnL ước tính cho 100 USDT, hoặc 1% của 100 USDT nếu fundingRate là %

                if (estimatedPnl >= MINIMUM_PNL_THRESHOLD) {
                    // Lấy thời gian funding muộn nhất giữa hai sàn
                    const finalFundingTime = Math.max(rate1Data.fundingTimestamp, rate2Data.fundingTimestamp);

                    const minutesUntilFunding = (finalFundingTime - Date.now()) / (1000 * 60);
                    const isImminent = minutesUntilFunding > 0 && minutesUntilFunding <= IMMINENT_THRESHOLD_MINUTES;

                    allFoundOpportunities.push({
                        coin: symbol,
                        exchanges: `${shortExchange.replace('usdm', '')} / ${longExchange.replace('usdm', '')}`,
                        fundingDiff: parseFloat(fundingDiff.toFixed(6)),
                        nextFundingTime: finalFundingTime,
                        nextFundingTimeUTC: new Date(finalFundingTime).toISOString(), // Thêm định dạng ISO cho dễ đọc
                        commonLeverage: parseFloat(commonLeverage.toFixed(2)),
                        estimatedPnl: parseFloat(estimatedPnl.toFixed(2)),
                        isImminent: isImminent,
                        details: {
                            shortExchange: shortExchange,
                            shortRate: shortRate.fundingRate,
                            shortLeverage: shortRate.maxLeverage,
                            longExchange: longExchange,
                            longRate: longRate.fundingRate,
                            longLeverage: longRate.maxLeverage,
                            minutesUntilFunding: parseFloat(minutesUntilFunding.toFixed(1))
                        }
                    });
                }
            }
        }
    }
    arbitrageOpportunities = allFoundOpportunities.sort((a, b) => {
        // Ưu tiên các cơ hội sắp đến giờ funding, sau đó đến PnL cao hơn
        if (a.nextFundingTime < b.nextFundingTime) return -1;
        if (a.nextFundingTime > b.nextFundingTime) return 1;
        return b.estimatedPnl - a.estimatedPnl;
    });
}

async function masterLoop() {
    console.log(`\n[LOOP] Bắt đầu vòng lặp cập nhật lúc ${new Date().toLocaleTimeString()} (UTC: ${new Date().toUTCString()})...`);

    // Bước 1: Lấy funding rates mới nhất từ tất cả các sàn
    const freshFundingData = await fetchFundingRatesForAllExchanges();
    exchangeData = freshFundingData; // Cập nhật dữ liệu funding rates

    // Bước 2: Tính toán cơ hội arbitrage
    calculateArbitrageOpportunities();
    lastFullUpdateTimestamp = new Date().toISOString();
    console.log(`[LOOP]   => Tìm thấy ${arbitrageOpportunities.length} cơ hội. Vòng lặp hoàn tất.`);
    scheduleNextLoop();
}

function scheduleNextLoop() {
    clearTimeout(loopTimeoutId); // Xóa bộ đếm thời gian cũ nếu có
    const now = new Date();
    const currentMinutes = now.getMinutes();
    const currentSeconds = now.getSeconds();

    let delaySeconds;
    let nextRunReason = "Lịch trình mặc định (đầu phút tiếp theo)";

    // Mục tiêu: Chạy lại mỗi phút, nhưng có thể điều chỉnh để chạy sớm hơn ở các phút gần đến 00, 08, 16 UTC.
    // Funding rates thường được cập nhật vào 00, 08, 16 UTC.
    // Ta muốn chạy lại vòng lặp càng gần các mốc đó càng tốt.
    // Vì vòng lặp lấy dữ liệu tốn thời gian, ta có thể đặt lịch sớm hơn một chút.
    // Ví dụ, nếu funding là lúc X:00, ta có thể chạy lại lúc X-1:55 hoặc X-1:30

    // Đặt lịch để chạy lại vào giây thứ 5 của phút tiếp theo
    delaySeconds = (60 - currentSeconds + 5) % 60;
    if (delaySeconds === 0) delaySeconds = 60; // Nếu đang ở giây thứ 5, chạy sau 60s nữa

    // Nếu thời gian hiện tại gần các mốc funding chính (00, 08, 16 UTC), có thể chạy sớm hơn một chút.
    // Điều này phức tạp hơn vì cần biết thời gian funding chính xác của từng coin.
    // Với mục đích hiện tại, chạy mỗi phút là đủ, và data.nextFundingTime sẽ cho biết funding time chính xác.
    // Tuy nhiên, để đảm bảo dữ liệu funding rate mới nhất, ta có thể đặt lịch chạy khoảng 5 giây sau mỗi phút.
    // Để cho đơn giản và vẫn hiệu quả, chỉ cần chạy lại mỗi phút là được.
    // Hoặc, nếu muốn chạy ngay sau khi funding rate cập nhật, ta cần theo dõi funding time gần nhất của các sàn.

    // Với lịch trình hiện tại (chạy lại sau 60 giây từ giây hiện tại, hoặc ở giây thứ 5 của phút tiếp theo),
    // nó sẽ đảm bảo cập nhật đều đặn mỗi phút.

    const delayMs = delaySeconds * 1000;
    console.log(`[SCHEDULER] ${nextRunReason}. Vòng lặp kế tiếp sau ${delaySeconds.toFixed(1)} giây (chạy vào giây thứ ${(now.getSeconds() + delaySeconds) % 60} của phút tiếp theo).`);
    loopTimeoutId = setTimeout(masterLoop, delayMs);
}

const server = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            if (err) {
                res.writeHead(500);
                res.end('Lỗi khi đọc index.html');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
            res.end(content);
        });
    } else if (req.url === '/api/data' && req.method === 'GET') {
        const responseData = {
            lastUpdated: lastFullUpdateTimestamp,
            arbitrageData: arbitrageOpportunities,
            rawRates: {
                binance: Object.values(exchangeData.binanceusdm?.rates || {}),
                bingx: Object.values(exchangeData.bingx?.rates || {}),
                okx: Object.values(exchangeData.okx?.rates || {}),
                bitget: Object.values(exchangeData.bitget?.rates || {}),
            }
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseData));
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

server.listen(PORT, async () => {
    console.log(`✅ Máy chủ dữ liệu (Đã Fix lỗi BingX và cải thiện log Bitget) đang chạy tại http://localhost:${PORT}`);
    // Khởi tạo cache đòn bẩy lần đầu
    await initializeLeverageCache();
    // Bắt đầu vòng lặp chính để cập nhật dữ liệu
    await masterLoop();
    // Đặt lịch làm mới cache đòn bẩy định kỳ (ít thường xuyên hơn funding rates)
    setInterval(initializeLeverageCache, LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES * 60 * 1000);
});
