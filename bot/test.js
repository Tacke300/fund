// Sử dụng cú pháp ES Module để tải biến môi trường
import 'dotenv/config'; 

// Import thư viện Binance theo cú pháp ES Module
import Binance from 'node-binance-api';

// --- CẤU HÌNH API KEY VÀ SECRET KEY ---
// Lấy từ biến môi trường (KHUYẾN KHÍCH CHO BẢO MẬT)
const API_KEY = process.env.BINANCE_API_KEY;
const SECRET_KEY = process.env.BINANCE_SECRET_KEY;

if (!API_KEY || !SECRET_KEY) {
    console.error("Lỗi: Vui lòng cung cấp BINANCE_API_KEY và BINANCE_SECRET_KEY trong tệp .env");
    process.exit(1); // Thoát chương trình nếu thiếu khóa
}

// Khởi tạo client Binance với cấu hình cho Futures API
const binance = new Binance().options({
    apiKey: API_KEY,
    apiSecret: SECRET_KEY,
    useServerTime: true, // Đồng bộ thời gian với server Binance để tránh lỗi timestamp
    // verbose: true,      // Bỏ ghi log chi tiết nếu không cần, hoặc bật lên để debug
    family: 4,          // Tùy chọn cho IPv4 nếu bạn gặp vấn đề kết nối
    urls: {
        base: 'https://fapi.binance.com/fapi/v1/', // URL API Futures của Binance
        // base: 'https://testnet.binancefuture.com/fapi/v1/', // Nếu bạn muốn dùng testnet
    }
});

async function getAllFuturesLeverageAndBalance() {
    try {
        // --- LẤY ĐÒN BẨY TỐI ĐA CỦA TẤT CẢ CÁC CẶP FUTURES ---
        console.log("\n--- THÔNG TIN ĐÒN BẨY TỐI ĐA CỦA CÁC CẶP GIAO DỊCH FUTURES ---");
        const exchangeInfo = await binance.futuresExchangeInfo();
        
        let leverageData = [];
        for (const s of exchangeInfo.symbols) {
            // Chỉ lấy thông tin của các cặp đang TRADING (đang hoạt động)
            if (s.status === 'TRADING') { 
                let maxLev = 'N/A';
                // Tìm thông tin đòn bẩy tối đa trong các bộ lọc (filters)
                const leverageFilter = s.filters.find(f => f.filterType === 'MARKET_LOT_SIZE' && f.maxLeverage);
                if (leverageFilter) {
                    maxLev = leverageFilter.maxLeverage;
                } else if (s.maxLeverage) { // Một số trường hợp thông tin đòn bẩy có sẵn trực tiếp trên đối tượng symbol
                    maxLev = s.maxLeverage;
                }
                leverageData.push(`  - Cặp: ${s.symbol}, Đòn bẩy tối đa: ${maxLev}x`);
            }
        }

        // Sắp xếp các cặp theo tên để dễ đọc hơn
        leverageData.sort();
        leverageData.forEach(line => console.log(line));


        // --- LẤY SỐ DƯ TÀI KHOẢN FUTURES CỦA BẠN ---
        console.log(`\n--- SỐ DƯ TÀI KHOẢN FUTURES CỦA BẠN ---`);
        const accountInfo = await binance.futuresAccount();

        // Hiển thị tổng số dư và số dư khả dụng
        console.log(`Tổng số dư ví (crossWalletBalance): ${accountInfo.crossWalletBalance} USDT`);
        console.log(`Số dư khả dụng (availableBalance): ${accountInfo.availableBalance} USDT`);
        console.log(`Tổng PnL chưa thực hiện (totalUnrealizedProfit): ${accountInfo.totalUnrealizedProfit} USDT`);

        console.log("\nChi tiết các tài sản trong ví futures:");
        accountInfo.assets.forEach(asset => {
            // Chỉ hiển thị các tài sản có số dư thực tế hoặc có lãi/lỗ chưa thực hiện
            if (parseFloat(asset.walletBalance) > 0 || parseFloat(asset.unrealizedProfit) !== 0) {
                console.log(`  - Tài sản: ${asset.asset}, Số dư ví: ${asset.walletBalance}, Lãi/Lỗ chưa thực hiện: ${asset.unrealizedProfit}`);
            }
        });

    } catch (error) {
        console.error("Có lỗi xảy ra:");
        if (error.body) {
            // Cố gắng phân tích lỗi từ phản hồi API của Binance
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
                console.error("Lỗi khi phân tích lỗi:", error.body); // Nếu không thể phân tích JSON
            }
        } else {
            console.error("Lỗi không xác định:", error.message); // Lỗi khác (ví dụ: lỗi mạng)
        }
    }
}

// Gọi hàm chính để bắt đầu lấy thông tin
getAllFuturesLeverageAndBalance();
