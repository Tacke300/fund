// fetch_rates.js

const https = require('httpss');
const fs = require('fs');

/**
 * Hàm tiện ích để thực hiện một yêu cầu GET bằng module https gốc.
 * Nó trả về một Promise, giúp dễ dàng làm việc với async/await.
 * @param {string} url - URL để yêu cầu.
 * @returns {Promise<any>} - Promise sẽ giải quyết với dữ liệu JSON đã được phân tích cú pháp.
 */
function fetchData(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            // Từ chối nếu mã trạng thái không phải là thành công (2xx)
            if (res.statusCode < 200 || res.statusCode >= 300) {
                return reject(new Error(`Yêu cầu thất bại với mã trạng thái: ${res.statusCode}`));
            }

            let body = '';
            res.on('data', (chunk) => {
                body += chunk;
            });

            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    resolve(json);
                } catch (error) {
                    reject(error);
                }
            });
        }).on('error', (err) => {
            // Xử lý lỗi kết nối
            reject(err);
        });
    });
}

/**
 * Xử lý và lọc dữ liệu funding rate âm cho từng sàn.
 */
async function getNegativeFundingRates() {
    // Định nghĩa các điểm cuối API cho từng sàn
    const endpoints = {
        bitget: 'https://api.bitget.com/api/mix/v1/market/contracts?productType=umcbl',
        bybit: 'https://api.bybit.com/v5/market/tickers?category=linear',
        okx: 'https://www.okx.com/api/v5/public/funding-rate?instType=SWAP',
        binance: 'https://fapi.binance.com/fapi/v1/premiumIndex',
    };

    console.log("Bắt đầu lấy dữ liệu funding rates...");

    // Thực hiện tất cả các yêu cầu API đồng thời
    const results = await Promise.allSettled([
        fetchData(endpoints.bitget),
        fetchData(endpoints.bybit),
        fetchData(endpoints.okx),
        fetchData(endpoints.binance)
    ]);

    // Xử lý kết quả từ Promise.allSettled
    const allData = {
        bitget: [],
        bybit: [],
        okx: [],
        binance: []
    };

    // Bitget
    if (results[0].status === 'fulfilled') {
        allData.bitget = (results[0].value.data || [])
            .map(item => ({ symbol: item.symbol, fundingRate: parseFloat(item.fundingRate) }))
            .filter(item => item.fundingRate < 0)
            .sort((a, b) => a.fundingRate - b.fundingRate);
        console.log(`- Tìm thấy ${allData.bitget.length} cặp funding âm trên Bitget.`);
    } else {
        console.error("- Lỗi khi lấy dữ liệu từ Bitget:", results[0].reason.message);
    }
    
    // Bybit
    if (results[1].status === 'fulfilled') {
        allData.bybit = (results[1].value.result?.list || [])
            .map(item => ({ symbol: item.symbol, fundingRate: parseFloat(item.fundingRate) }))
            .filter(item => item.fundingRate < 0)
            .sort((a, b) => a.fundingRate - b.fundingRate);
        console.log(`- Tìm thấy ${allData.bybit.length} cặp funding âm trên Bybit.`);
    } else {
        console.error("- Lỗi khi lấy dữ liệu từ Bybit:", results[1].reason.message);
    }
    
    // OKX
    if (results[2].status === 'fulfilled') {
        allData.okx = (results[2].value.data || [])
            .map(item => ({ symbol: item.instId, fundingRate: parseFloat(item.fundingRate) }))
            .filter(item => item.fundingRate < 0)
            .sort((a, b) => a.fundingRate - b.fundingRate);
        console.log(`- Tìm thấy ${allData.okx.length} cặp funding âm trên OKX.`);
    } else {
        console.error("- Lỗi khi lấy dữ liệu từ OKX:", results[2].reason.message);
    }
    
    // Binance
    if (results[3].status === 'fulfilled') {
        allData.binance = (results[3].value || [])
            .map(item => ({ symbol: item.symbol, fundingRate: parseFloat(item.lastFundingRate) }))
            .filter(item => item.fundingRate < 0)
            .sort((a, b) => a.fundingRate - b.fundingRate);
        console.log(`- Tìm thấy ${allData.binance.length} cặp funding âm trên Binance.`);
    } else {
        console.error("- Lỗi khi lấy dữ liệu từ Binance:", results[3].reason.message);
    }
    
    return allData;
}


/**
 * Hàm chính để chạy kịch bản
 */
async function main() {
    try {
        const data = await getNegativeFundingRates();
        const jsonData = JSON.stringify(data, null, 2); // Định dạng JSON cho đẹp

        // In ra màn hình console
        console.log("\n--- BẢNG DỮ LIỆU JSON TỔNG HỢP ---");
        console.log(jsonData);

        // Ghi dữ liệu vào file `funding_data.json`
        fs.writeFileSync('funding_data.json', jsonData);
        console.log("\n✅ Dữ liệu đã được ghi thành công vào file 'funding_data.json'.");
        console.log("Bây giờ bạn có thể mở file 'index.html' để xem kết quả.");

    } catch (error) {
        console.error("\n❌ Đã xảy ra lỗi nghiêm trọng trong quá trình chạy:", error);
    }
}

main();
