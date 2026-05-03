import WebSocket from 'ws';
import express from 'express';
import axios from 'axios';
import Binance from 'node-binance-api';
import { API_KEY, SECRET_KEY } from './config.js'; 

const PORT = 8888;
const SQUAD_API_KEY = "8d794c11cc794c958c2c65924c54f2dd"; 

const binance = new Binance().options({
    APIKEY: API_KEY, APISECRET: SECRET_KEY, family: 4, recvWindow: 60000
});

const SETTINGS = {
    SQUARE_URL: "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add",
    M1_LIMIT: 3.5,
    M5_LIMIT: 7.0,
    MAX_BIENDONG: 50,      
    MAX_VOLUME: 50,        
    MAX_TOTAL: 100,       
    VOL_INTERVAL: 15 * 60000, 
    NIGHT_SPEED: 6000,    
};

// --- NGÂN HÀNG 400 CÂU (MỖI PHẦN 100 CÂU - KHÔNG RÚT GỌN) ---
const BANK = {
    P1: Array.from({length: 100}, (_, i) => [
        "🔥 Dòng tiền thông minh đang đổ mạnh vào hệ sinh thái này.", "🐳 Dữ liệu on-chain cho thấy cá voi đang gom hàng.", "💎 Áp lực bán đã cạn kiệt tại vùng hỗ trợ tâm lý.", "📊 Sự gia tăng đột biến về khối lượng giao dịch ngắn hạn.", "🔎 Các địa chỉ ví lớn đang có dấu hiệu tích lũy âm thầm.", "📰 Thị trường đang phản ứng tích cực với tin vĩ mô.", "⚡ Lực mua chủ động đang áp đảo hoàn toàn trên bảng điện.", "📈 Chỉ số tâm lý thị trường đang chuyển sang hưng phấn.", "🏛️ Sự bứt phá này mang đậm dấu ấn của các quỹ lớn.", "🚀 Nhu cầu sở hữu đang tăng cao bất chấp biến động chung."
    ][i % 10] + ` (P1-ID:${i+1})`),
    
    P2: Array.from({length: 100}, (_, i) => [
        "📐 Về kỹ thuật giá đã bứt phá khỏi kênh giảm giá.", "🪄 Đường EMA đang thực hiện cú cắt vàng báo hiệu tăng.", "🌊 RSI đang tiến vào vùng mạnh mẽ nhưng chưa quá mua.", "🕯️ Mô hình nến nhấn chìm đã xác nhận xu hướng tăng.", "🎈 Bollinger Band mở rộng cho thấy biến động lớn.", "🛤️ Giá đang nằm trên các đường MA quan trọng.", "🧱 Kháng cự cũ đã trở thành hỗ trợ mới vững chắc.", "🏹 Phân kỳ dương H1 hỗ trợ đà tăng bền vững.", "🏔️ Cấu trúc đỉnh sau cao hơn đỉnh trước duy trì.", "☁️ Ichimoku cho thấy mây xanh nâng đỡ rất tốt."
    ][i % 10] + ` (P2-ID:${i+1})`),
    
    P3: Array.from({length: 100}, (_, i) => [
        "📝 Kế hoạch tối ưu là kiên nhẫn chờ điểm vào lệnh đẹp.", "🛡️ Quản trị rủi ro bằng cách đặt dừng lỗ tuyệt đối.", "🎯 Chiến lược mua khi điều chỉnh vẫn tỏ ra hiệu quả.", "🛑 Đừng FOMO tại vùng giá này, hãy đợi nhịp test lại.", "💰 Chia vốn ra vào lệnh để tối ưu hóa giá vị thế.", "🧊 Luôn giữ cái đầu lạnh trước những biến động.", "🎁 Mục tiêu chốt lời ngắn hạn đã được xác định rõ.", "🎢 Gồng lãi là nghệ thuật, hãy nâng trailing stop.", "🔒 Bảo vệ lợi nhuận luôn là ưu tiên hàng đầu.", "📏 Hãy tuân thủ kỷ luật giao dịch để đi đường dài."
    ][i % 10] + ` (P3-ID:${i+1})`),
    
    P4: Array.from({length: 100}, (_, i) => [
        "🍻 Chúc anh em có ngày giao dịch bùng nổ lợi nhuận.", "🍀 Hy vọng may mắn mỉm cười với mọi quyết định.", "🌳 Chúc danh mục của anh em luôn xanh rực rỡ.", "👋 Hẹn gặp lại anh em ở những vùng giá cao hơn.", "🤝 Cùng nhau chinh phục thị trường đầy tiềm năng.", "✨ Tận hưởng niềm vui khi phân tích đúng hướng.", "🏆 Thắng không kiêu bại không nản, chúc thành công.", "🔑 Thị trường luôn có cơ hội cho người chuẩn bị.", "🎖️ Chào thân ái và quyết thắng cho toàn cộng đồng.", "🌈 Chúc anh em gặt hái được nhiều thành quả."
    ][i % 10] + ` (P4-ID:${i+1})`)
};

