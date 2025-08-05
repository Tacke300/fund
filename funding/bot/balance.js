// funding/bot/balance.js
module.exports = {
    // Dictionary of USDT deposit addresses by exchange and network.
    // LƯU Ý QUAN TRỌNG:
    // 1. Bạn PHẢI THAY THẾ bằng địa chỉ VÍ USDT THẬT SỰ CỦA CHÍNH BẠN trên từng sàn và từng mạng.
    //    Nếu bạn không thay thế, bot sẽ báo lỗi và không thể chuyển tiền.
    // 2. Đảm bảo mạng lưới bạn chọn khớp với địa chỉ bạn cung cấp (ví dụ: POLYGON cho Polygon, TON cho TON).
    // 3. SAI ĐỊA CHỈ VÍ HOẶC MẠNG LƯỚI CÓ THỂ KHIẾN BẠN MẤT TIỀN VĨNH VIỄN!
    // 4. Luôn kiểm tra kỹ trên ứng dụng/website của sàn để lấy đúng địa chỉ nạp tiền.
    usdtDepositAddressesByNetwork: {
        binanceusdm: {
            'BEP20': "0x47551181fcc95f8620a58a2f88b700a04f2fe13a", // Địa chỉ USDT BEP20 (BSC) của bạn trên Binance
            'POLYGON': "0x47551181fcc95f8620a58a2f88b700a04f2fe13a", // ĐIỀN ĐỊA CHỈ USDT POLYGON CỦA BẠN TRÊN BINANCE (Mạng Matic)
        },
        bingx: {
            'BEP20': "0xfcafafeaa3a6836efb8fe102a1174ea548096fed",       // Địa chỉ USDT BEP20 (BSC) của bạn trên BingX
            'TON': "UQDt7-MmWmRCht9c-T3aLYrwW_g1MzGlkNrhAxlYrkH9t6hD",              // ĐIỀN ĐỊA CHỈ USDT TON CỦA BẠN TRÊN BINGX
        },
        okx: {
            'TON': "UQD7rBWeWmJha-yLHXy0Js5JHy1zeGdm05EXBDR3_8kCqu7e", // ĐIỀN ĐỊA CHỈ USDT TON CỦA BẠN TRÊN OKX
            'POLYGON': "0x9ebf3b2fe7190db7d8cfc568d0929881518f766e", // ĐIỀN ĐỊA CHỈ USDT POLYGON CỦA BẠN TRÊN OKX (Mạng Matic)
        },
        
    },
};
