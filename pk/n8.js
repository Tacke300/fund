const { execSync } = require('child_process');
const tesseract = require("node-tesseract-ocr");
const Jimp = require("jimp");

// --- CẤU HÌNH TỌA ĐỘ (CẦN CHỈNH THEO MÀN HÌNH N8 CỦA BẠN) ---
const CONFIG = {
    regions: {
        pot: { x: 400, y: 750, w: 250, h: 60 },    // Vùng số tiền tổng Pot
        bet: { x: 450, y: 1450, w: 200, h: 60 },  // Vùng số tiền đối thủ đang Bet
    },
    buttons: {
        fold: "250 1850",
        call: "540 1850",
        raise: "830 1850"
    },
    // Sức mạnh bài AJ ước tính (0.0 -> 1.0)
    // Bạn có thể nâng cấp phần này bằng cách đọc lá bài thật
    myEquity: 0.55 
};

const ocrConfig = {
    lang: "eng",
    oem: 1,
    psm: 7, // Chế độ đọc 1 dòng chữ/số
};

// Hàm giả lập suy nghĩ (Tránh bị N8 quét hành vi Bot)
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

async function runBot() {
    console.log("🚀 Bot N8 đang khởi động...");
    
    while (true) {
        try {
            console.log("\n--- [QUÉT LƯỢT MỚI] ---");
            
            // 1. Chụp màn hình
            execSync("screencap -p /sdcard/poker_frame.png");
            const image = await Jimp.read("/sdcard/poker_frame.png");

            // 2. Nhận diện số tiền đối thủ Bet (ví dụ 3642)
            const betImg = image.clone().crop(CONFIG.regions.bet.x, CONFIG.regions.bet.y, CONFIG.regions.bet.w, CONFIG.regions.bet.h);
            await betImg.greyscale().contrast(1).writeAsync("./bet_ocr.png");
            const betRaw = await tesseract.recognize("./bet_ocr.png", ocrConfig);
            const betAmount = parseInt(betRaw.replace(/[^0-9]/g, "")) || 0;

            // 3. Nhận diện tổng Pot
            const potImg = image.clone().crop(CONFIG.regions.pot.x, CONFIG.regions.pot.y, CONFIG.regions.pot.w, CONFIG.regions.pot.h);
            await potImg.greyscale().contrast(1).writeAsync("./pot_ocr.png");
            const potRaw = await tesseract.recognize("./pot_ocr.png", ocrConfig);
            const potTotal = parseInt(potRaw.replace(/[^0-9]/g, "")) || 0;

            console.log(`🔍 Dữ liệu: Bet=${betAmount} | Pot=${potTotal}`);

            // 4. Logic Quyết Định
            await makeDecision(betAmount, potTotal);

        } catch (err) {
            console.log("⚠️ Đang đợi đến lượt hoặc lỗi OCR...");
        }
        
        // Nghỉ 4-7 giây mỗi lượt quét để giống người thật
        await sleep(Math.floor(Math.random() * 3000) + 4000);
    }
}

async function makeDecision(bet, pot) {
    // Nếu không có ai bet (bet = 0), pot odds = 0
    const potOdds = bet > 0 ? (bet / (pot + bet)) : 0;
    const equity = CONFIG.myEquity;

    console.log(`📊 Phân tích: Equity(${(equity*100).toFixed(0)}%) vs PotOdds(${(potOdds*100).toFixed(0)}%)`);

    // Trì hoãn bấm nút 2-4 giây để đánh lừa hệ thống bảo mật
    await sleep(Math.floor(Math.random() * 2000) + 2000);

    // CHIẾN THUẬT:
    // A. Nếu bài cực mạnh (Equity > 70%) -> RERAISE
    if (equity > 0.70) {
        console.log("🔥 CHIẾN THUẬT: RERAISE (TẤN CÔNG)");
        execSync(`input tap ${CONFIG.buttons.raise}`);
    }
    // B. Nếu đối thủ Check (bet=0) và bài khá (Equity > 50%) -> BET lượm tiền
    else if (bet === 0 && equity > 0.50) {
        console.log("🎯 CHIẾN THUẬT: BET VALUE");
        execSync(`input tap ${CONFIG.buttons.raise}`);
    }
    // C. Nếu bài đủ mạnh để theo (Equity > PotOdds) -> CALL
    else if (equity > potOdds) {
        console.log("✅ CHIẾN THUẬT: CALL (HÒA VỐN)");
        execSync(`input tap ${CONFIG.buttons.call}`);
    }
    // D. Bài yếu hoặc lỗ vốn -> FOLD
    else {
        console.log("❌ CHIẾN THUẬT: FOLD (BỎ BÀI)");
        execSync(`input tap ${CONFIG.buttons.fold}`);
    }
}

runBot();
