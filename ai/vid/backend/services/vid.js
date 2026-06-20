const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const gTTS = require('gtts');
const axios = require('axios');
const kichban = require('./kichban');

if (process.platform === 'win32') {
    ffmpeg.setFfmpegPath('C:\\ffmpeg\\ffmpeg.exe');
}

async function autoGenerateCharacter(charName, description, savePath) {
    try {
        const prompt = `${description}, pencil sketch style, detailed character sheet, white background`;
        const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=768&nologo=true`;
        const response = await axios({ url, method: 'GET', responseType: 'stream' });
        return new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(savePath);
            response.data.pipe(writer);
            writer.on('finish', () => resolve(savePath));
            writer.on('error', reject);
        });
    } catch (err) {
        throw err;
    }
}

module.exports = {
    render: (data, outputName, onProgress) => {
        return new Promise(async (resolve, reject) => {
            const timestamp = Date.now();
            let tempFilesToCleanup = [];
            
            const charName = data.characterName ? data.characterName.trim() : `nv_macdinh_${timestamp}`;
            const charDesc = data.characterPrompt ? data.characterPrompt.trim() : "";
            const charDir = path.join(__dirname, '../../product/characters', charName);
            
            if (!fs.existsSync(charDir)) fs.mkdirSync(charDir, { recursive: true });
            
            const videoDir = path.join(__dirname, '../../product/videos');
            if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
            
            const outputPath = path.join(videoDir, outputName);
            const finalAudioPath = path.join(__dirname, `final_audio_${timestamp}.mp3`);
            const defaultBgPath = path.join(__dirname, '../../product/default_bg.jpg');
            const activeCharacterPath = path.join(charDir, 'avatar.png');
            
            let hasCharacter = false;

            try {
                if (fs.existsSync(activeCharacterPath)) {
                    hasCharacter = true;
                } else if (charDesc !== '') {
                    try {
                        await autoGenerateCharacter(charName, charDesc, activeCharacterPath);
                        hasCharacter = true;
                    } catch (e) {
                        hasCharacter = false;
                    }
                }

                let allDialogues = [];
                try {
                    const scriptStructure = kichban.analyze(data.script || "");
                    if (scriptStructure && scriptStructure.scenes) {
                        scriptStructure.scenes.forEach(scene => {
                            if (scene.dialogues) allDialogues = allDialogues.concat(scene.dialogues);
                        });
                    }
                } catch (err) {}

                if (allDialogues.length === 0) {
                    allDialogues.push({ content: data.script || "Nội dung trống.", pauseAfter: 1.5 });
                }

                const isCloneMode = data.voiceMode === 'clone' && data.uploadedAudioPath && fs.existsSync(data.uploadedAudioPath);

                if (isCloneMode) {
                    fs.copyFileSync(data.uploadedAudioPath, finalAudioPath);
                } else {
                    for (let i = 0; i < allDialogues.length; i++) {
                        const dlg = allDialogues[i];
                        if (!dlg.content || dlg.content.trim() === '') continue;

                        const rawAudioPart = path.join(__dirname, `part_raw_${i}_${timestamp}.mp3`);
                        const paddedAudioPart = path.join(__dirname, `part_pad_${i}_${timestamp}.mp3`);
                        
                        const gtts = new gTTS(dlg.content, 'vi');
                        await new Promise((res, rej) => gtts.save(rawAudioPart, (err) => err ? rej(err) : res()));
                        tempFilesToCleanup.push(rawAudioPart);

                        const pauseSec = dlg.pauseAfter || 1.2;
                        await new Promise((res, rej) => {
                            ffmpeg(rawAudioPart)
                                .outputOptions([`-af apad=pad_len=${Math.floor(pauseSec * 44100)}`])
                                .output(paddedAudioPart).on('end', res).on('error', rej).run();
                        });
                        tempFilesToCleanup.push(paddedAudioPart);
                    }

                    const paddedFiles = tempFilesToCleanup.filter(f => f.includes('part_pad_'));
                    if (paddedFiles.length > 0) {
                        const concatListPath = path.join(__dirname, `list_${timestamp}.txt`);
                        fs.writeFileSync(concatListPath, paddedFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
                        await new Promise((res, rej) => {
                            ffmpeg().input(concatListPath).inputOptions(['-f concat', '-safe 0'])
                                .outputOptions(['-c copy']).output(finalAudioPath)
                                .on('end', res).on('error', rej).run();
                        });
                        fs.unlinkSync(concatListPath);
                    } else {
                        throw new Error("Lỗi TTS");
                    }
                }

                const wStr = parseInt(data.targetWidth || 1280);
                const hStr = parseInt(data.targetHeight || 720);
                const fpsVal = parseInt(data.fps || 30);
                const aBitrate = data.audioBitrate || '320k';

                let videoFilters = [];
                let isSolidBg = !fs.existsSync(defaultBgPath);

                videoFilters.push(`[0:v]scale=${wStr}:${hStr}:force_original_aspect_ratio=increase,crop=${wStr}:${hStr}[bg]`);

                if (hasCharacter) {
                    videoFilters.push(`[1:v]scale=-1:${Math.floor(hStr * 0.9)}[char_scaled]`);
                    videoFilters.push(`[bg][char_scaled]overlay=x='(W-w)/2+sin(t*2)*5':y='(H-h)+sin(t*3)*3'[vout]`);
                } else {
                    videoFilters.push(`[bg]copy[vout]`);
                }

                const cmd = ffmpeg();

                if (isSolidBg) {
                    cmd.input(`color=c=black:s=${wStr}x${hStr}:r=${fpsVal}`).inputFormat('lavfi');
                } else {
                    cmd.input(defaultBgPath).inputOptions(['-loop', '1', '-framerate', `${fpsVal}`]);
                }

                if (hasCharacter) {
                    cmd.input(activeCharacterPath).inputOptions(['-loop', '1', '-framerate', `${fpsVal}`]);
                }

                cmd.input(finalAudioPath);

                let audioMapIndex = hasCharacter ? '2:a' : '1:a';

                cmd.outputOptions([
                    `-map [vout]`, 
                    `-map ${audioMapIndex}`, 
                    '-c:v libx264', 
                    `-r ${fpsVal}`, 
                    '-tune stillimage', 
                    '-pix_fmt yuv420p', 
                    '-c:a aac', 
                    `-b:a ${aBitrate}`, 
                    '-shortest'
                ])
                .complexFilter(videoFilters)
                .output(outputPath)
                .on('progress', (p) => { if (p.percent && typeof onProgress === 'function') onProgress(Math.floor(p.percent)); })
                .on('end', () => {
                    tempFilesToCleanup.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
                    try { fs.unlinkSync(finalAudioPath); } catch (e) {}
                    resolve(outputName);
                })
                .on('error', (err) => {
                    tempFilesToCleanup.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
                    try { fs.unlinkSync(finalAudioPath); } catch (e) {}
                    reject(err);
                })
                .run();

            } catch (err) {
                tempFilesToCleanup.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
                try { fs.unlinkSync(finalAudioPath); } catch (e) {}
                reject(err);
            }
        });
    }
};
