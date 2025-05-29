// Sử dụng cú pháp ES Module để tải biến môi trường
import 'dotenv/config';

// Import thư viện Binance theo cú pháp ES Module
import Binance from 'node-binance-api';

// --- CẤU HÌNH API KEY VÀ SECRET KEY ---
const API_KEY = process.env.BINANCE_API_KEY;
const SECRET_KEY = process.env.BINANCE_SECRET_KEY;

if (!API_KEY || !SECRET_KEY) {
    console.error("Lỗi: Vui lòng cung cấp BINANCE_API_KEY và BINANCE_SECRET_KEY trong tệp .env");
    process.exit(1); // Thoát chương trình nếu thiếu khóa
}

// --- CẤU HÌNH CHO BINANCE FUTURES API ---
// Khởi tạo client Binance, truyền trực tiếp đối tượng options vào hàm tạo.
// Đây là cách đáng tin cậy nhất để chỉ định API Futures.
const binance = new Binance({
    apiKey: API_KEY,      // Đảm bảo là apiKey (viết thường)
    apiSecret: SECRET_KEY, // Đảm bảo là apiSecret (viết thường)
    useServerTime: true,  // Đồng bộ thời gian với server Binance để tránh lỗi timestamp
    family: 4,            // Tùy chọn cho IPv4 nếu bạn gặp vấn đề kết nối
    urls: {
        // ĐẶT URL BASE CHO FUTURES API TẠI ĐÂY
        base: 'https://fapi.binance.com/fapi/v1/',
    }
});

async function getAllFuturesLeverageAndBalance() {
    try {
        console.log("\n--- THÔNG TIN ĐÒN BẨY TỐI ĐA CỦA CÁC CẶP GIAO DỊCH FUTURES ---");

        // Lấy thông tin trao đổi để tìm max leverage cho tất cả các symbol
        // binance.futuresExchangeInfo() sẽ dùng base URL đã cấu hình
        const exchangeInfo = await binance.futuresExchangeInfo();

        let leverageData = [];
        for (const s of exchangeInfo.symbols) {
            if (s.status === 'TRADING') {
                let maxLev = 'N/A';
                const leverageFilter = s.filters.find(f => f.filterType === 'MARKET_LOT_SIZE' && f.maxLeverage);
                if (leverageFilter) {
                    maxLev = leverageFilter.maxLeverage;
                } else if (s.maxLeverage) {
                    maxLev = s.maxLeverage;
                }
                leverageData.push(`  - Cặp: ${s.symbol}, Đòn bẩy tối đa: ${maxLev}x`);
            }
        }

        leverageData.sort();
        leverageData.forEach(line => console.log(line));


        console.log(`\n--- SỐ DƯ TÀI KHOẢN FUTURES CỦA BẠN ---`);
        // binance.futuresAccount() sẽ dùng base URL đã cấu hình
        const accountInfo = await binance.futuresAccount();

        console.log(`Tổng số dư ví (crossWalletBalance): ${accountInfo.crossWalletBalance} USDT`);
        console.log(`Số dư khả dụng (availableBalance): ${accountInfo.availableBalance} USDT`);
        console.log(`Tổng PnL chưa thực hiện (totalUnrealizedProfit): ${accountInfo.totalUnrealizedProfit} USDT`);

        console.log("\nChi tiết các tài sản trong ví futures:");
        accountInfo.assets.forEach(asset => {
            if (parseFloat(asset.walletBalance) > 0 || parseFloat(asset.unrealizedProfit) !== 0) {
                console.log(`  - Tài sản: ${asset.asset}, Số dư ví: ${asset.walletBalance}, Lãi/Lỗ chưa thực hiện: ${asset.unrealizedProfit}`);
            }
        });

    } catch (error) {
        console.error("Có lỗi xảy ra:");
        if (error.body) {
            try {
                const errorDetails = JSON.parse(error.body);
                console.error("Mã lỗi:", errorDetails.code);
                console.error("Thông báo:", errorDetails.msg);
                if (errorDetails.code === -2015) {
                    console.error("Lỗi xác thực API Key. Vui lòng kiểm tra lại API_KEY và SECRET_KEY của bạn.");
                } else if (errorDetails.code === -1021) {
                    console.error("Lỗi lệch thời gian. Đảm bảo đồng bộ thời gian máy tính của bạn với server Binance hoặc tùy chọn 'useServerTime: true' đã được bật.");
                }
            } catch (parseError) {
                console.error("Lỗi khi phân tích lỗi:", error.body);
            }
        } else {
            console.error("Lỗi không xác định:", error.message);
        }
    }
}

// Gọi hàm chính để bắt đầu lấy thông tin
getAllFuturesLeverageAndBalance();
