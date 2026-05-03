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

// --- CẤU HÌNH QUOTA & TIẾN ĐỘ ---
const SETTINGS = {
    SQUARE_URL: "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add",
    M1_LIMIT: 7.0,
    M5_LIMIT: 7.0,
    MAX_BIENDONG: 50,      
    MAX_VOLUME: 50,        
    MAX_TOTAL: 100,       
    VOL_INTERVAL: 15 * 60000, 
    NIGHT_SPEED: 6000,    
};

// --- NGÂN HÀNG 400 CÂU (MỖI PHẦN 100 - BẠN FILL TIẾP VÀO CÁC MẢNG) ---
const BANK = {
    P1: Array(100).fill("").map((_, i) => [
        "🔥 Dòng tiền thông minh đang đổ mạnh.", "🐳 Cá voi đang âm thầm gom hàng.", "💎 Áp lực bán đã cạn kiệt.", "📊 Khối lượng giao dịch tăng vọt.", "⚡ Lực mua đang áp đảo hoàn toàn.", "🔎 Tín hiệu tích lũy on-chain rõ rệt.", "🧱 Nền tảng giá đang cực kỳ vững chắc.", "🏹 Phe bò đã sẵn sàng bứt phá.", "🌟 Dòng tiền dẫn dắt đang lộ diện.", "🌊 Sóng lớn đang bắt đầu hình thành."
    ][i % 10] + ` (P1-ID:${i+1})`),
    
    P2: Array(100).fill("").map((_, i) => [
        "📐 Giá bứt phá khỏi kênh giảm.", "🕯️ Mô hình nến nhấn chìm xác nhận.", "🛤️ Giá nằm trên các đường MA quan trọng.", "💥 Volume nổ xác nhận breakout.", "🚀 Vượt qua kháng cự tâm lý cứng.", "🪄 Chỉ báo RSI đang cực kỳ đẹp.", "🎯 Target ngắn hạn đã được thiết lập.", "🧩 Cấu trúc tăng giá được xác nhận.", "⚡ Tốc độ tăng trưởng đang nhanh dần.", "👑 Vị thế kỹ thuật đang rất ưu thế."
    ][i % 10] + ` (P2-ID:${i+1})`),
    
    P3: Array(100).fill("").map((_, i) => [
        "📝 Kiên nhẫn chờ điểm vào lệnh đẹp.", "🛡️ Quản trị rủi ro tuyệt đối.", "💰 Chia vốn để tối ưu vị thế.", "🔒 Bảo vệ lợi nhuận là ưu tiên.", "📏 Tuân thủ kỷ luật giao dịch.", "🛑 Đừng FOMO tại vùng giá nhạy cảm.", "🎯 Hãy tập trung vào kế hoạch đã đề ra.", "💎 Sự bền bỉ sẽ mang lại quả ngọt.", "📊 Luôn bám sát biến động thị trường.", "🛡️ Đi lệnh nhỏ để giữ tâm lý tốt."
    ][i % 10] + ` (P3-ID:${i+1})`),
    
    P4: Array(100).fill("").map((_, i) => [
        "🍻 Chúc anh em bùng nổ lợi nhuận.", "🍀 May mắn mỉm cười với bạn.", "🌳 Danh mục luôn xanh rực rỡ.", "🏆 Thắng không kiêu bại không nản.", "🚀 Hẹn gặp lại ở vùng giá cao.", "🌟 Chúc anh em có ngày xanh rực.", "🦁 Hãy mạnh mẽ như sư tử.", "🏁 Về đích cùng lợi nhuận lớn.", "🤝 Hợp tác và cùng nhau chiến thắng.", "🌅 Ngày mới đầy năng lượng và lãi."
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

// --- LOGIC LUÔN CHẠY ĐỂ HIỂN THỊ BIẾN ĐỘNG ---
async function updatePriceLogic(s, p, now) {
    if (!state.coinData[s]) state.coinData[s] = { symbol: s, prices: [] };
    let d = state.coinData[s];
    d.prices.push({ p, t: now });
    if (d.prices.length > 600) d.prices.shift(); 

    // Tính toán biến động (luôn chạy dù bot STOP hay START)
    d.live = {
        c1: calculateChange(d.prices, 1),
        c5: calculateChange(d.prices, 5),
        cp: p
    };

    if (!state.isRunning) return; // Nếu chưa Start thì không đăng bài bên dưới

    // 1. Check Biến Động (Đăng ngay khi có m1/m5 đạt limit - Max 50 bài)
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

    const content = `${BANK.P1[Math.floor(Math.random()*100)]}\n\n${BANK.P2[Math.floor(Math.random()*100)]}\n\n${BANK.P3[Math.floor(Math.random()*100)]}\n\n${BANK.P4[Math.floor(Math.random()*100)]}\n\n#${symbol} $${symbol}`;

    try {
        await axios.post(SETTINGS.SQUARE_URL, { bodyTextOnly: content }, {
            headers: { "X-Square-OpenAPI-Key": SQUAD_API_KEY, "Content-Type": "application/json" }
        });
        
        state.totalPosts++;
        if (type === 'biendong') state.postsBiendong++;
        else state.postsVolume++;
        
        state.lastPostTime = Date.now();
        state.postedTodaySymbols.add(symbol);
        addLog(`✅ [${type.toUpperCase()}] ${symbol} | Lý do: ${reason} | [${state.totalPosts}/100]`);
    } catch (e) {
        addLog(`❌ Lỗi API: ${e.response?.data?.message || e.message}`);
    }
}

// --- CRON JOB: RESET & ÉP TIẾN ĐỘ ---
async function cronJob() {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();

    if (h === 0 && m === 0) {
        state.totalPosts = 0; state.postsBiendong = 0; state.postsVolume = 0;
        state.postedTodaySymbols.clear();
        addLog("🧹 Đã Reset dữ liệu ngày mới.");
    }

    if (!state.isRunning) return;

    // Ép tiến độ từ 23h - 0h (Tốc độ 6000ms/bài)
    if (h === 23 && state.totalPosts < SETTINGS.MAX_TOTAL) {
        addLog(`🚀 [PHASE 23H] Đang có ${state.totalPosts} bài. Bắt đầu ép vol cho đủ 100...`);
        try {
            const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
            const topCoins = res.data
                .filter(t => t.symbol.endsWith('USDT'))
                .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));

            for (let coin of topCoins) {
                if (state.totalPosts >= SETTINGS.MAX_TOTAL || !state.isRunning) break;
                if (state.postedTodaySymbols.has(coin.symbol)) continue;

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
        const raw = JSON.parse(data);
        const now = Date.now();
        raw.forEach(t => { if (t.s.endsWith('USDT')) updatePriceLogic(t.s, parseFloat(t.c), now); });
    });
    ws.on('close', () => setTimeout(initWS, 5000));
}

const app = express();
app.get('/api/status', (req, res) => {
    // Luôn trả về 10 coin có biến động mạnh nhất hiện tại
    const table = Object.values(state.coinData)
        .filter(v => v.live)
        .sort((a, b) => Math.abs(b.live.c5) - Math.abs(a.live.c5))
        .slice(0, 10)
        .map(v => ({ s: v.symbol, c1: v.live.c1, c5: v.live.c5 }));
    res.json({ ...state, table });
});

app.get('/api/toggle', (req, res) => { 
    state.isRunning = !state.isRunning; 
    addLog(`Trạng thái: ${state.isRunning ? 'RUNNING' : 'STOPPED'}`);
    res.json({ s: state.isRunning }); 
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script><style>@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@700&display=swap');body{background:#0b0e11;color:#eceff1;font-family:sans-serif;}.luffy{font-family:'Orbitron';}::-webkit-scrollbar{width:0;}</style></head>
    <body class="p-4 h-screen flex flex-col overflow-hidden max-w-md mx-auto">
        <div class="bg-[#1e2329] p-6 rounded-3xl border-b-4 border-yellow-500 shadow-xl mb-4">
            <div class="flex justify-between items-center mb-6">
                <h1 class="luffy text-2xl text-yellow-500 italic">LUFFY V4</h1>
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
                <span id="st" class="text-2xl font-black text-yellow-500">0</span><span class="text-yellow-500/50 text-sm"> / 100 POSTS TODAY</span>
            </div>
        </div>

        <div class="bg-[#1e2329] rounded-3xl flex-1 flex flex-col mb-4 overflow-hidden border border-white/5">
            <div class="p-3 bg-white/5 text-center luffy text-[10px] text-yellow-500 tracking-widest uppercase border-b border-white/5">Top Tracking</div>
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
                        <div class="bg-black/20 p-3 rounded-xl flex justify-between items-center">
                            <span class="font-bold text-sm text-white">\${v.s.replace('USDT','')}</span>
                            <div class="flex gap-4 text-[11px]">
                                <span class="\${Math.abs(v.c1) >= 3.5 ? 'text-red-500 font-bold' : 'text-zinc-400'}">1m: \${v.c1}%</span>
                                <span class="\${Math.abs(v.c5) >= 7 ? 'text-green-500 font-bold' : 'text-zinc-400'}">5m: \${v.c5}%</span>
                            </div>
                        </div>\`).join('');

                    if (d.logs.length > 0) document.getElementById('lb').innerHTML = d.logs.map(l => \`<div class="mb-1">\${l}</div>\`).join('');
                } catch(e){}
            }
            setInterval(refresh, 2000);
        </script>
    </body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { 
    addLog("🏴‍☠️ LUFFY V4 VIP STARTED - LOGGING ACTIVE 🏴‍☠️");
    initWS(); 
});
