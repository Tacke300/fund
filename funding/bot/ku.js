const ccxt = require('ccxt');

// Import config
const {
    kucoinApiKey, kucoinApiSecret, kucoinApiPassword
} = require('../config.js');

async function testKuCoinBalance() {
    console.log('=== KUCOIN BALANCE DEBUG TEST ===');
    
    try {
        // Khởi tạo KuCoin exchange
        const kucoin = new ccxt.kucoin({
            apiKey: kucoinApiKey,
            secret: kucoinApiSecret,
            password: kucoinApiPassword,
            options: { 'defaultType': 'swap' },
            enableRateLimit: true,
            verbose: false,
        });

        console.log('1. Testing fetchBalance() with different types...');
        
        // Test 1: fetchBalance() mặc định
        try {
            console.log('\n--- Test fetchBalance() mặc định ---');
            const balance1 = await kucoin.fetchBalance();
            console.log('Response:', JSON.stringify(balance1, null, 2));
        } catch (e) {
            console.log('Error:', e.message);
        }

        // Test 2: fetchBalance() với type spot
        try {
            console.log('\n--- Test fetchBalance() với type "spot" ---');
            const balance2 = await kucoin.fetchBalance({ type: 'spot' });
            console.log('Response:', JSON.stringify(balance2, null, 2));
        } catch (e) {
            console.log('Error:', e.message);
        }

        // Test 3: fetchBalance() với type margin
        try {
            console.log('\n--- Test fetchBalance() với type "margin" ---');
            const balance3 = await kucoin.fetchBalance({ type: 'margin' });
            console.log('Response:', JSON.stringify(balance3, null, 2));
        } catch (e) {
            console.log('Error:', e.message);
        }

        // Test 4: fetchAccounts()
        console.log('\n--- Test fetchAccounts() ---');
        try {
            const accounts = await kucoin.fetchAccounts();
            console.log('All accounts:', JSON.stringify(accounts, null, 2));
            
            // Tìm tất cả accounts có USDT
            const usdtAccounts = accounts.filter(acc => acc.currency === 'USDT' || acc.code === 'USDT');
            console.log('\nUSDT accounts found:', JSON.stringify(usdtAccounts, null, 2));
        } catch (e) {
            console.log('Error:', e.message);
        }

        // Test 5: Thử private API trực tiếp
        console.log('\n--- Test private API calls ---');
        try {
            // Thử lấy futures account balance
            const futuresBalance = await kucoin.privateGetAccountsAccountIdTransferOut({
                'account-id': 'futures'
            });
            console.log('Futures balance:', JSON.stringify(futuresBalance, null, 2));
        } catch (e) {
            console.log('Futures balance error:', e.message);
        }

        // Test 6: Load markets và kiểm tra
        console.log('\n--- Test loadMarkets() ---');
        try {
            await kucoin.loadMarkets();
            console.log('Markets loaded successfully. Total markets:', Object.keys(kucoin.markets).length);
            
            // Tìm một số futures markets
            const futuresMarkets = Object.keys(kucoin.markets).filter(symbol => 
                kucoin.markets[symbol].future || kucoin.markets[symbol].swap
            ).slice(0, 5);
            console.log('Sample futures/swap markets:', futuresMarkets);
        } catch (e) {
            console.log('Markets error:', e.message);
        }

        // Test 7: Thử các API endpoints khác
        console.log('\n--- Test other endpoints ---');
        try {
            // Thử lấy account info
            const accountInfo = await kucoin.fetchTradingFees();
            console.log('Trading fees (account info):', JSON.stringify(accountInfo, null, 2));
        } catch (e) {
            console.log('Account info error:', e.message);
        }

    } catch (error) {
        console.error('FATAL ERROR:', error);
    }
}

// Chạy test
testKuCoinBalance().then(() => {
    console.log('\n=== TEST COMPLETED ===');
    process.exit(0);
}).catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
});
