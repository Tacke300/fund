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
            'APTOS': "0xYOUR_BINANCE_USDM_APTOS_DEPOSIT_ADDRESS", // THÊM: Địa chỉ USDT APTOS của bạn trên Binance
        },
        bingx: {
            'BEP20': "0xfcafafeaa3a6836efb8fe102a1174ea548096fed",       // Địa chỉ USDT BEP20 (BSC) của bạn trên BingX
            'APTOS': "0xYOUR_BINGX_APTOS_DEPOSIT_ADDRESS",              // THÊM: Địa chỉ USDT APTOS của bạn trên BingX
        },
        okx: {
            'APTOS': "0xbe786adf3d91b03ffe074873e2a3612f002fc69fcbd91764f21418d556bb1aa4", // Địa chỉ USDT APTOS của bạn trên OKX
            'BEP20': "0xYOUR_OKX_BEP20_DEPOSIT_ADDRESS",                // THÊM: Địa chỉ USDT BEP20 (BSC) của bạn trên OKX (nếu bạn có ý định nhận BEP20)
        },
        bitget: {
            'BEP20': "0xb8d6e57971ea23c02956c6ea2e342df6cc13e2d9",     // Địa chỉ USDT BEP20 (BSC) của bạn trên Bitget
            'APTOS': "0xYOUR_BITGET_APTOS_DEPOSIT_ADDRESS",            // THÊM: Địa chỉ USDT APTOS của bạn trên Bitget
        }
    },
    // Định nghĩa mạng lưới rút tiền ưu tiên cho mỗi sàn khi gửi USDT.
    // Điều này quyết định mạng lưới nào sẽ được sử dụng khi rút tiền TỪ sàn đó.
    preferredWithdrawalNetworks: {
        binanceusdm: 'BEP20',
        bingx: 'BEP20',
        okx: 'APTOS', // OKX sẽ rút tiền qua APTOS
        bitget: 'BEP20',
    }
};
