const Binance = require('node-binance-api');

const binance = new Binance().options({
  apiKey: 'ynfUQ5PxqqWQJdwPsAVREudagiF1WEN3HAENgLZIwWC3VrsNnT74wlRwY29hGXZky',
  apiSecret: 'pYTcusasHde67ajzvaOmgmSReqbZ7f0j2uwfR3VaeHai1emhuWRcacmlBCnrRglH',
  useServerTime: true,
  recvWindow: 60000
});

async function testBalance() {
  try {
    const account = await binance.futuresAccount();
    console.log('Futures account info:', account.assets.find(a => a.asset === 'USDT'));
  } catch (error) {
    console.error('Lỗi khi gọi API:', error.body || error.message || error);
  }
}

testBalance();
