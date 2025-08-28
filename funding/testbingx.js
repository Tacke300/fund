// index.js - BingX Funding hiện tại + next
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URLSearchParams } = require("url");
const { bingxApiKey, bingxApiSecret } = require("./config.js");
const { WebSocketServer } = require("ws");

const HOST = "open-api.bingx.com";
const PORT = 1997;

// === DANH SÁCH COIN YÊU CẦU ===
const TARGET_COINS = [
  "LPT-USDT",
  "CAT-USDT",
  "BIO-USDT",
  "WAVE-USDT",
  // thêm nếu cần
];

// === HMAC SIGN ===
function sign(queryString, secret) {
  return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

// === HTTPS REQUEST ===
function httpGet(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: HOST,
      port: 443,
      path,
      method: "GET",
      headers: {
        ...headers,
        "User-Agent": "Node/BingX-Funding",
      },
      timeout: 20000,
    };
    const req = https.request(options, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(buf);
        return reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage} - ${buf}`));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

// === Lấy contracts hợp lệ ===
async function fetchContracts() {
  const params = new URLSearchParams({ timestamp: Date.now().toString(), recvWindow: "5000" }).toString();
  const signature = sign(params, bingxApiSecret);
  const path = `/openApi/swap/v2/quote/contracts?${params}&signature=${signature}`;
  const headers = { "X-BX-APIKEY": bingxApiKey };
  const raw = await httpGet(path, headers);
  const json = JSON.parse(raw);
  if (json.code !== 0 || !Array.isArray(json.data)) throw new Error(`Contracts error: ${raw}`);
  return new Set(json.data.map(d => d.symbol).filter(Boolean));
}

// === Lấy funding cho 1 symbol ===
async function fetchFundingAll(symbol) {
  const params = new URLSearchParams({ symbol, timestamp: Date.now().toString(), recvWindow: "5000" }).toString();
  const signature = sign(params, bingxApiSecret);
  const path = `/openApi/swap/v2/quote/fundingRate?${params}&signature=${signature}`;
  const headers = { "X-BX-APIKEY": bingxApiKey };
  const raw = await httpGet(path, headers);
  const json = JSON.parse(raw);

  if (json.code === 0 && Array.isArray(json.data)) {
    // Lọc 2 kỳ funding sắp tới
    const now = Date.now();
    const upcoming = json.data.filter(d => d.fundingTime > now).slice(0, 2);
    return upcoming.map(d => ({
      symbol: d.symbol,
      fundingRate: d.fundingRate,
      fundingTime: d.fundingTime,
      markPrice: d.markPrice,
      isoFundingTime: new Date(d.fundingTime).toISOString(),
    }));
  }
  throw new Error(`Funding error ${symbol}: ${raw}`);
}

// === Chuẩn hóa symbol ===
function normalize(sym) {
  let s = sym.toUpperCase().replace(/[/:]/g, "");
  if (!s.includes("-")) s = s.replace(/USDT$/, "-USDT").replace(/USDC$/, "-USDC");
  if (!s.endsWith("-USDT") && !s.endsWith("-USDC")) s += "-USDT";
  return s.replace("--", "-");
}

// === STATE ===
let validSymbols = new Set();
let trackedSymbols = [];
let latestFunding = { ts: null, data: [], notFound: [] };

// === Cập nhật funding ===
async function refreshAll() {
  try {
    validSymbols = await fetchContracts();
  } catch (e) { console.error("[contracts] lỗi:", e.message); }

  const want = TARGET_COINS.map(normalize);
  const ok = [];
  const ko = [];
  for (const s of want) validSymbols.has(s) ? ok.push(s) : ko.push(s);
  trackedSymbols = ok;

  const out = [];
  for (const s of trackedSymbols) {
    try {
      const d = await fetchFundingAll(s); // trả về 2 kỳ funding
      out.push(...d); // push cả 2 kỳ
      d.forEach(f => console.log(`[Funding] ${f.symbol}: rate=${f.fundingRate}, next=${f.isoFundingTime}`));
    } catch (e) { console.error(`[FundingError] ${s}: ${e.message}`); }
  }

  latestFunding = { ts: new Date().toISOString(), data: out, notFound: ko };
  broadcast({ type: "update", data: latestFunding });
}

// === HTTP + WS SERVER ===
const server = http.createServer((req, res) => {
  if (req.url === "/api/funding" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(latestFunding, null, 2));
    return;
  }
  if (req.url === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("OK. Use /api/funding or connect WS at /ws");
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

wss.on("connection", (ws) => ws.send(JSON.stringify({ type: "snapshot", data: latestFunding })));

server.listen(PORT, async () => {
  console.log(`Server: http://localhost:${PORT}  (WS: /ws)`);
  await refreshAll(); // fetch lần đầu
  setInterval(refreshAll, 60 * 1000); // cập nhật mỗi 60s
});
