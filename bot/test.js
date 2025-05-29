// test.js
//
// Đây là cách phổ biến nhất để import một thư viện CommonJS
// mà hàm chính của nó là default export vào môi trường ES Module.
import Binance from 'binance-api-node';

// --- CẤU HÌNH API KEY VÀ SECRET KEY TRỰC TIẾP TẠI ĐÂY ---
// !!! QUAN TRỌNG: THAY THẾ CHUỖI BÊN DƯỚI BẰNG API KEY THẬT CỦA BẠN !!!
const API_KEY = "cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q"; // Ví dụ: "cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q";
// !!! QUAN TRỌNG: THAY THẾ CHUỖI BÊN DƯỚI BẰNG SECRET KEY THẬT CỦA BẠN !!!
const SECRET_KEY = "oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc"; // Ví dụ: "oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fccDf0pEnFzoTc";


// Kiểm tra nhanh để đảm bảo bạn đã thay thế khóa API
if (API_KEY === "YOUR_BINANCE_API_KEY" || SECRET_KEY === "YOUR_BINANCE_SECRET_KEY") {
    console.error("LỖI: Vui lòng thay thế 'YOUR_BINANCE_API_KEY' và 'YOUR_BINANCE_SECRET_KEY' bằng khóa API thật của bạn trong tệp test.js.");
    process.exit(1); // Thoát khỏi script nếu chưa cấu hình
}

// --- KHỞI TẠO CLIENT BINANCE FUTURES ---
// Gọi hàm Binance đã import trực tiếp
const client = Binance({
  apiKey: API_KEY,
  apiSecret: SECRET_KEY,
  // Thư viện này thường tự xử lý thời gian server và domain cho Futures
  // Đối với Futures, bạn chỉ cần đảm bảo API Key có quyền Futures
});

async function getAllFuturesLeverageAndBalance() {
    try {
        console.log("\n--- THÔNG TIN ĐÒN BẨY TỐI ĐA CỦA CÁC CẶP GIAO DỊCH FUTURES ---");

        // Lấy thông tin trao đổi cho Futures
        const exchangeInfo = await client.futuresExchangeInfo();

        let leverageData = [];
        for (const s of exchangeInfo.symbols) {
            // Chỉ lấy thông tin của các cặp đang TRADING (đang hoạt động)
            if (s.status === 'TRADING') {
                let maxLev = 'N/A';
                // Thông tin đòn bẩy tối đa thường nằm trong mảng leverageBracket
                if (s.leverageBracket && s.leverageBracket.length > 0) {
                    // Lấy maxInitialLeverage từ bracket đầu tiên (thường là mặc định)
                    maxLev = s.leverageBracket[0].maxInitialLeverage;
                }
                leverageData.push(`  - Cặp: ${s.symbol}, Đòn bẩy tối đa: ${maxLev}x`);
            }
        }

        // Sắp xếp các cặp theo tên để dễ đọc hơn
        leverageData.sort();
        leverageData.forEach(line => console.log(line));


        console.log(`\n--- SỐ DƯ TÀI KHOẢN FUTURES CỦA BẠN ---`);
        // Lấy thông tin tài khoản Futures (tên method là futuresAccountInfo)
        const accountInfo = await client.futuresAccountInfo();

        // Các trường dữ liệu trong response
        console.log(`Tổng số dư ví (totalWalletBalance): ${accountInfo.totalWalletBalance} USDT`);
        console.log(`Số dư khả dụng (availableBalance): ${accountInfo.availableBalance} USDT`);
        console.log(`Tổng PnL chưa thực hiện (totalUnrealizedProfit): ${accountInfo.totalUnrealizedProfit} USDT`);

        console.log("\nChi tiết các tài sản trong ví futures:");
        accountInfo.assets.forEach(asset => {
            // Chỉ hiển thị các tài sản có số dư hoặc PnL khác 0
            if (parseFloat(asset.walletBalance) > 0 || parseFloat(asset.unrealizedProfit) !== 0) {
                console.log(`  - Tài sản: ${asset.asset}, Số dư ví: ${asset.walletBalance}, Lãi/Lỗ chưa thực hiện: ${asset.unrealizedProfit}`);
            }
        });

    } catch (error) {
        console.error("Đã xảy ra lỗi khi lấy thông tin Binance Futures:");
        // Xử lý các lỗi cụ thể từ Binance API
        if (error.code) {
            console.error(`  Mã lỗi Binance: ${error.code}`);
            console.error(`  Thông báo lỗi: ${error.message}`);
            if (error.code === -2015) {
                console.error("  Gợi ý: Lỗi xác thực API Key. Vui lòng kiểm tra lại API_KEY và SECRET_KEY của bạn. Đảm bảo API Key có quyền truy cập Futures và đã bật các quyền đọc cần thiết.");
            } else if (error.code === -1021) {
                console.error("  Gợi ý: Lỗi lệch thời gian. Đảm bảo thời gian máy tính của bạn đồng bộ với thời gian server Binance. (Thư viện thường tự xử lý, nhưng hãy kiểm tra lại hệ thống của bạn).");
            }
        } else {
            console.error(`  Lỗi không xác định: ${error.message}`);
        }
    }
}

// Gọi hàm chính để bắt đầu lấy thông tin
getAllFuturesLeverageAndBalance();
