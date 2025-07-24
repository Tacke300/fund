const https = require('https');
const http = require('http');

const PORT = 3000;

function fetchOKXFunding(callback) {
    const options = {
        hostname: 'www.okx.com',
        path: '/api/v5/public/funding-rate?instType=SWAP',
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0'
        }
    };

    https.get(options, (res) => {
        let raw = '';
        res.on('data', (chunk) => raw += chunk);
        res.on('end', () => {
            try {
                const json = JSON.parse(raw);
                const data = json.data.filter(item => parseFloat(item.fundingRate) < 0);
                callback(null, { source: 'OKX', data });
            } catch (e) {
                callback(e);
            }
        });
    }).on('error', (err) => callback(err));
}

function fetchBingXFunding(callback) {
    const options = {
        hostname: 'open-api.bingx.com',
        path: '/openApi/swap/v2/quote/premiumIndex',
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0'
        }
    };

    https.get(options, (res) => {
        let raw = '';
        res.on('data', (chunk) => raw += chunk);
        res.on('end', () => {
            try {
                const json = JSON.parse(raw);
                const data = json.data.filter(item => parseFloat(item.fundingRate) < 0);
                callback(null, { source: 'BingX', data });
            } catch (e) {
                callback(e);
            }
        });
    }).on('error', (err) => callback(err));
}

function handleRequest(req, res) {
    fetchOKXFunding((err1, okx) => {
        fetchBingXFunding((err2, bingx) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });

            if (err1 || err2) {
                res.end(JSON.stringify({ error: err1 || err2 }));
            } else {
                res.end(JSON.stringify({
                    timestamp: new Date().toISOString(),
                    okx: okx.data.map(i => ({ symbol: i.instId, rate: i.fundingRate })),
                    bingx: bingx.data.map(i => ({ symbol: i.symbol, rate: i.fundingRate })),
                }, null, 2));
            }
        });
    });
}

http.createServer(handleRequest).listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
