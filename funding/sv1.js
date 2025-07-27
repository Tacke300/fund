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
const FUNDING_DIFFERENCE_THRESHOLD = 0.002;
const MINIMUM_PNL_THRESHOLD = 15;
const IMMINENT_THRESHOLD_MINUTES = 15;
const LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES = 30;
const FUNDING_HISTORY_FULL_REFRESH_INTERVAL_MINUTES = 10;
const FUNDING_HISTORY_CACHE_TTL_MINUTES = 60;

// === QUAN TRỌNG: ĐIỀN API KEY VÀ SECRET VÀO ĐÂY ===
// API Key/Secret của Binance (đã cập nhật theo yêu cầu của bạn - HÃY ĐẢM BẢO IP CỦA SERVER ĐƯỢC WHITELIST TRÊN BINANCE)
const binanceApiKey = 'cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q';
const binanceApiSecret = 'oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc';
// API Key/Secret của BingX (ĐÃ CẬP NHẬT CHÍNH XÁC TỪ HÌNH ẢNH BẠN CUNG CẤP - ĐÃ XÓA KHOẢNG TRẮNG THỪA - HÃY NHỚ CẤP THÊM QUYỀN "PERPETUAL FUTURES" TRÊN SÀN)
const bingxApiKey = 'p29V4jTkBelypG9Acd1t4dp6GqHwyTjYcOBq9AC501HVo0f4EN4m6Uv5F2CIr7dNaNTRvaQM0CqcPXfEFuA'; // ĐÃ SỬA: XÓA KHOẢNG TRẮNG THỪA
const bingxApiSecret = 'iTkMpmySRwQSawYBU3D5uFRZhH4UBdRYLOCPWrWbdAYa0go6Nohye1n7PS4XOcOmxQXYnUs1YRei5RvLPg'; // ĐÃ SỬA: XÓA KHOẢNG TRẮNG THỪA
const okxApiKey = 'c2f77f8b-a71a-41a3-8caf-3459dbdbaa0b';
const okxApiSecret = '6337107745922F1D457C472297513220';
const okxPassword = 'Altf4enter$';
const bitgetApiKey = 'bg_a1ab0142c295779ac21123d5b59378e9';
const bitgetApiSecret = 'c12fbe21cd82274bde810b3d4aa7be778e5eee30ca5f47cf8ffc9b950787c961';
const bitgetApiPassword = 'Altf4enter';


// ----- BIẾN TOÀN CỤC -----
let leverageCache = {};
let fundingHistoryCache = {};
let exchangeData = {};
let arbitrageOpportunities = [];
let lastFullUpdateTimestamp = null;
let loopTimeoutId = null;
let lastFullFundingHistoryRefreshTime = 0;

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
        exchanges[id] = new exchangeClass(config);
        console.warn(`[AUTH] ⚠️ Không có API Key/Secret hoặc thiếu cho ${id.toUpperCase()}. Sẽ chỉ dùng public API nếu có thể.`);
    }

    if (!exchanges[id]) {
        exchanges[id] = new exchangeClass(config);
    }
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
        console.error(`[CACHE] ❌ BINANCEUSDM: Lỗi khi lấy đòn bẩy bằng node-binance-api: ${e.message}. VUI LÒNG KIỂM TRA QUYỀN HẠN API (ENABLE FUTURES) VÀ IP WHITELIST CỦA BẠN TRÊN BINANCE.`);
        return {};
    }
}

