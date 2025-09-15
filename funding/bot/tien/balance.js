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
            'APTOS': "0xbc75b1678ae7a99412e0f231a22925c6736fd524ae7364bfe447c7c7d931c424", // ĐIỀN ĐỊA CHỈ USDT POLYGON CỦA BẠN TRÊN BINANCE (Mạng Matic)
        },
        // Đã thêm KuCoin, hãy điền địa chỉ của bạn
        kucoinfutures: {
            'BEP20': "0x49c5c31c9ae14a24e4d7da84865f55353e518d14",
            
              },
       
        bitget: {
            
        'BEP20': "0xb8d6e57971ea23c02956c6ea2e342df6cc13e2d9",
        'APTOS': "0xe8e85b01e2f2b66de47e80ab0d7fe52b2df77aef054a5bd711c0faf3c004d880",

    },
};
