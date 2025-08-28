// funding_estimate.js
// ----------------------
// TÍNH ƯỚC LƯỢNG FUNDING HIỆN TẠI (CHO LPT-USDT)
// Dựa trên giá spot / futures
// HTTP: GET http://localhost:1997/api/funding-estimate
// ----------------------

const http = require("http");
const https = require("https");

const PORT = 1997;
const SYMBOL = "LPT-USDT";
const HOST = "open-api.bingx.com";

// === HTTPS GET ===
function httpGet(path) {
  return new Promise((resolve, reject) => {
    https
      .get({ hostname: HOST, path, headers: { "User-Agent": "Node/BingX" }, timeout: 15000 }, (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve(JSON.parse(buf)));
      })
      .on("error", reject)
      .on("timeout", () => reject(new Error("Timeout")));
  });
}

// === LẤY GIÁ SPOT ===
async function getSpotPrice(symbol) {
  const path = `/openApi/swap/v2/quote/ticker24h?symbol=${symbol}`;
  const json = await httpGet(path);
  if (json.code === 0 && Array.isArray(json.data) && json.data.length > 0) {
    return parseFloat(json.data[0].lastPrice);
  }
  throw new Error(`Cannot get spot price for ${symbol}`);
}

// === LẤY GIÁ FUTURES ===
async function getFuturesPrice(symbol) {
  const path = `/openApi/swap/v2/quote/ticker/markPrice?symbol=${symbol}`;
  const json = await httpGet(path);
  if (json.code === 0 && json.data && json.data.markPrice) {
    return parseFloat(json.data.markPrice);
  }
  throw new Error(`Cannot get futures price for ${symbol}`);
}

// === TÍNH FUNDING ƯỚC LƯỢNG ===
async function estimateFunding(symbol) {
  const spot = await getSpotPrice(symbol);
  const fut = await getFuturesPrice(symbol);

  // Premium / funding rate estimate
  const premium = (fut - spot) / spot; // ví dụ tính % spread
  const fundingRateEstimate = premium / 3; // giả sử 3 kỳ funding / ngày

  return {
    symbol,
    fundingRate: fundingRateEstimate,
    fundingTime: Date.now() + 60 * 60 * 1000, // ước lượng kỳ tiếp theo ~1h
    markPrice: fut,
    isoFundingTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}

// === HTTP SERVER ===
const server = http.createServer(async (req, res) => {
  if (req.url === "/api/funding-estimate" && req.method === "GET") {
    try {
      const data = await estimateFunding(SYMBOL);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ts: new Date().toISOString(), data: [data], notFound: [] }, null, 2));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`Funding estimate server running: http://localhost:${PORT}/api/funding-estimate`);
});
