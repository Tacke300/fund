// index.js
// ----------------------
// LẤY FUNDING “HIỆN TẠI” THỰC TẾ TỪ BINGX (REST) + WEBSOCKET BROADCAST
// - Tự kiểm tra symbol hợp lệ qua /openApi/swap/v2/quote/contracts
// - Chỉ query những symbol THỰC SỰ tồn tại => hết lỗi 109400 / 80014
// - Cập nhật mỗi 60s (funding không có WS sàn), đẩy realtime cho client qua WebSocket
// - HTTP:  GET http://localhost:1997/api/funding   (snapshot mới nhất)
// - WS:    ws://localhost:1997/ws  (nhận {type:"snapshot"|"update", data:[...]})
// ----------------------

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URLSearchParams } = require("url");
const { bingxApiKey, bingxApiSecret } = require("./config.js");
const { WebSocketServer } = require("ws");

const HOST = "open-api.bingx.com";
const PORT = 1997;

// === DANH SÁCH COIN YÊU CẦU (ĐÚNG FORMAT -USDT/-USDC) ===
// Mặc định lấy đúng chuỗi bạn muốn; script sẽ tự loại coin KHÔNG tồn tại.
const TARGET_COINS = [
  "LPT-USDT",
  "CAT-USDT",
  "BIO-USDT",
  "WAVE-USDT", // nếu không có sẽ tự loại
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
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Node/BingX-Funding",
      },
      timeout: 20000,
    };

    const req = https.request(options, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(buf);
        return reject(
          new Error(`HTTP ${res.statusCode} ${res.statusMessage} - ${buf}`)
        );
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

// === CALL: /openApi/swap/v2/quote/contracts (ký đầy đủ) ===
async function fetchContracts() {
  const params = new URLSearchParams({
    timestamp: Date.now().toString(),
    recvWindow: "5000",
  }).toString();
  const signature = sign(params, bingxApiSecret);
  const path = `/openApi/swap/v2/quote/contracts?${params}&signature=${signature}`;
  const headers = { "X-BX-APIKEY": bingxApiKey };
  const raw = await httpGet(path, headers);
  const json = JSON.parse(raw);
  if (json.code !== 0 || !Array.isArray(json.data)) {
    throw new Error(`Contracts error: ${raw}`);
  }
  // Trả về Set các symbol hợp lệ, ví dụ "LPT-USDT"
  const set = new Set(json.data.map((d) => d.symbol).filter(Boolean));
  return set;
}

// === CALL: /openApi/swap/v2/quote/fundingRate (ký đầy đủ) ===
async function fetchFundingOne(symbol) {
  const params = new URLSearchParams({
    symbol,
    timestamp: Date.now().toString(),
    recvWindow: "5000",
  }).toString();
  const signature = sign(params, bingxApiSecret);
  const path = `/openApi/swap/v2/quote/fundingRate?${params}&signature=${signature}`;
  const headers = { "X-BX-APIKEY": bingxApiKey };
  const raw = await httpGet(path, headers);
  const json = JSON.parse(raw);

  if (json.code === 0 && Array.isArray(json.data) && json.data.length > 0) {
    // phần tử đầu là kỳ funding sắp tới (theo BingX trả về)
    const d = json.data[0];
    return {
      symbol: d.symbol,
      fundingRate: d.fundingRate,
      fundingTime: d.fundingTime, // ms
      markPrice: d.markPrice,
      isoFundingTime:
        typeof d.fundingTime === "number"
          ? new Date(d.fundingTime).toISOString()
          : null,
    };
  }
  throw new Error(`Funding error ${symbol}: ${raw}`);
}

// === LỌC SYMBOL HỢP LỆ SO VỚI CONTRACTS ===
function normalize(sym) {
  // ép định dạng ABC-USD[T|C]
  let s = sym.toUpperCase().replace(/[/:]/g, "");
  if (!s.includes("-")) {
    s = s.replace(/USDT$/, "-USDT").replace(/USDC$/, "-USDC");
  }
  s = s.replace("--", "-");
  if (!s.endsWith("-USDT") && !s.endsWith("-USDC")) s = s + "-USDT";
  return s;
}

// === STATE ===
let validSymbols = new Set();
let trackedSymbols = []; // chỉ gồm các symbol có thật
let latestFunding = { ts: null, data: [], notFound: [] };

// === CHU KỲ CẬP NHẬT ===
async function refreshAll() {
  // 1) lấy contracts
  try {
    validSymbols = await fetchContracts();
  } catch (e) {
    console.error("[contracts] lỗi:", e.message);
    // nếu lỗi, giữ validSymbols cũ (nếu có)
  }

  // 2) chuẩn hoá & lọc symbol tồn tại thật
  const want = TARGET_COINS.map(normalize);
  const ok = [];
  const ko = [];
  for (const s of want) {
    if (validSymbols.has(s)) ok.push(s);
    else ko.push(s);
  }
  trackedSymbols = ok;

  // 3) query funding cho các symbol hợp lệ
  const out = [];
  for (const s of trackedSymbols) {
    try {
      const d = await fetchFundingOne(s);
      out.push(d);
      console.log(
        `[Funding] ${d.symbol}: rate=${d.fundingRate}, next=${d.isoFundingTime}`
      );
    } catch (e) {
      console.error(`[FundingError] ${s}: ${e.message}`);
    }
  }

  latestFunding = {
    ts: new Date().toISOString(),
    data: out,
    notFound: ko, // để bạn thấy symbol nào bị loại do “không tồn tại”
  };

  // broadcast WS
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
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  // gửi snapshot ngay khi nối
  ws.send(JSON.stringify({ type: "snapshot", data: latestFunding }));
});

server.listen(PORT, async () => {
  console.log(`Server: http://localhost:${PORT}  (WS: /ws)`);
  await refreshAll(); // fetch lần đầu
  setInterval(refreshAll, 60 * 1000); // cập nhật mỗi 60s
});
