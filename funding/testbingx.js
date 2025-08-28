// index.js
// Funding estimate hiện tại từ spot/futures BingX
// HTTP:  GET http://localhost:1997/api/funding-estimate
// WS:    ws://localhost:1997/ws

const http = require("http");
const https = require("https");
const { WebSocketServer } = require("ws");

const PORT = 1997;

// DANH SÁCH SYMBOL muốn tính
const TARGET_COINS = [
  "LPT-USDT",
  "BIO-USDT",
  "CAT-USDT",
  "WAVE-USDT",
];

// === HTTPS GET helper ===
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "Node/BingX-Funding" } }, (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(buf);
          else reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage}`));
        });
      })
      .on("error", reject);
  });
}

// === Tính funding estimate ===
async function fetchFundingEstimate(symbol) {
  try {
    // Spot price
    const spotRaw = await httpGet(`https://api.bingx.com/api/v1/market/ticker?symbol=${symbol}`);
    const spotJson = JSON.parse(spotRaw);
    if (!spotJson || !spotJson.price) throw new Error("Spot not found");

    // Futures price
    const futuRaw = await httpGet(`https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=${symbol}`);
    const futuJson = JSON.parse(futuRaw);
    if (!futuJson || !futuJson.data || !futuJson.data[0]) throw new Error("Futu not found");

    const S = parseFloat(spotJson.price);
    const F = parseFloat(futuJson.data[0].lastPrice);
    const rate = (F - S) / S; // funding estimate hiện tại

    return {
      symbol,
      spot: S,
      futures: F,
      fundingEstimate: rate,
      ts: new Date().toISOString(),
    };
  } catch (e) {
    return { symbol, error: e.message };
  }
}

// === STATE ===
let latestFunding = { ts: null, data: [] };

// === Cập nhật tất cả symbol ===
async function refreshAll() {
  const out = [];
  for (const s of TARGET_COINS) {
    const d = await fetchFundingEstimate(s);
    out.push(d);
    if (!d.error)
      console.log(`[FundingEstimate] ${s}: rate=${d.fundingEstimate.toFixed(6)}`);
    else console.log(`[FundingError] ${s}: ${d.error}`);
  }
  latestFunding = { ts: new Date().toISOString(), data: out };
  broadcast({ type: "update", data: latestFunding });
}

// === HTTP + WS server ===
const server = http.createServer((req, res) => {
  if (req.url === "/api/funding-estimate" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(latestFunding, null, 2));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

const wss = new WebSocketServer({ noServer: true });
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) if (client.readyState === 1) client.send(data);
}

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  else socket.destroy();
});

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "snapshot", data: latestFunding }));
});

server.listen(PORT, async () => {
  console.log(`Funding estimate server running: http://localhost:${PORT}/api/funding-estimate`);
  await refreshAll();
  setInterval(refreshAll, 60 * 1000); // update mỗi 60s
});
