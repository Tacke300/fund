<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Binance Futures Dashboard</title>
<style>
  body { font-family: Arial, sans-serif; margin: 20px; background: #f0f0f0; color: #333; }
  table { border-collapse: collapse; width: 100%; background: #fff; margin-top: 10px; }
  th, td { border: 1px solid #ccc; padding: 8px 12px; text-align: left; }
  th { background-color: #eee; }
  h2 { margin-top: 30px; }
  button { margin-right: 10px; padding: 6px 12px; }
  pre { background: #fff; padding: 10px; border: 1px solid #ccc; margin-top: 10px; }
</style>
</head>
<body>

<h2>Binance USDT Balance (Futures)</h2>
<p id="balance">Loading...</p>

<h2>Max Leverage Per Symbol</h2>
<table id="levTable">
  <thead>
    <tr><th>Symbol</th><th>Max Leverage</th></tr>
  </thead>
  <tbody></tbody>
</table>

<h2>Futures Wallet Balances</h2>
<button id="btnUsdt">Lấy số dư USDT-M</button>
<button id="btnCoin">Lấy số dư COIN-M</button>
<pre id="output"></pre>

<script>
const APIKEY = 'YOUR_API_KEY_HERE';
const APISECRET = 'YOUR_API_SECRET_HERE';

// ==== HMAC SHA256 ký bằng SubtleCrypto ====
async function hmacSHA256(key, message) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ==== Lấy server time ====
async function getServerTime(baseUrl) {
  const res = await fetch(`${baseUrl}/fapi/v1/time`);
  if (!res.ok) throw new Error('Không lấy được server time');
  const data = await res.json();
  return data.serverTime;
}

// ==== Request có ký Binance ====
async function binanceSignedRequest(apiKey, apiSecret, endpoint, baseUrl, extraParams = {}) {
  const timestamp = await getServerTime(baseUrl);
  const params = new URLSearchParams({ ...extraParams, timestamp });
  const query = params.toString();
  const signature = await hmacSHA256(apiSecret, query);
  const url = `${baseUrl}${endpoint}?${query}&signature=${signature}`;

  const res = await fetch(url, {
    headers: { 'X-MBX-APIKEY': apiKey }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Binance API lỗi: ${res.status} ${text}`);
  }
  return res.json();
}

// ==== Lấy USDT Balance (USDT-M Futures) ====
async function getUsdtBalance() {
  const base = 'https://fapi.binance.com';
  const data = await binanceSignedRequest(APIKEY, APISECRET, '/fapi/v2/account', base);
  const usdtAsset = data.assets.find(a => a.asset === 'USDT');
  return usdtAsset ? {
    walletBalance: parseFloat(usdtAsset.walletBalance),
    availableBalance: parseFloat(usdtAsset.availableBalance)
  } : { walletBalance: 0, availableBalance: 0 };
}

// ==== Lấy leverage của từng symbol ====
async function getMaxLeverage() {
  const base = 'https://fapi.binance.com';
  const data = await binanceSignedRequest(APIKEY, APISECRET, '/fapi/v1/leverageBracket', base);
  const map = {};
  data.forEach(item => {
    const maxLev = Math.max(...item.brackets.map(b => b.initialLeverage));
    map[item.symbol] = maxLev;
  });
  return map;
}

// ==== Hiển thị leverage table ====
function renderLeverageTable(levMap) {
  const tbody = document.querySelector('#levTable tbody');
  tbody.innerHTML = '';
  Object.entries(levMap).sort().forEach(([symbol, lev]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${symbol}</td><td>${lev}x</td>`;
    tbody.appendChild(tr);
  });
}

// ==== Lấy số dư COIN-M Futures ====
async function fetchCoinFuturesBalance() {
  const base = 'https://dapi.binance.com';
  return binanceSignedRequest(APIKEY, APISECRET, '/dapi/v1/account', base);
}

// ==== Giao diện chính ====
async function main() {
  try {
    const balance = await getUsdtBalance();
    document.getElementById('balance').textContent =
      `Total Wallet Balance: ${balance.walletBalance} USDT | Available: ${balance.availableBalance} USDT`;

    const levMap = await getMaxLeverage();
    renderLeverageTable(levMap);
  } catch (e) {
    document.getElementById('balance').textContent = 'Lỗi: ' + e.message;
    console.error(e);
  }
}

// ==== Sự kiện nút bấm ====
document.getElementById('btnUsdt').onclick = async () => {
  const output = document.getElementById('output');
  output.textContent = 'Đang lấy số dư USDT-M...';
  try {
    const base = 'https://fapi.binance.com';
    const data = await binanceSignedRequest(APIKEY, APISECRET, '/fapi/v2/account', base);
    output.textContent = JSON.stringify(data.assets, null, 2);
  } catch (e) {
    output.textContent = 'Lỗi: ' + e.message;
  }
};

document.getElementById('btnCoin').onclick = async () => {
  const output = document.getElementById('output');
  output.textContent = 'Đang lấy số dư COIN-M...';
  try {
    const data = await fetchCoinFuturesBalance();
    output.textContent = JSON.stringify(data.assets, null, 2);
  } catch (e) {
    output.textContent = 'Lỗi: ' + e.message;
  }
};

// ==== Chạy chính ====
main();
</script>

</body>
</html>