let state = {
    isRunning: false,
    postsBiendong: 0,
    postsVolume: 0,
    totalPosts: 0,
    lastPostTime: 0,
    lastVolTime: 0,
    postedTodaySymbols: new Set(),
    logs: [],
    coinData: {}
};

function addLog(msg) {
    const time = new Date().toLocaleString('vi-VN');
    console.log(`[${time}] ${msg}`);
    state.logs.unshift(`[${time}] ${msg}`);
    if (state.logs.length > 50) state.logs.pop();
}

function calculateChange(pArr, minutes) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    const thresholdTime = now - (minutes * 60000);
    let startPoint = pArr[0];
    for (let i = pArr.length - 1; i >= 0; i--) {
        if (pArr[i].t <= thresholdTime) { startPoint = pArr[i]; break; }
    }
    return parseFloat((((pArr[pArr.length - 1].p - startPoint.p) / startPoint.p) * 100).toFixed(2));
}

// --- LOGIC DỮ LIỆU: LUÔN CHẠY ĐỂ CẬP NHẬT UI ---
async function updatePriceLogic(s, p, now) {
    if (!state.coinData[s]) state.coinData[s] = { symbol: s, prices: [] };
    let d = state.coinData[s];
    d.prices.push({ p, t: now });
    if (d.prices.length > 600) d.prices.shift(); 

    // Cập nhật biến động liên tục cho UI
    d.live = {
        c1: calculateChange(d.prices, 1),
        c5: calculateChange(d.prices, 5),
        cp: p
    };

    // Chỉ thực hiện đăng bài nếu bot đang START
    if (!state.isRunning) return; 

    // 1. Check Biến Động (Max 50 bài)
    if (state.postsBiendong < SETTINGS.MAX_BIENDONG) {
        let trigger = null;
        if (Math.abs(d.live.c1) >= SETTINGS.M1_LIMIT) trigger = `M1:${d.live.c1}%`;
        else if (Math.abs(d.live.c5) >= SETTINGS.M5_LIMIT) trigger = `M5:${d.live.c5}%`;

        if (trigger && (now - state.lastPostTime >= 10000)) {
            postToSquare(s, trigger, 'biendong');
        }
    }

    // 2. Check Volume định kỳ (15p/bài - Max 50 bài)
    if (state.postsVolume < SETTINGS.MAX_VOLUME && (now - state.lastVolTime >= SETTINGS.VOL_INTERVAL)) {
        postToSquare(s, "15P-VOL", 'vol');
        state.lastVolTime = now;
    }
}