// === LOGIC LẤY ĐÒN BẨY CHO BINGX (GỌI DIRECT API TỪNG SYMBOL VỚI KÝ TÊN) ===
async function getBingXLeverageDirectAPI() {
    console.log('[DEBUG] BINGX: Đang cố gắng lấy đòn bẩy bằng REST API trực tiếp /swap/v2/trade/leverage (từng symbol)...');
    const leverages = {}; // Khởi tạo object leverages
    if (!bingxApiKey || !bingxApiSecret) {
        console.error('[CACHE] ❌ BINGX: Thiếu API Key hoặc Secret để lấy đòn bẩy qua API /trade/leverage.');
        return {};
    }

    try {
        const bingxCCXT = exchanges['bingx'];
        // LOG NÀY SẼ CHỈ RA NẾU loadMarkets CỦA CCXT GẶP LỖI XÁC THỰC (SIGNATURE)
        console.log(`[DEBUG] BINGX: Bắt đầu loadMarkets(true) qua CCXT.`);
        await bingxCCXT.loadMarkets(true);
        console.log(`[DEBUG] BINGX: Đã hoàn tất loadMarkets(true) qua CCXT.`);
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
                const recvWindow = "5000"; // Đảm bảo recvWindow là string. Có thể thử "10000" hoặc "20000" nếu cần

                // ĐÃ SỬA LỖI ĐÁNH MÁY QUAN TRỌNG TẠI ĐÂY: Thêm '&' trước 'timestamp'
                const queryString = `recvWindow=${recvWindow}&symbol=${bingxApiSymbol}xtamp=${timestamp}`;
                const signature = signBingX(queryString, bingxApiSecret);

                const url = `https://open-api.bingx.com/openApi/swap/v2/trade/leverage?${queryString}&signature=${signature}`;

                const res = await fetch(url, { method: "GET", headers: { "X-BX-APIKEY": bingxApiKey } });

                // Thêm log chi tiết nếu res không OK
                if (!res.ok) {
                    const errorText = await res.text();
                    console.error(`[CACHE] ❌ BINGX: Phản hồi API không OK cho ${bingxApiSymbol} (Leverage). Status: ${res.status}, Status Text: ${res.statusText}. Phản hồi thô: ${errorText}`);
                    leverages[cleanS] = null; // Gán null nếu lỗi
                    await new Promise(resolve => setTimeout(resolve, BINGX_REQUEST_DELAY_MS));
                    continue; // Bỏ qua symbol này và tiếp tục vòng lặp
                }

                const json = await res.json();

                console.log(`[DEBUG] BINGX API Call URL: ${url}`);
                // LOG DEBUG NÀY HIỆN THỊ DỮ LIỆU THÔ MÀ BINGX TRẢ VỀ
                console.log(`[DEBUG] BINGX Raw response for ${bingxApiSymbol} from /trade/leverage:`, JSON.stringify(json, null, 2));

                let maxLeverageFound = null; // Khởi tạo để đảm bảo giá trị đúng
                if (json && json.code === 0 && json.data) {
                    // LẤY ĐÚNG TRƯỜNG DỮ LIỆU VÀ XỬ LÝ LÀ SỐ (NUMBER) NHƯ LOG BẠN CUNG CẤP
                    const longLev = parseFloat(json.data.maxLongLeverage);
                    const shortLev = parseFloat(json.data.maxShortLeverage);

                    // THÊM LOG DEBUG ĐỂ XEM GIÁ TRỊ PARSE ĐƯỢC VÀ KIỂM TRA ĐIỀU KIỆN
                    console.log(`[DEBUG] BINGX: Đã tính đòn bẩy cho ${bingxApiSymbol}: maxLongLeverage=${json.data.maxLongLeverage} (parsed: ${longLev}), maxShortLeverage=${json.data.maxShortLeverage} (parsed: ${shortLev}).`);

                    if (!isNaN(longLev) && !isNaN(shortLev) && (longLev > 0 || shortLev > 0)) {
                        maxLeverageFound = Math.max(longLev, shortLev);
                    } else {
                        console.warn(`[CACHE] ⚠️ BINGX: Dữ liệu đòn bẩy không hợp lệ cho ${bingxApiSymbol} (parsed longLev: ${longLev}, parsed shortLev: ${shortLev}).`);
                    }
                } else {
                    console.warn(`[CACHE] ⚠️ BINGX: Phản hồi API không thành công hoặc không có trường 'data' cho ${bingxApiSymbol}. Code: ${json.code}, Msg: ${json.msg || 'Không có thông báo lỗi.'}`);
                }

                // THÊM DÒNG LOG NÀY ĐỂ DEBUG TRỰC TIẾP TÌNH TRẠNG LƯU TRỮ ĐÒN BẨY CỦA BINGX VÀO OBJECT LEVERAGES
                console.log(`[DEBUG] BINGX: Gán đòn bẩy cho ${cleanS}: ${maxLeverageFound}. (Hiện tại leverages['${cleanS}']: ${leverages[cleanS]})`);
                leverages[cleanS] = maxLeverageFound;


            } catch (e) {
                console.error(`[CACHE] ❌ BINGX: Lỗi khi lấy đòn bẩy cho ${bingxApiSymbol} từ /trade/leverage: ${e.message}. Stack: ${e.stack}. VUI LÒNG KIỂM TRA API KEY VÀ SECRET CÓ ĐÚNG KHÔNG VÀ ĐÃ CẤP QUYỀN "PERPETUAL FUTURES" CHƯA.`);
                leverages[cleanS] = null; // Đảm bảo gán null nếu có lỗi để tránh lỗi undefined
            }
            await new Promise(resolve => setTimeout(resolve, BINGX_REQUEST_DELAY_MS));
        }

        // THÊM DÒNG LOG NÀY ĐỂ XEM TOÀN BỘ OBJECT LEVERAGES TRƯỚC KHI TRẢ VỀ
        console.log(`[DEBUG] BINGX: Object 'leverages' đã thu thập được sau vòng lặp:`, JSON.stringify(leverages, null, 2));

        console.log(`[CACHE] ✅ BINGX: Hoàn tất lấy đòn bẩy. Đã lấy thành công ${Object.values(leverages).filter(v => v !== null && v > 0).length} đòn bẩy qua REST API /trade/leverage.`);
        return leverages; // Trả về object leverages đã thu thập


    } catch (e) {
        console.error(`[CACHE] ❌ Lỗi tổng quát khi lấy đòn bẩy cho BINGX: ${e.message}. Stack: ${e.stack}. VUI LÒNG KIỂM TRA API KEY BINGX.`);
        return {};
    }
}

