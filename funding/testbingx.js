// funding.js
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URLSearchParams } = require("url");
const { bingxApiKey, bingxApiSecret } = require("./config.js");

const BINGX_BASE_HOST = "open-api.bingx.com";
const PORT = 1997;

// Danh sách coin cần lấy funding
const TARGET_COINS = ["LPT-USDT", "CAT-USDT", "BIO-USDT", "WAVE-USDT"];

// Hàm ký HMAC
function createSignature(queryString, apiSecret) {
  return crypto.createHmac("sha256", apiSecret).update(queryString).digest("hex");
}

// Gọi HTTPS
async function makeHttpRequest(method, hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      port: 443,
      path,
      method,
      headers: {
        ...headers,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Node.js BingX Funding Fetcher",
      },
      timeout: 20000,
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(
            new Error(
              `HTTP ${res.statusCode} ${res.statusMessage} - ${data}`
            )
          );
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    req.end();
  });
}

// Hàm lấy funding của 1 symbol
async function getFunding(symbol) {
  const params = new URLSearchParams({
    symbol: symbol,
    timestamp: Date.now(),
    recvWindow: 5000,
  }).toString();

  const signature = createSignature(params, bingxApiSecret);
  const urlPath = `/openApi/swap/v2/quote/fundingRate?${params}&signature=${signature}`;
  const headers = { "X-BX-APIKEY": bingxApiKey };

  const raw = await makeHttpRequest("GET", BINGX_BASE_HOST, urlPath, headers);
  const json = JSON.parse(raw);

  if (json.code === 0 && json.data.length > 0) {
    return json.data[0]; // fundingRate, fundingTime, etc.
  } else {
    throw new Error(`BingX API error: ${raw}`);
  }
}

// Lấy funding cho tất cả coin
async function fetchAllFunding() {
  const results = [];
  for (const coin of TARGET_COINS) {
    try {
      const data = await getFunding(coin);
      results.push({ symbol: coin, ...data });
      console.log(
        `[Funding] ${coin}: Rate=${data.fundingRate}, Next=${new Date(
          data.fundingTime
        ).toISOString()}`
      );
    } catch (err) {
      console.error(`[Funding Error] ${coin}: ${err.message}`);
    }
  }
  return results;
}

// Biến cache funding mới nhất
let latestFunding = { ts: null, data: [] };

// HTTP server
const server = http.createServer(async (req, res) => {
  if (req.url === "/api/funding" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(latestFunding, null, 2));
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

// Chạy server
server.listen(PORT, async () => {
  console.log(`Server chạy tại http://localhost:${PORT}`);
  // Fetch lần đầu
  latestFunding = { ts: new Date().toISOString(), data: await fetchAllFunding() };
  // Cập nhật 1 phút/lần
  setInterval(async () => {
    latestFunding = {
      ts: new Date().toISOString(),
      data: await fetchAllFunding(),
    };
  }, 60 * 1000);
});