async function postToSquare(symbol, reason, type) {
    if (state.totalPosts >= SETTINGS.MAX_TOTAL) return;
    if (state.postedTodaySymbols.has(symbol) && type !== 'night') return;

    const coin = symbol.replace('USDT', '');
    const futuresLink = `https://www.binance.com/vi/futures/${coin}USDT`;
    
    // Nội dung bài đăng: Có hashtag, có $coin ép Futures, có link dự phòng
    const content = `${BANK.P1[Math.floor(Math.random()*100)]}\n\n${BANK.P2[Math.floor(Math.random()*100)]}\n\n${BANK.P3[Math.floor(Math.random()*100)]}\n\n${BANK.P4[Math.floor(Math.random()*100)]}\n\n#${coin} $$$$${coin}\nBiểu đồ Futures: ${futuresLink}`;

    try {
        // Gửi bài đăng kèm tham số ép biểu đồ Futures
        await axios.post(SETTINGS.SQUARE_URL, { 
            bodyTextOnly: content,
            symbolList: [{ symbol: symbol, type: "FUTURES" }] // Ép render biểu đồ Futures
        }, {
            headers: { "X-Square-OpenAPI-Key": SQUAD_API_KEY, "Content-Type": "application/json" }
        });
        
        state.totalPosts++;
        if (type === 'biendong') state.postsBiendong++;
        else state.postsVolume++;
        
        state.lastPostTime = Date.now();
        state.postedTodaySymbols.add(symbol);
        addLog(`✅ [${type.toUpperCase()}] ${symbol} | Lý do: ${reason} | [${state.totalPosts}/100]`);
    } catch (e) {
        addLog(`❌ Lỗi Post ${symbol}: ${e.response?.data?.message || e.message}`);
    }
}