// Hàm này giờ chỉ dùng cho OKX và Bitget (dùng qua CCXT loadMarkets)
function getMaxLeverageFromMarketInfo(market, exchangeId) {
    if (typeof market?.limits?.leverage?.max === 'number' && market.limits.leverage.max > 0) return market.limits.leverage.max;
    if (typeof market?.info === 'object' && market.info !== null) {
        for (const key in market.info) {
            if (key.toLowerCase().includes('leverage')) {
                const value = market.info[key];
                const leverage = parseInt(value, 10);
                if (!isNaN(leverage) && leverage > 1) return leverage;
            }
        }
    }
    return null;
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
                // THÊM LOG NÀY ĐỂ XEM DỮ LIỆU ĐÒN BẨY SAU KHI ĐƯỢC initializeLeverageCache NHẬN
                console.log(`[DEBUG] initializeLeverageCache nhận BingX leverages:`, JSON.stringify(leverages, null, 2));

                newCache[id] = leverages; // Gán leverages vào newCache[id]
                // THÊM LOG NÀY ĐỂ XEM TRẠNG THÁI CỦA newCache[id] SAU KHI GÁN
                console.log(`[DEBUG] initializeLeverageCache: newCache['bingx'] sau khi gán:`, JSON.stringify(newCache[id], null, 2));

                count = Object.values(leverages).filter(v => v !== null && v > 0).length; // Bây giờ v đã là số
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Tổng số ${count} đòn bẩy đã lấy.`);
            }
            else if (exchange.has['fetchLeverageTiers']) {
                const leverageTiers = await exchange.fetchLeverageTiers();
                for (const symbol in leverageTiers) {
                    const tiers = leverageTiers[symbol];
                    if (Array.isArray(tiers) && tiers.length > 0) {
                        const maxLeverage = Math.max(...tiers.map(t => t.leverage));
                        const parsedMaxLeverage = parseInt(maxLeverage, 10);
                        if (!isNaN(parsedMaxLeverage) && parsedMaxLeverage > 0) {
                            newCache[id][cleanSymbol(symbol)] = parsedMaxLeverage;
                            count++;
                        }
                    }
                }
                if (count > 0) { console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${count} đòn bẩy bằng 'fetchLeverageTiers'.`); }
                else { console.log(`[CACHE] ⚠️ ${id.toUpperCase()}: 'fetchLeverageTiers' không trả về dữ liệu hợp lệ.`); }
            } else {
                await exchange.loadMarkets(true);
                for (const market of Object.values(exchange.markets)) {
                    if (market.swap && market.quote === 'USDT') {
                        const symbol = cleanSymbol(market.symbol);
                        const maxLeverage = getMaxLeverageFromMarketInfo(market, id);
                        newCache[id][symbol] = maxLeverage;
                        if (maxLeverage !== null && maxLeverage > 0) count++;
                    }
                }
                console.log(`[CACHE] ✅ ${id.toUpperCase()}: Lấy thành công ${count} đòn bẩy bằng 'loadMarkets' (dự phòng).`);
            }
        } catch (e) {
            console.error(`[CACHE] ❌ Lỗi nghiêm trọng khi lấy đòn bẩy cho ${id.toUpperCase()}: ${e.message}. Stack: ${e.stack}. VUI LÒNG KIỂM TRA API KEY, SECRET VÀ PASSPHRASE CỦA OKX/BITGET, VÀ ĐỒNG BỘ THỜI GIAN SERVER.`);
            newCache[id] = {};
        }
    }));
    leverageCache = newCache; // Gán newCache vào leverageCache
    console.log(`[DEBUG] 'leverageCache' sau khi cập nhật cuối cùng:`, JSON.stringify(leverageCache, null, 2)); // LOG TRẠNG THÁI CUỐI CÙNG CỦA CACHE
    console.log(`[CACHE] 🎉 Hoàn tất làm mới bộ nhớ đệm đòn bẩy.`);
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
            fundingTimestamp: item.fundingTime
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
            console.error('[CACHE] ❌ BINGX: Thiếu API Key để lấy funding rate qua API.');
            return reject(new Error('Thiếu API Key cho BingX.'));
        }

        try {
            const bingxCCXT = exchanges['bingx'];
            console.log(`[DEBUG] BINGX: Bắt đầu loadMarkets(true) qua CCXT cho Funding.`); // Log cho Funding
            await bingxCCXT.loadMarkets(true);
            console.log(`[DEBUG] BINGX: Đã hoàn tất loadMarkets(true) qua CCXT cho Funding.`); // Log cho Funding
            const markets = Object.values(bingxCCXT.markets).filter(m => m.swap && m.quote === 'USDT');

            if (markets.length === 0) {
                console.warn(`[CACHE] ⚠️ BINGX: loadMarkets trả về 0 thị trường USDT Swap. Không thể lấy funding rate.`);
                return resolve([]); // Trả về mảng rỗng nếu không có market
            }

            const BINGX_REQUEST_DELAY_MS = 100;
            const processedData = []; // Khởi tạo mảng processedData

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
                        console.error(`[CACHE] ❌ BINGX: Phản hồi API không OK cho ${bingxApiSymbol} (Funding Rate). Status: ${res.status}, Status Text: ${res.statusText}. Phản hồi thô: ${errorText}`);
                        await new Promise(resolve => setTimeout(resolve, BINGX_REQUEST_DELAY_MS));
                        continue; // Bỏ qua symbol này và tiếp tục vòng lặp
                    }

                    const json = await res.json();

                    // LOG DEBUG NÀY HIỆN THỊ DỮ LIỆU THÔ MÀ BINGX TRẢ VỀ
                    console.log(`[DEBUG] BINGX Raw response for Funding Rate ${bingxApiSymbol}:`, JSON.stringify(json, null, 2));

                    if (json && json.code === 0 && json.data) {
                        const fundingRate = parseFloat(json.data.fundingRate);
                        const fundingTimestamp = parseInt(json.data.nextFundingTime, 10);

                        console.log(`[DEBUG] BINGX: Parsing funding for ${bingxApiSymbol} -> fundingRate: ${json.data.fundingRate} (parsed: ${fundingRate}), nextFundingTime: ${json.data.nextFundingTime} (parsed: ${fundingTimestamp}).`); // THÊM DÒNG NÀY

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
            // THÊM DÒNG LOG NÀY ĐỂ XEM TOÀN BỘ MẢNG processedData TRƯỚC KHI TRẢ VỀ
            console.log(`[DEBUG] BINGX: Mảng 'processedData' đã thu thập được sau vòng lặp:`, JSON.stringify(processedData, null, 2));
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
                // THÊM LOG NÀY ĐỂ XEM DỮ LIỆU FUNDING SAU KHI ĐƯỢC fetchFundingRatesForAllExchanges NHẬN
                console.log(`[DEBUG] fetchFundingRatesForAllExchanges nhận BingX funding rates:`, JSON.stringify(fundingRatesRaw, null, 2));

                for (const item of fundingRatesRaw) {
                    processedRates[item.symbol] = {
                        symbol: item.symbol,
                        fundingRate: item.fundingRate,
                        fundingTimestamp: item.fundingTimestamp,
                        maxLeverage: leverageCache[id]?.[item.symbol] || null
                    };
                }
                // THÊM LOG NÀY ĐỂ XEM TRẠNG THÁI CỦA processedRates CHO BINGX SAU KHI XỬ LÝ
                console.log(`[DEBUG] fetchFundingRatesForAllExchanges: processedRates['bingx'] sau khi xử lý:`, JSON.stringify(processedRates, null, 2));

            }
            else {
                fundingRatesRaw = await exchange.fetchFundingRates();
                for (const rate of Object.values(fundingRatesRaw)) {
                    const symbol = cleanSymbol(rate.symbol);
                    const maxLeverage = leverageCache[id]?.[symbol] || null;

                    const fundingTimestamp = rate.fundingTimestamp || rate.nextFundingTime || calculateNextStandardFundingTime();

                    processedRates[symbol] = {
                        symbol: symbol,
                        fundingRate: rate.fundingRate,
                        fundingTimestamp: fundingTimestamp,
                        maxLeverage: maxLeverage
                    };
                }
            }
            return { id, status: 'success', rates: processedRates };
        } catch (e) {
            if (!(e instanceof ccxt.RequestTimeout || e instanceof ccxt.NetworkError)) {
                console.error(`- Lỗi nghiêm trọng khi lấy funding từ ${id.toUpperCase()}: ${e.message}. Stack: ${e.stack}`);
            }
            return { id, status: 'error', rates: {} };
        }
    })).then(results => {
        results.forEach(result => { if (result.status === 'success') { freshData[result.id] = { rates: result.rates }; }});
    });
    // LOG CUỐI CÙNG TRƯỚC KHI TRẢ VỀ freshData
    console.log(`[DEBUG] 'freshData' sau khi thu thập từ tất cả các sàn:`, JSON.stringify(freshData, null, 2));
    return freshData;
}

