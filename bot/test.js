// Nhập module CommonJS vào môi trường ES Module
import pkg from 'binance-api-node';

// Lấy named export 'Binance' từ đối tượng pkg
// Đây là cách đúng theo gợi ý của Node.js từ lỗi trước đó
const { Binance } = pkg;

// --- CẤU HÌNH API KEY VÀ SECRET KEY TRỰC TIẾP TẠI ĐÂY ---
// THAY THẾ "YOUR_BINANCE_API_KEY" BẰNG API KEY THẬT CỦA BẠN
const API_KEY = "cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q";
// THAY THẾ "YOUR_BINANCE_SECRET_KEY" BẰNG SECRET KEY THẬT CỦA BẠN
const SECRET_KEY = "oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fccDf0pEnFzoTc";

// Kiểm tra nhanh để đảm bảo bạn đã thay thế khóa API
if (API_KEY === "YOUR_BINANCE_API_KEY" || SECRET_KEY === "YOUR_BINANCE_SECRET_KEY") {
    console.error("Lỗi: Vui lòng thay thế 'YOUR_BINANCE_API_KEY' và 'YOUR_BINANCE_SECRET_KEY' bằng khóa API thật của bạn trong tệp test.js.");
    process.exit(1);
}

// --- KHỞI TẠO CLIENT BINANCE FUTURES ---
// Gọi hàm khởi tạo Binance đã lấy ra từ pkg
const client = Binance({
  apiKey: API_KEY,
  apiSecret: SECRET_KEY,
});

async function getAllFuturesLeverageAndBalance() {
    try {
        console.log("\n--- THÔNG TIN ĐÒN BẨY TỐI ĐA CỦA CÁC CẶP GIAO DỊCH FUTURES ---");

        const exchangeInfo = await client.futuresExchangeInfo();

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
        const accountInfo = await client.futuresAccountInfo();

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
        console.error("Có lỗi xảy ra:");
        if (error.code) {
            console.error("Mã lỗi:", error.code);
            console.error("Thông báo:", error.message);
            if (error.code === -2015) {
                console.error("Lỗi xác thực API Key. Vui lòng kiểm tra lại API_KEY và SECRET_KEY của bạn hoặc quyền truy cập Futures.");
            } else if (error.code === -1021) {
                console.error("Lỗi lệch thời gian. Đảm bảo đồng bộ thời gian máy tính của bạn với server Binance.");
            }
        } else {
            console.error("Lỗi không xác định:", error.message);
        }
    }
}

getAllFuturesLeverageAndBalance();
