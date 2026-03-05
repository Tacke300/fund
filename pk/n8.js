const { execSync } = require("child_process")
const tesseract = require("node-tesseract-ocr")
const Jimp = require("jimp")

const RISH = "/data/data/com.termux/files/home/fund/pk/rish"
const IMG = "/sdcard/poker.png"

const CONFIG = {

  regions: {

    pot: { x:450, y:440, w:150, h:50 },

    call: { x:440, y:940, w:150, h:50 },

    action: { x:300, y:300, w:400, h:100 }

  },

  buttons: {

    fold: "250 950",
    call: "500 950",
    raise: "830 950"

  },

  equity: 0.55

}

const OCR = {

  lang: "eng",
  oem: 1,
  psm: 7

}

function sleep(ms){

  return new Promise(r=>setTimeout(r,ms))

}

async function screenshot(){

  try{

    execSync(`RISH_APPLICATION_ID=com.termux ${RISH} -c "screencap -p ${IMG}"`)

    await sleep(300)

    return true

  }catch(e){

    console.log("Shizuku lỗi:",e.message)

    return false

  }

}

async function readNumber(img,region){

  try{

    const crop = img.clone()
      .crop(region.x,region.y,region.w,region.h)
      .grayscale()
      .contrast(1)
      .normalize()
      .resize(region.w*3,region.h*3)

    const tmp="/sdcard/ocr.png"

    await crop.writeAsync(tmp)

    const text=await tesseract.recognize(tmp,OCR)

    const num=parseInt(text.replace(/[^0-9]/g,""))

    return num||0

  }catch(e){

    return 0

  }

}

async function readAction(img){

  try{

    const r=CONFIG.regions.action

    const crop=img.clone()
      .crop(r.x,r.y,r.w,r.h)
      .grayscale()
      .contrast(1)
      .resize(r.w*2,r.h*2)

    const tmp="/sdcard/ocr_action.png"

    await crop.writeAsync(tmp)

    const text=(await tesseract.recognize(tmp,OCR)).toLowerCase()

    if(text.includes("raise")) return "RAISE"

    if(text.includes("bet")) return "BET"

    if(text.includes("call")) return "CALL"

    if(text.includes("check")) return "CHECK"

    if(text.includes("fold")) return "FOLD"

    return "UNKNOWN"

  }catch(e){

    return "UNKNOWN"

  }

}

function decide(pot,call){

  if(!pot||!call) return "WAIT"

  const odds=call/(pot+call)

  if(CONFIG.equity>0.75) return "RAISE"

  if(CONFIG.equity>odds) return "CALL"

  return "FOLD"

}

function tap(action){

  try{

    const coord=CONFIG.buttons[action.toLowerCase()]

    if(!coord) return

    execSync(`RISH_APPLICATION_ID=com.termux ${RISH} -c "input tap ${coord}"`)

  }catch(e){

    console.log("Tap lỗi")

  }

}

async function start(){

  console.log("POKER BOT START")

  while(true){

    try{

      const ok=await screenshot()

      if(!ok){

        await sleep(3000)

        continue

      }

      const img=await Jimp.read(IMG)

      const pot=await readNumber(img,CONFIG.regions.pot)

      const call=await readNumber(img,CONFIG.regions.call)

      const action=await readAction(img)

      console.log("Pot:",pot)

      console.log("Call:",call)

      console.log("Action:",action)

      const move=decide(pot,call)

      console.log("Bot move:",move)

      if(move!=="WAIT") tap(move)

    }catch(e){

      console.log("BOT lỗi:",e.message)

    }

    await sleep(4000)

  }

}

start()
