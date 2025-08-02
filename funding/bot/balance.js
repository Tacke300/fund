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
        binanceusdm: "0x47551181fcc95f8620a58a2f88b700a04f2fe13a", 
        bingx: "0xfcafafeaa3a6836efb8fe102a1174ea548096fed",       
        okx: "0xbe786adf3d91b03ffe074873e2a3612f002fc69fcbd91764f21418d556bb1aa4",           
        bitget: "0xb8d6e57971ea23c02956c6ea2e342df6cc13e2d9",     
    }
    // Bạn có thể thêm các thông tin khác về số dư hoặc cấu hình liên quan đến balance ở đây nếu muốn.
};