function calculateNextStandardFundingTime() {
    const now = new Date();
    const fundingHoursUTC = [0, 8, 16];
    let nextHourUTC = fundingHoursUTC.find(h => now.getUTCHours() < h) ?? fundingHoursUTC[0];
    const nextFundingDate = new Date(now);
    nextFundingDate.setUTCHours(nextHourUTC, 0, 0, 0);
    if(now.getUTCHours() >= fundingHoursUTC[fundingHoursUTC.length - 1]) {
        nextFundingDate.setUTCDate(now.getUTCDate() + 1);
    }
    return nextFundingDate.getTime();
}


function calculateArbitrageOpportunities() {
    const allFoundOpportunities = [];
    // LOG NÀY SẼ CHO THẤY 'exchangeData' NGAY TRƯỚC KHI TÍNH TOÁN CƠ HỘI ARBITRAGE
    console.log(`[DEBUG] 'exchangeData' trước khi tính toán cơ hội arbitrage:`, JSON.stringify(exchangeData, null, 2));

    const currentExchangeData = JSON.parse(JSON.stringify(exchangeData));
    for (let i = 0; i < EXCHANGE_IDS.length; i++) {
        for (let j = i + 1; j < EXCHANGE_IDS.length; j++) {
            const exchange1Id = EXCHANGE_IDS[i], exchange2Id = EXCHANGE_IDS[j];
            const exchange1Rates = currentExchangeData[exchange1Id]?.rates, exchange2Rates = currentExchangeData[exchange2Id]?.rates;
            if (!exchange1Rates || !exchange2Rates) continue;
            const commonSymbols = Object.keys(exchange1Rates).filter(symbol => exchange2Rates[symbol]);
            for (const symbol of commonSymbols) {
                const rate1Data = exchange1Rates[symbol], rate2Data = exchange2Rates[symbol];
                // Kiểm tra loại số và giá trị dương của đòn bẩy
                if (typeof rate1Data.maxLeverage !== 'number' || rate1Data.maxLeverage <= 0 ||
                    typeof rate2Data.maxLeverage !== 'number' || rate2Data.maxLeverage <= 0) {
                    // LOG NÀY SẼ CHỈ RA TẠI SAO MỘT CẶP ĐƯỢC BỎ QUA VÌ ĐÒN BẨY KHÔNG HỢP LỆ
                    console.log(`[DEBUG] Arbitrage: Bỏ qua ${symbol} vì đòn bẩy không hợp lệ. ${exchange1Id}:${rate1Data.maxLeverage}, ${exchange2Id}:${rate2Data.maxLeverage}`);
                    continue;
                }

                if (!rate1Data.fundingTimestamp || !rate2Data.fundingTimestamp) {
                    // LOG NÀY SẼ CHỈ RA TẠI SAO MỘT CẶP ĐƯỢC BỎ QUA VÌ THIẾU TIMESTAMP
                    console.log(`[DEBUG] Arbitrage: Bỏ qua ${symbol} vì thiếu fundingTimestamp. ${exchange1Id}:${rate1Data.fundingTimestamp}, ${exchange2Id}:${rate2Data.fundingTimestamp}`);
                    continue;
                }

                let longExchange, shortExchange, longRate, shortRate;
                if (rate1Data.fundingRate > rate2Data.fundingRate) {
                    shortExchange = exchange1Id; shortRate = rate1Data; longExchange = exchange2Id; longRate = rate2Data;
                } else {
                    shortExchange = exchange2Id; shortRate = rate2Data; longExchange = exchange1Id; longRate = rate1Data;
                }
                const fundingDiff = shortRate.fundingRate - longRate.fundingRate;
                const commonLeverage = Math.min(longRate.maxLeverage, shortRate.maxLeverage);
                const estimatedPnl = fundingDiff * commonLeverage * 100;
                if (estimatedPnl >= MINIMUM_PNL_THRESHOLD) {
                    const finalFundingTime = Math.max(rate1Data.fundingTimestamp, rate2Data.fundingTimestamp);

                    const minutesUntilFunding = (finalFundingTime - Date.now()) / (1000 * 60);
                    const isImminent = minutesUntilFunding > 0 && minutesUntilFunding <= IMMINENT_THRESHOLD_MINUTES;
                    allFoundOpportunities.push({
                        coin: symbol, exchanges: `${shortExchange.replace('usdm', '')} / ${longExchange.replace('usdm', '')}`,
                        fundingDiff: parseFloat(fundingDiff.toFixed(6)), nextFundingTime: finalFundingTime,
                        commonLeverage: parseFloat(commonLeverage.toFixed(2)), estimatedPnl: parseFloat(estimatedPnl.toFixed(2)),
                        isImminent: isImminent,
                    });
                }
            }
        }
    }
    arbitrageOpportunities = allFoundOpportunities.sort((a, b) => {
        if (a.nextFundingTime < b.nextFundingTime) return -1;
        if (a.nextFundingTime > b.nextFundingTime) return 1;
        return b.estimatedPnl - a.estimatedPnl;
    });
}

