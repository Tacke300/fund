const { execSync } = require('child_process');
const tesseract = require("node-tesseract-ocr");
const Jimp = require("jimp");
const chalk = require("chalk");

// --- CẤU HÌNH TỌA ĐỘ VÀ ĐƯỜNG DẪN ---
const RISH_PATH = "/data/data/com.termux/files/home/fund/pk/rish.sh";
const IMG_PATH = "/sdcard/poker.png";

const CONFIG = {
    regions: {
        pot: { x: 450, y: 440, w: 120, h: 40 },        // Vùng hiển thị tổng Pot
        callAmt: { x: 440, y: 940, w: 130, h: 40 }     // Số tiền trên nút Call
    },
    buttons: {
        fold: "250 950",
        call: "500 950",
        raise: "830 950"
    },
    myEquity: 0.55 // Giả định bài AJ có 55% thắng
};

const ocrConfig = { lang: "eng", oem: 1, psm: 7 };

// --- HÀM LOG GIAO DIỆN CHUYÊN NGHIỆP ---
function renderDashboard(data) {
    console.clear();
    console.log(chalk.yellow("========================================"));
    console.log(chalk.bold.red("   N8 MONITORING (SHIZUKU MODE)   "));
    console.log(chalk.yellow("========================================"));
    console.log(`${chalk.cyan("💰 TỔNG POT:")}      ${chalk.white(data.pot || "---")}`);
    console.log(`${chalk.cyan("⚠️ MỨC THEO:")}      ${chalk.white(data.call || "---")}`);
    console.log(`${chalk.cyan("📊 POT ODDS:")}      ${chalk.magenta(data.potOdds ? data.potOdds + "%" : "---")}`);
    console.log(`${chalk.cyan("🧬 EQUITY (AJ):")}  ${chalk.green((CONFIG.myEquity * 100).toFixed(0) + "%")}`);
    console.log(chalk.yellow("----------------------------------------"));
    
    if (data.decision) {
        const color = data.decision === "CALL" ? chalk.bgGreen : (data.decision === "RAISE" ? chalk.bgYellow : chalk.bgRed);
        console.log(color.black.bold(` >>> QUYẾT ĐỊNH: ${data.decision} <<< `));
    } else {
        console.log(chalk.blue("⏳ ĐANG QUÉT MÀN HÌNH..."));
    }
    console.log(chalk.yellow("========================================"));
}

// Hàm đọc số từ ảnh
async function readNumber(image, region) {
    try {
        const cropped = image.clone().crop(region.x, region.y, region.w, region.h);
        await cropped.greyscale().contrast(1).writeAsync("./temp_ocr.png");
        const text = await tesseract.recognize("./temp_ocr.png", ocrConfig);
        return parseInt(text.replace(/[^0-9]/g, "")) || 0;
    } catch (e) { return 0; }
}

async function startBot() {
    while (true) {
        try {
            // 1. Chụp ảnh màn hình qua Shizuku
            execSync(`${RISH_PATH} -c 'screencap -p ${IMG_PATH}'`);
            
            const image = await Jimp.read(IMG_PATH);
            const potVal = await readNumber(image, CONFIG.regions.pot);
            const callVal = await readNumber(image, CONFIG.regions.callAmt);

            if (potVal > 0 || callVal > 0) {
                const potOdds = ((callVal / (potVal + callVal)) * 100).toFixed(1);
                let decision = "FOLD";

                // Logic quyết định đơn giản
                if (CONFIG.myEquity > (potOdds / 100)) decision = "CALL";
                if (CONFIG.myEquity > 0.75) decision = "RAISE";

                renderDashboard({ pot: potVal, call: callVal, potOdds, decision });

                // Thực thi bấm nút qua Shizuku
                const coords = CONFIG.buttons[decision.toLowerCase()];
                execSync(`${RISH_PATH} -c 'input tap ${coords}'`);
                
                // Nghỉ sau khi thao tác để tránh bị soi
                await new Promise(r => setTimeout(r, 4000));
            } else {
                renderDashboard({ status: "WAITING" });
            }
        } catch (err) {
            console.log(chalk.red("Lỗi kết nối Shizuku hoặc OCR..."));
        }
        await new Promise(r => setTimeout(r, 2000)); // Quét lại sau 2 giây
    }
}

startBot();