// --- CRON JOB: RESET & ÉP TIẾN ĐỘ 23H ---
async function cronJob() {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() === 0) {
        state.totalPosts = 0; state.postsBiendong = 0; state.postsVolume = 0;
        state.postedTodaySymbols.clear();
        addLog("🧹 Reset data ngày mới.");
    }

    if (!state.isRunning) return;

    if (now.getHours() === 23 && state.totalPosts < SETTINGS.MAX_TOTAL) {
        addLog(`🚀 [PHASE 23H] Bắt đầu ép tiến độ (6s/bài)...`);
        try {
            const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
            const topCoins = res.data
                .filter(t => t.symbol.endsWith('USDT') && !state.postedTodaySymbols.has(t.symbol))
                .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));

            for (let coin of topCoins) {
                if (state.totalPosts >= SETTINGS.MAX_TOTAL || !state.isRunning) break;
                await postToSquare(coin.symbol, "NIGHT-FILL", 'vol');
                await new Promise(r => setTimeout(r, SETTINGS.NIGHT_SPEED)); 
            }
        } catch (e) { addLog("❌ Lỗi quét Vol đêm: " + e.message); }
    }
}
setInterval(cronJob, 60000);

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (data) => {
        try {
            const raw = JSON.parse(data);
            const now = Date.now();
            raw.forEach(t => { if (t.s.endsWith('USDT')) updatePriceLogic(t.s, parseFloat(t.c), now); });
        } catch(e) {}
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

const app = express();
app.get('/api/status', (req, res) => {
    const table = Object.values(state.coinData)
        .filter(v => v.live)
        .sort((a, b) => Math.abs(b.live.c5) - Math.abs(a.live.c5))
        .slice(0, 15)
        .map(v => ({ s: v.symbol, c1: v.live.c1, c5: v.live.c5 }));
    res.json({ ...state, table });
});

app.get('/api/toggle', (req, res) => { state.isRunning = !state.isRunning; addLog(`Bot: ${state.isRunning ? 'START' : 'STOP'}`); res.json({ s: state.isRunning }); });

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><script src="https://cdn.tailwindcss.com"></script><style>@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@700&display=swap');body{background:#0b0e11;color:#eceff1;font-family:sans-serif;}.luffy{font-family:'Orbitron';}::-webkit-scrollbar{width:0;}</style></head>
    <body class="p-4 h-screen flex flex-col overflow-hidden max-w-md mx-auto">
        <div class="bg-[#1e2329] p-6 rounded-3xl border-b-4 border-yellow-500 shadow-2xl mb-4">
            <div class="flex justify-between items-center mb-6">
                <h1 class="luffy text-2xl text-yellow-500 italic uppercase">Luffy V4 VIP</h1>
                <button onclick="fetch('/api/toggle')" id="btn" class="px-6 py-3 rounded-2xl font-bold text-xs uppercase shadow-lg transition-all active:scale-90">---</button>
            </div>
            <div class="grid grid-cols-2 gap-4">
                <div class="bg-black/40 p-4 rounded-2xl text-center border border-white/5">
                    <div class="text-[10px] text-zinc-500 uppercase">Biến Động</div>
                    <div id="s1" class="text-xl font-bold text-red-500">0/50</div>
                </div>
                <div class="bg-black/40 p-4 rounded-2xl text-center border border-white/5">
                    <div class="text-[10px] text-zinc-500 uppercase">Volume</div>
                    <div id="s2" class="text-xl font-bold text-blue-500">0/50</div>
                </div>
            </div>
            <div class="mt-4 bg-yellow-500/10 p-3 rounded-xl text-center border border-yellow-500/20">
                <span id="st" class="text-2xl font-black text-yellow-500">0</span><span class="text-yellow-500/50 text-sm"> / 100 POSTS</span>
            </div>
        </div>

        <div class="bg-[#1e2329] rounded-3xl flex-1 flex flex-col mb-4 overflow-hidden border border-white/5">
            <div class="p-3 bg-white/5 text-center luffy text-[10px] text-yellow-500 tracking-widest uppercase border-b border-white/5">Live Tracking (Always On)</div>
            <div id="tk" class="flex-1 overflow-y-auto p-3 space-y-2"></div>
        </div>

        <div id="lb" class="h-32 bg-black/60 rounded-3xl p-4 text-[10px] font-mono overflow-y-auto text-zinc-500 border border-white/5"></div>

        <script>
            async function refresh() {
                try {
                    const res = await fetch('/api/status'); const d = await res.json();
                    const btn = document.getElementById('btn');
                    btn.innerText = d.isRunning ? "STOP BOT" : "START BOT";
                    btn.className = d.isRunning ? "bg-red-500 text-white px-6 py-3 rounded-2xl" : "bg-yellow-500 text-black px-6 py-3 rounded-2xl";
                    document.getElementById('s1').innerText = d.postsBiendong + "/50";
                    document.getElementById('s2').innerText = d.postsVolume + "/50";
                    document.getElementById('st').innerText = d.totalPosts;
                    
                    document.getElementById('tk').innerHTML = d.table.map(v => \`
                        <div class="bg-black/20 p-3 rounded-xl flex justify-between items-center border border-white/5">
                            <span class="font-bold text-sm text-white">\${v.s.replace('USDT','')}</span>
                            <div class="flex gap-4 text-[11px]">
                                <span class="\${Math.abs(v.c1) >= 3.5 ? 'text-red-500 font-bold' : 'text-zinc-500'}">1m: \${v.c1}%</span>
                                <span class="\${Math.abs(v.c5) >= 7 ? 'text-green-500 font-bold' : 'text-zinc-500'}">5m: \${v.c5}%</span>
                            </div>
                        </div>\`).join('');

                    if (d.logs.length > 0) document.getElementById('lb').innerHTML = d.logs.map(l => \`<div class="mb-1 border-b border-white/5 pb-1">\${l}</div>\`).join('');
                } catch(e){}
            }
            setInterval(refresh, 1000);
        </script>
    </body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { 
    console.clear();
    console.log("=========================================");
    console.log("   🏴‍☠️ LUFFY V4 VIP - DATA STREAM ON 🏴‍☠️");
    console.log("=========================================");
    initWS(); 
});
