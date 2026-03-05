process.env.RISH_APPLICATION_ID = "com.termux";

const { execSync } = require("child_process");
const tesseract = require("node-tesseract-ocr");
const Jimp = require("jimp");
const chalk = require("chalk");

// ===== PATH =====
const RISH_PATH = "/data/data/com.termux/files/home/fund/pk/rish";
const IMG_PATH = "/data/data/com.termux/files/home/poker.png";

// ===== CONFIG =====
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

  console.log(chalk.yellow("================================"));
  console.log(chalk.red.bold("      N8 SHIZUKU BOT"));
  console.log(chalk.yellow("================================"));

  console.log("POT:", data.pot || "---");
  console.log("CALL:", data.call || "---");
  console.log("POT ODDS:", data.potOdds || "---");
  console.log("EQUITY:", (CONFIG.myEquity * 100).toFixed(0) + "%");

  console.log("--------------------------------");

  if (data.decision)
    console.log("DECISION:", data.decision);
  else
    console.log("Scanning...");

  console.log("================================");
}

// ===== OCR =====
async function readNumber(image, region) {

  try {

    const crop = image.clone().crop(region.x, region.y, region.w, region.h);

    await crop
      .greyscale()
      .contrast(1)
      .writeAsync("temp.png");

    const text = await tesseract.recognize("temp.png", ocrConfig);

    return parseInt(text.replace(/[^0-9]/g, "")) || 0;

  } catch (e) {

    console.log("OCR lỗi:", e.message);
    return 0;

  }
}

// ===== SCREENSHOT =====
function captureScreen() {

  try {

    execSync(`${RISH_PATH} -c "screencap -p ${IMG_PATH}"`);

  } catch (e) {

    console.log("Shizuku lỗi:", e.message);

  }

}

// ===== TAP =====
function tap(coords) {

  try {

    execSync(`${RISH_PATH} -c "input tap ${coords}"`);

  } catch (e) {

    console.log("Tap lỗi:", e.message);

  }

}

// ===== BOT LOOP =====
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

        if (CONFIG.myEquity > potOdds / 100)
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

      console.log("BOT lỗi:", err.message);

    }

    await new Promise(r => setTimeout(r, 2000));

  }

}

startBot();
