process.env.RISH_APPLICATION_ID = "com.termux";

const { execSync } = require('child_process');
const tesseract = require("node-tesseract-ocr");
const Jimp = require("jimp");
const chalk = require("chalk");

// ===== ĐƯỜNG DẪN =====
const RISH_PATH = "/data/data/com.termux/files/home/fund/pk/rish";
const IMG_PATH = "/data/data/com.termux/files/home/poker.png";

const CONFIG = {
    regions: {
        pot: { x: 450, y: 440, w: 120, h: 40 },
        callAmt: { x: 440, y: 940, w: 130, h: 40 }
    },

    buttons: {
        fold: "250 950",
        call: "500 950",
        raise: "830 950"
    },

    myEquity: 0.55
};

const ocrConfig = {
    lang: "eng",
    oem: 1,
    psm: 7
};

// ===== DASHBOARD =====

function renderDashboard(data) {

    console.clear();

    console.log(chalk.yellow("========================================"));
    console.log(chalk.bold.red("   N8 MONITORING (SHIZUKU MODE)   "));
    console.log(chalk.yellow("========================================"));

    console.log(`${chalk.cyan("💰 POT:")}        ${chalk.white(data.pot || "---")}`);
    console.log(`${chalk.cyan("⚠️ CALL:")}       ${chalk.white(data.call || "---")}`);
    console.log(`${chalk.cyan("📊 POT ODDS:")}   ${chalk.magenta(data.potOdds ? data.potOdds + "%" : "---")}`);
    console.log(`${chalk.cyan("🧬 EQUITY:")}     ${chalk.green((CONFIG.myEquity * 100).toFixed(0) + "%")}`);

    console.log(chalk.yellow("----------------------------------------"));

    if (data.decision) {

        const color =
            data.decision === "CALL"
                ? chalk.bgGreen
                : data.decision === "RAISE"
                ? chalk.bgYellow
                : chalk.bgRed;

        console.log(color.black.bold(` >>> ${data.decision} <<< `));

    } else {

        console.log(chalk.blue("Scanning screen..."));

    }

    console.log(chalk.yellow("========================================"));
}

// ===== OCR =====

async function readNumber(image, region) {

    try {

        const cropped = image.clone().crop(region.x, region.y, region.w, region.h);

        await cropped
            .greyscale()
            .contrast(1)
            .writeAsync("temp.png");

        const text = await tesseract.recognize("temp.png", ocrConfig);

        return parseInt(text.replace(/[^0-9]/g, "")) || 0;

    } catch {

        return 0;

    }

}

// ===== CHỤP MÀN HÌNH =====

function captureScreen() {

    try {

        execSync(`${RISH_PATH} -c "screencap -p ${IMG_PATH}"`);

    } catch {

        console.log("Shizuku screencap lỗi");

    }

}

// ===== TAP =====

function tap(coords) {

    try {

        execSync(`${RISH_PATH} -c "input tap ${coords}"`);

    } catch {

        console.log("Tap lỗi");

    }

}

// ===== BOT =====

async function startBot() {

    while (true) {

        try {

            captureScreen();

            const image = await Jimp.read(IMG_PATH);

            const potVal = await readNumber(image, CONFIG.regions.pot);
            const callVal = await readNumber(image, CONFIG.regions.callAmt);

            if (potVal > 0 || callVal > 0) {

                const potOdds = ((callVal / (potVal + callVal)) * 100).toFixed(1);

                let decision = "FOLD";

                if (CONFIG.myEquity > (potOdds / 100))
                    decision = "CALL";

                if (CONFIG.myEquity > 0.75)
                    decision = "RAISE";

                renderDashboard({
                    pot: potVal,
                    call: callVal,
                    potOdds,
                    decision
                });

                tap(CONFIG.buttons[decision.toLowerCase()]);

                await new Promise(r => setTimeout(r, 4000));

            } else {

                renderDashboard({});

            }

        } catch (err) {

            console.log(chalk.red("Bot lỗi:"), err.message);

        }

        await new Promise(r => setTimeout(r, 2000));

    }

}

startBot();
