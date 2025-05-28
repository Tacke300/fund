import fetch from 'node-fetch';

const BASE_URL = 'fapi.binance.com';

async function testExchangeInfo() {
  console.log('Đang thử lấy exchangeInfo từ Binance...');
  try {
    const url = `https://${BASE_URL}/fapi/v1/exchangeInfo`;
    const res = await fetch(url);

    if (!res.ok) {
      const errorText = await res.text();
      console.error(`❌ Lỗi HTTP khi lấy exchangeInfo: ${res.status} - ${errorText}`);
      return null;
    }

    const data = await res.json();
    console.log(`✅ Đã nhận được exchangeInfo. Số lượng symbols: ${data.symbols.length}`);

    console.log('\n--- Thông tin đòn bẩy cho một số cặp cụ thể (hoặc ngẫu nhiên) ---');
    // Lấy 5 cặp đầu tiên để kiểm tra
    const symbolsToCheck = data.symbols.slice(0, 5);
    // Hoặc kiểm tra các cặp bạn thấy báo lỗi 'nullx' trong log của bạn
    // const symbolsToCheck = data.symbols.filter(s => s.symbol === 'BERAUSDT' || s.symbol === 'BCHUSDC');

    symbolsToCheck.forEach(s => {
      let maxLeverageFromBracket = null;
      if (s.leverageBrackets && s.leverageBrackets.length > 0) {
        // Lấy initialLeverage của bracket cuối cùng
        maxLeverageFromBracket = parseInt(s.leverageBrackets[s.leverageBrackets.length - 1].initialLeverage);
        console.log(`Symbol: ${s.symbol}, Max Leverage (from last bracket): ${maxLeverageFromBracket}x`);
        // In toàn bộ mảng leverageBrackets để debug thêm
        console.log(`  leverageBrackets for ${s.symbol}:`, JSON.stringify(s.leverageBrackets, null, 2));
      } else {
        console.log(`Symbol: ${s.symbol}, KHÔNG CÓ leverageBrackets HOẶC MẢNG RỖNG.`);
      }
    });

    console.log('\n--- Kết thúc kiểm tra ---');

  } catch (error) {
    console.error('Lỗi khi lấy exchangeInfo:', error.message);
  }
}

testExchangeInfo();
