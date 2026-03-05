const { execSync } = require("child_process")
const fs = require("fs")
const Tesseract = require("node-tesseract-ocr")

const Jimp = require("jimp").default


const RISH="/data/data/com.termux/files/home/fund/pk/rish"
const SCREEN="/sdcard/poker.png"
const LOCAL="/data/data/com.termux/files/home/fund/pk/poker.png"

function screenshot(){

    try{

        execSync(`RISH_APPLICATION_ID=com.termux ${RISH} -c "screencap -p ${SCREEN}"`)

        execSync(`cp ${SCREEN} ${LOCAL}`)

        console.log("Screenshot OK")

    }catch(e){

        console.log("Shizuku lỗi:",e.message)

    }

}

async function crop(){

    const img=await Jimp.read(LOCAL)

    // vùng pot
    const pot=img.clone().crop(900,250,400,120)
    await pot.writeAsync("pot.png")

    // vùng action
    const action=img.clone().crop(900,700,500,200)
    await action.writeAsync("action.png")

}

async function ocr(file){

    try{

        const text=await Tesseract.recognize(file)

        return text.toLowerCase()

    }catch(e){

        return ""
    }

}

function analyze(text){

    if(text.includes("raise")) return "RAISE"

    if(text.includes("bet")) return "BET"

    if(text.includes("call")) return "CALL"

    if(text.includes("check")) return "CHECK"

    if(text.includes("fold")) return "FOLD"

    return "UNKNOWN"

}

function decision(action,pot,bet){

    if(action==="BET" || action==="RAISE"){

        if(bet < pot*0.3){

            return "CALL"

        }else{

            return "FOLD"

        }

    }

    if(action==="CHECK"){

        return "BET"

    }

    return "WAIT"

}

async function run(){

    try{

        screenshot()

        await crop()

        const actionText=await ocr("action.png")
        const potText=await ocr("pot.png")

        console.log("OCR action:",actionText)
        console.log("OCR pot:",potText)

        const action=analyze(actionText)

        const pot=parseFloat(potText.replace(/[^0-9.]/g,"")) || 0
        const bet=pot*0.2

        const move=decision(action,pot,bet)

        console.log("Action:",action)
        console.log("Bot move:",move)

    }catch(e){

        console.log("BOT lỗi:",e.message)

    }

}

setInterval(run,3000)

console.log("POKER BOT START")
