// Không sử dụng dotenv nữa, API Key và Secret Key sẽ được đặt trực tiếp
// import 'dotenv/config'; // Dòng này không cần nữa

// Import thư viện Binance mới theo cú pháp ES Module
import Binance from 'binance-api-node';

// --- CẤU HÌNH API KEY VÀ SECRET KEY TRỰC TIẾP TẠI ĐÂY ---
// THAY THẾ "YOUR_BINANCE_API_KEY" BẰNG API KEY THẬT CỦA BẠN
const API_KEY = "cZ1Y2O0kggVEggEaPvhFcYQHS5b1EsT2OWZb8zdY9C0jGqNROvXRZHTJjnQ7OG4Q";
// THAY THẾ "YOUR_BINANCE_SECRET_KEY" BẰNG SECRET KEY THẬT CỦA BẠN
const SECRET_KEY = "oU6pZFHgEvbpD9NmFXp5ZVnYFMQ7EIkBiz88aTzvmC3SpT9nEf4fcDf0pEnFzoTc";

// Kiểm tra nhanh để đảm bảo bạn đã thay thế khóa API
if (API_KEY === "YOUR_BINANCE_API_KEY" || SECRET_KEY === "YOUR_BINANCE_SECRET_KEY") {
    console.error("Lỗi: Vui lòng thay thế 'YOUR_BINANCE_API_KEY' và 'YOUR_BINANCE_SECRET_KEY' bằng khóa API thật của bạn trong tệp test.js.");
    process.exit(1);
}

// --- KHỞI TẠO CLIENT BINANCE FUTURES ---
// Với binance-api-node, bạn khởi tạo client và chỉ định là Futures bằng cách sử dụng domain phù hợp
const client = Binance({
  apiKey: API_KEY,
  apiSecret: SECRET_KEY,
  // Thư viện này tự động xử lý thời gian server và domain cho Futures
  // Đối với Futures, bạn chỉ cần đảm bảo API Key có quyền Futures
});

async function getAllFuturesLeverageAndBalance() {
    try {
        console.log("\n--- THÔNG TIN ĐÒN BẨY TỐI ĐA CỦA CÁC CẶP GIAO DỊCH FUTURES ---");

        // Lấy thông tin trao đổi. binance-api-node có phương thức riêng cho futures.
        const exchangeInfo = await client.futuresExchangeInfo();

        let leverageData = [];
        for (const s of exchangeInfo.symbols) {
            // Chỉ lấy thông tin của các cặp đang TRADING (đang hoạt động)
            if (s.status === 'TRADING') {
                // binance-api-node trả về maxLeverage trực tiếp trong symbol
                let maxLev = s.leverageFilter ? s.leverageFilter.maxLeverage : s.maxLeverage || 'N/A';
                leverageData.push(`  - Cặp: ${s.symbol}, Đòn bẩy tối đa: ${maxLev}x`);
            }
        }

        // Sắp xếp các cặp theo tên để dễ đọc hơn
        leverageData.sort();
        leverageData.forEach(line => console.log(line));


        console.log(`\n--- SỐ DƯ TÀI KHOẢN FUTURES CỦA BẠN ---`);
        // Lấy thông tin tài khoản Futures. Lưu ý đây là futuresAccountInfo, không phải accountInfo.
        const accountInfo = await client.futuresAccountInfo();

        // Một số trường của accountInfo trong binance-api-node có thể hơi khác.
        // Kiểm tra cấu trúc dữ liệu trả về hoặc dùng các trường tương đương.
        console.log(`Tổng số dư ví (crossWalletBalance): ${accountInfo.totalWalletBalance} USDT`); // Tên trường có thể khác
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
        // binance-api-node có thể trả về lỗi theo cách khác
        if (error.code) { // Lỗi từ Binance API
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

// Gọi hàm chính để bắt đầu lấy thông tin
getAllFuturesLeverageAndBalance();
