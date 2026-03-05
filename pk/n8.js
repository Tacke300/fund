const { execSync } = require('child_process');
const tesseract = require("node-tesseract-ocr");
const Jimp = require("jimp");
const chalk = require("chalk");

// --- CẤU HÌNH TỌA ĐỘ TỪ ẢNH CỦA BẠN ---
const CONFIG = {
    regions: {
        pot: { x: 450, y: 440, w: 120, h: 40 },        // Tổng Pot (512)
        callAmt: { x: 440, y: 940, w: 130, h: 40 },    // Số trên nút Theo bài (160)
    },
    buttons: {
        fold: "250 950",
        call: "500 950",
        raise_pot: "830 750",  // Nút Pot (832)
        raise_2bb: "830 950"   // Nút 2BB (320)
    },
    // Giả định bài AJ có Equity khoảng 55%
    myEquity: 0.55 
};

const ocrConfig = { lang: "eng", oem: 1, psm: 7 };

// --- HÀM HIỂN THỊ LOG KIỂU DASHBOARD ---
function renderLog(data) {
    console.clear();
    console.log(chalk.bold.yellow("========================================"));
    console.log(chalk.bold.red("   N8 POKER BOT - PM2 MONITORING   "));
    console.log(chalk.bold.yellow("========================================"));
    console.log(`${chalk.cyan("💰 TỔNG POT:")}      ${chalk.white(data.pot)}`);
    console.log(`${chalk.cyan("⚠️ MỨC THEO (CALL):")} ${chalk.white(data.call)}`);
    console.log(`${chalk.cyan("📊 POT ODDS:")}      ${chalk.magenta(data.potOdds + "%")}`);
    console.log(`${chalk.cyan("🧬 EQUITY (AJ):")}  ${chalk.green((CONFIG.myEquity * 100).toFixed(0) + "%")}`);
    console.log(chalk.yellow("----------------------------------------"));
    
    if (data.decision) {
        const color = data.decision === "CALL" ? chalk.bgGreen : (data.decision === "RAISE" ? chalk.bgYellow : chalk.bgRed);
        console.log(color.black.bold(` >>> HÀNH ĐỘNG: ${data.decision} <<< `));
    } else {
        console.log(chalk.blue("⏳ ĐANG CHỜ ĐẾN LƯỢT..."));
    }
    console.log(chalk.bold.yellow("========================================"));
}

async function startBot() {
    while (true) {
        try {
            // 1. Chụp ảnh màn hình
            execSync("screencap -p /sdcard/poker.png");
            const image = await Jimp.read("/sdcard/poker.png");

            // 2. OCR Đọc số (Pot và mức Call)
            const potVal = await readOCR(image, CONFIG.regions.pot);
            const callVal = await readOCR(image, CONFIG.regions.callAmt);

            if (potVal > 0) {
                const potOdds = ((callVal / (potVal + callVal)) * 100).toFixed(1);
                let decision = "FOLD";

                // 3. LOGIC QUYẾT ĐỊNH
                // A. Nếu bài cực mạnh (>70%) -> RAISE/BET
                if (CONFIG.myEquity > 0.70) {
                    decision = "RAISE";
                    execSync(`input tap ${CONFIG.buttons.raise_pot}`);
                }
                // B. Nếu bài đủ mạnh để Call theo xác suất
                else if (CONFIG.myEquity > (potOdds / 100)) {
                    decision = "CALL";
                    execSync(`input tap ${CONFIG.buttons.call}`);
                }
                // C. Nếu không ai bet (Call=0), bài trung bình -> CHECK/BET NHẸ
                else if (callVal === 0 && CONFIG.myEquity > 0.50) {
                    decision = "RAISE"; // Bet nhẹ 2BB
                    execSync(`input tap ${CONFIG.buttons.raise_2bb}`);
                }
                else {
                    decision = "FOLD";
                    execSync(`input tap ${CONFIG.buttons.fold}`);
                }

                renderLog({ pot: potVal, call: callVal, potOdds, decision });
            }
        } catch (err) {
            // Lỗi thường do chưa đến lượt hoặc app bị che
            renderLog({ pot: "---", call: "---", potOdds: "---", decision: null });
        }
        
        // Nghỉ 5 giây để tránh bị quét hành vi bot
        await new Promise(r => setTimeout(r, 5000));
    }
}

async function readOCR(image, region) {
    const cropped = image.clone().crop(region.x, region.y, region.w, region.h);
    await cropped.greyscale().contrast(1).writeAsync("./temp_ocr.png");
    const text = await tesseract.recognize("./temp_ocr.png", ocrConfig);
    return parseInt(text.replace(/[^0-9]/g, "")) || 0;
}

startBot();
