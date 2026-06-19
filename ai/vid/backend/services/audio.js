const gTTS = require('gtts');
const path = require('path');
const fs = require('fs');

module.exports = {
    taoFile: (text, voiceLang = 'vi') => {
        return new Promise((resolve, reject) => {
            const fileName = `audio_${Date.now()}.mp3`;
            const dir = path.join(__dirname, '../../products/audio');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            
            const gtts = new gTTS(text, voiceLang);
            gtts.save(path.join(dir, fileName), (err) => {
                if (err) reject(err);
                else resolve(fileName);
            });
        });
    }
};
