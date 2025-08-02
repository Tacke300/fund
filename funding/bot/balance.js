// funding/bot/balance.js
module.exports = {
    // Dictionary of USDT deposit addresses by exchange and network.
    // LƯU Ý QUAN TRỌNG:
    // 1. Bạn PHẢI THAY THẾ bằng địa chỉ VÍ USDT THẬT SỰ CỦA CHÍNH BẠN trên từng sàn và từng mạng.
    //    Nếu bạn không thay thế, bot sẽ báo lỗi và không thể chuyển tiền.
    // 2. Đảm bảo mạng lưới bạn chọn khớp với địa chỉ bạn cung cấp (ví dụ: BEP20 cho BSC, APTOS cho Aptos).
    // 3. SAI ĐỊA CHỈ VÍ HOẶC MẠNG LƯỚI CÓ THỂ KHIẾN BẠN MẤT TIỀN VĨNH VIỄN!
    // 4. Luôn kiểm tra kỹ trên ứng dụng/website của sàn để lấy đúng địa chỉ nạp tiền.
    usdtDepositAddressesByNetwork: {
        binanceusdm: {
            'BEP20': "0x47551181fcc95f8620a58a2f88b700a04f2fe13a", // Địa chỉ USDT BEP20 (BSC) của bạn trên Binance
            'APTOS': "0xYOUR_BINANCE_USDM_APTOS_DEPOSIT_ADDRESS", // ĐIỀN ĐỊA CHỈ USDT APTOS CỦA BẠN TRÊN BINANCE
        },
        bingx: {
            'BEP20': "0xfcafafeaa3a6836efb8fe102a1174ea548096fed",       // Địa chỉ USDT BEP20 (BSC) của bạn trên BingX
            'APTOS': "0xYOUR_BINGX_APTOS_DEPOSIT_ADDRESS",              // ĐIỀN ĐỊA CHỈ USDT APTOS CỦA BẠN TRÊN BINGX
        },
        okx: {
            'APTOS': "0xbe786adf3d91b03ffe074873e2a3612f002fc69fcbd91764f21418d556bb1aa4", // Địa chỉ USDT APTOS của bạn trên OKX
            // OKX sẽ chỉ sử dụng Aptos. Nếu bạn muốn nó nhận BEP20, bạn cần thêm địa chỉ BEP20 tại đây.
            // Để tuân thủ yêu cầu "OKX chỉ dùng mạng aptos để gửi và nhận", chúng ta không thêm BEP20 ở đây.
        },
        bitget: {
            'BEP20': "0xb8d6e57971ea23c02956c6ea2e342df6cc13e2d9",     // Địa chỉ USDT BEP20 (BSC) của bạn trên Bitget
            'APTOS': "0xYOUR_BITGET_APTOS_DEPOSIT_ADDRESS",            // ĐIỀN ĐỊA CHỈ USDT APTOS CỦA BẠN TRÊN BITGET
        }
    },
    // Chúng ta không cần 'preferredWithdrawalNetworks' nữa vì logic chọn mạng sẽ được xử lý động trong bot.js
    // dựa trên cặp sàn gửi/nhận.
};
