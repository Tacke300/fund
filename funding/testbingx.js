// index_LPT.js
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URLSearchParams } = require("url");
const { bingxApiKey, bingxApiSecret } = require("./config.js");
const { WebSocketServer } = require("ws");

const HOST = "open-api.bingx.com";
const PORT = 1997;
const TARGET_SYMBOL = "LPT-USDT";

// HMAC sign
function sign(queryString, secret) {
  return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

// HTTPS GET
function httpGet(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = { hostname: HOST, port: 443, path, method: "GET", headers: { ...headers, "User-Agent": "Node/BingX-LPT" }, timeout: 20000 };
    const req = https.request(options, (res) => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(buf);
        else reject(new Error(`HTTP ${res.statusCode}: ${buf}`));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// Lấy contracts hợp lệ
async function fetchContracts() {
  const params = new URLSearchParams({ timestamp: Date.now().toString(), recvWindow: "5000" }).toString();
  const signature = sign(params, bingxApiSecret);
  const path = `/openApi/swap/v2/quote/contracts?${params}&signature=${signature}`;
  const headers = { "X-BX-APIKEY": bingxApiKey };
  const raw = await httpGet(path, headers);
  const json = JSON.parse(raw);
  if (json.code !== 0 || !Array.isArray(json.data)) throw new Error(raw);
  return new Set(json.data.map(d => d.symbol));
}

// Lấy funding hiện tại
async function fetchFunding(symbol) {
  const params = new URLSearchParams({ symbol, timestamp: Date.now().toString(), recvWindow: "5000" }).toString();
  const signature = sign(params, bingxApiSecret);
  const path = `/openApi/swap/v2/quote/fundingRate?${params}&signature=${signature}`;
  const headers = { "X-BX-APIKEY": bingxApiKey };
  const raw = await httpGet(path, headers);
  const json = JSON.parse(raw);
  if (json.code !== 0 || !Array.isArray(json.data) || json.data.length === 0) throw new Error(raw);
  const d = json.data[0];
  return { symbol: d.symbol, fundingRate: d.fundingRate, fundingTime: new Date(d.fundingTime).toISOString() };
}

// === STATE ===
let latestFunding = null;

// === Cập nhật funding LPT ===
async function refreshLPT() {
  try {
    const contracts = await fetchContracts();
    if (!contracts.has(TARGET_SYMBOL)) throw new Error(`${TARGET_SYMBOL} không tồn tại`);
    const funding = await fetchFunding(TARGET_SYMBOL);
    latestFunding = { ts: new Date().toISOString(), data: [funding] };
    console.log(`[Funding] ${funding.symbol}: rate=${funding.fundingRate}, next=${funding.fundingTime}`);
    broadcast({ type: "update", data: latestFunding });
  } catch (e) {
    console.error(`[FundingError] ${TARGET_SYMBOL}: ${e.message}`);
  }
}

// === HTTP + WS SERVER ===
const server = http.createServer((req, res) => {
  if (req.url === "/api/funding" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(latestFunding, null, 2));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

const wss = new WebSocketServer({ noServer: true });
function broadcast(msgObj) {
  const data = JSON.stringify(msgObj);
  for (const client of wss.clients) if (client.readyState === 1) client.send(data);
}

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  else socket.destroy();
});

wss.on("connection", ws => {
  if (latestFunding) ws.send(JSON.stringify({ type: "snapshot", data: latestFunding }));
});

server.listen(PORT, async () => {
  console.log(`Server: http://localhost:${PORT}  (WS: /ws)`);
  await refreshLPT(); // lần đầu
  setInterval(refreshLPT, 60*1000); // mỗi 60s
});
