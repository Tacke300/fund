// index.js
// ----------------------
// LẤY FUNDING HIỆN TẠI TỪ SPOT + FUTURES (BingX)
// - Chỉ tính LPT-USDT
// - HTTP:  GET http://localhost:1997/api/funding
// - WS:    ws://localhost:1997/ws
// - Cập nhật mỗi 60s
// ----------------------

const http = require("http");
const https = require("https");
const { WebSocketServer } = require("ws");

const PORT = 1997; // giữ nguyên port

const SYMBOL = "LPT-USDT";

// === HTTPS GET ===
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "Node/BingX-Funding" } }, (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(buf);
          return reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage} - ${buf}`));
        });
      })
      .on("error", reject)
      .setTimeout(10000, function () {
        this.destroy();
        reject(new Error("Timeout"));
      });
  });
}

// === LẤY SPOT PRICE ===
async function getSpotPrice(symbol) {
  const url = `https://api.bingx.com/api/v1/market/ticker?symbol=${symbol}`;
  const raw = await httpGet(url);
  const json = JSON.parse(raw);
  if (json.code === 0 && json.data && json.data.last) {
    return parseFloat(json.data.last);
  }
  throw new Error(`Cannot get spot price for ${symbol}`);
}

// === LẤY FUTURES MARK PRICE ===
async function getFuturesMarkPrice(symbol) {
  const url = `https://open-api.bingx.com/openApi/swap/v2/quote/markPrice?symbol=${symbol}`;
  const raw = await httpGet(url);
  const json = JSON.parse(raw);
  if (json.code === 0 && json.data && json.data.markPrice) {
    return parseFloat(json.data.markPrice);
  }
  throw new Error(`Cannot get futures mark price for ${symbol}`);
}

// === TÍNH FUNDING RATE HIỆN TẠI ===
function computeFundingRate(spot, markPrice) {
  // ví dụ simple: (futures - spot)/spot / period
  // giả sử period 8h, trả về rate 1 kỳ
  return (markPrice - spot) / spot; // decimal
}

// === STATE ===
let latestFunding = { ts: null, data: [] };

// === CẬP NHẬT ===
async function refreshFunding() {
  try {
    const spot = await getSpotPrice(SYMBOL);
    const mark = await getFuturesMarkPrice(SYMBOL);
    const rate = computeFundingRate(spot, mark);
    latestFunding = {
      ts: new Date().toISOString(),
      data: [
        {
          symbol: SYMBOL,
          spot,
          markPrice: mark,
          fundingRate: rate,
        },
      ],
    };
    console.log(`[Funding] ${SYMBOL}: rate=${rate}, spot=${spot}, mark=${mark}`);
    broadcast({ type: "update", data: latestFunding });
  } catch (e) {
    console.error("[Funding error]", e.message);
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
  ws.send(JSON.stringify({ type: "snapshot", data: latestFunding }));
});

server.listen(PORT, async () => {
  console.log(`Server: http://localhost:${PORT}  (WS: /ws)`);
  await refreshFunding(); // lần đầu
  setInterval(refreshFunding, 60 * 1000); // mỗi 60s
});
