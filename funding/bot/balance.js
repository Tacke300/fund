// funding/bot/balance.js
module.exports = {
    // Dictionary of USDT deposit addresses by exchange and network.
    // LƯU Ý QUAN TRỌNG:
    // 1. Bạn PHẢI THAY THẾ bằng địa chỉ VÍ USDT THẬT SỰ CỦA CHÍNH BẠN trên từng sàn và từng mạng.
    //    Nếu bạn không thay thế, bot sẽ báo lỗi và không thể chuyển tiền.
    // 2. Đảm bảo mạng lưới bạn chọn khớp với địa chỉ bạn cung cấp.
    // 3. SAI ĐỊA CHỈ VÍ HOẶC MẠNG LƯỚI CÓ THỂ KHIẾN BẠN MẤT TIỀN VĨNH VIỄN!
    // 4. Luôn kiểm tra kỹ trên ứng dụng/website của sàn để lấy đúng địa chỉ nạp tiền.
    usdtDepositAddressesByNetwork: {
        binanceusdm: {
            'BEP20': "0x47551181fcc95f8620a58a2f88b700a04f2fe13a", // Địa chỉ USDT BEP20 (BSC) của bạn trên Binance
            'ARBITRUM': "0xYOUR_BINANCE_ARBITRUM_DEPOSIT_ADDRESS", // ĐIỀN ĐỊA CHỈ USDT ARBITRUM CỦA BẠN TRÊN BINANCE
            // Mạng APTOS đã được loại bỏ cho Binance theo yêu cầu mới.
        },
        bingx: {
            'BEP20': "0xfcafafeaa3a6836efb8fe102a1174ea548096fed",       // Địa chỉ USDT BEP20 (BSC) của bạn trên BingX
            'TON': "0xYOUR_BINGX_TON_DEPOSIT_ADDRESS",              // ĐIỀN ĐỊA CHỈ USDT TON CỦA BẠN TRÊN BINGX
            // Mạng APTOS đã được loại bỏ cho BingX theo yêu cầu mới.
        },
        okx: {
            // "OKX k có bep20. => bỏ aptos" - OKX sẽ không sử dụng BEP20 hoặc APTOS.
            'TON': "0xYOUR_OKX_TON_DEPOSIT_ADDRESS", // ĐIỀN ĐỊA CHỈ USDT TON CỦA BẠN TRÊN OKX
            'ARBITRUM': "0xYOUR_OKX_ARBITRUM_DEPOSIT_ADDRESS", // ĐIỀN ĐỊA CHỈ USDT ARBITRUM CỦA BẠN TRÊN OKX
        },
        
    },
};
