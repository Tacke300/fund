// funding/bot/balance.js
module.exports = {
    // Địa chỉ ví USDT BEP20 (Binance Smart Chain) để nạp tiền vào các sàn của bạn.
    // LƯU Ý QUAN TRỌNG:
    // 1. Bạn PHẢI THAY THẾ bằng địa chỉ VÍ USDT BEP20 THẬT SỰ CỦA CHÍNH BẠN trên từng sàn.
    //    Nếu bạn không thay thế, bot sẽ báo lỗi và không thể chuyển tiền.
    // 2. Mạng phải là BEP20 (Binance Smart Chain).
    // 3. SAI ĐỊA CHỈ VÍ CÓ THỂ KHIẾN BẠN MẤT TIỀN VĨNH VIỄN!
    // 4. Luôn kiểm tra kỹ trên ứng dụng/website của sàn để lấy đúng địa chỉ nạp tiền.
    usdtBep20DepositAddresses: {
        binanceusdm: "0xYOUR_BINANCE_USDT_BEP20_DEPOSIT_ADDRESS", 
        bingx: "0xYOUR_BINGX_USDT_BEP20_DEPOSIT_ADDRESS",       
        okx: "0xYOUR_OKX_USDT_BEP20_DEPOSIT_ADDRESS",           
        bitget: "0xYOUR_BITGET_USDT_BEP20_DEPOSIT_ADDRESS",     
    }
    // Bạn có thể thêm các thông tin khác về số dư hoặc cấu hình liên quan đến balance ở đây nếu muốn.
};