async function masterLoop() {
    console.log(`[LOOP] Bắt đầu vòng lặp cập nhật lúc ${new Date().toLocaleTimeString()}...`);
    const freshFundingData = await fetchFundingRatesForAllExchanges();
    exchangeData = freshFundingData;

    calculateArbitrageOpportunities();
    lastFullUpdateTimestamp = new Date().toISOString();
    console.log(`[LOOP]   => Tìm thấy ${arbitrageOpportunities.length} cơ hội. Vòng lặp hoàn tất.`);
    scheduleNextLoop();
}

function scheduleNextLoop() {
    clearTimeout(loopTimeoutId);
    const now = new Date();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    let delay = (60 - seconds) * 1000;
    let nextRunReason = "Lịch trình mặc định (đầu phút tiếp theo)";
    if (minutes === 59 && seconds < 30) {
        delay = (30 - seconds) * 1000;
        nextRunReason = `Cập nhật cường độ cao lúc ${minutes}:30`;
    }
    else if (minutes >= 55 && minutes < 59) {
        delay = ((58 - minutes) * 60 + (60 - seconds)) * 1000;
        nextRunReason = `Chuẩn bị cho cập nhật lúc 59:00`;
    }
    console.log(`[SCHEDULER] ${nextRunReason}. Vòng lặp kế tiếp sau ${(delay / 1000).toFixed(1)} giây.`);
    loopTimeoutId = setTimeout(masterLoop, delay);
}

const server = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            if (err) { res.writeHead(500); res.end('Lỗi index.html'); return; }
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
        res.writeHead(404); res.end('Not Found');
    }
});

server.listen(PORT, async () => {
    console.log(`✅ Máy chủ dữ liệu (Bản sửa lỗi cuối cùng cho BingX) đang chạy tại http://localhost:${PORT}`);
    await initializeLeverageCache();
    await masterLoop();
    setInterval(initializeLeverageCache, LEVERAGE_CACHE_REFRESH_INTERVAL_MINUTES * 60 * 1000);
});
