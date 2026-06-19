const fs = require('fs');
const path = require('path');

module.exports = {
    create: async (data) => {
        const fileName = `voice_${Date.now()}.mp3`;
        const filePath = path.join('products', 'audio', fileName);
        // Logic gọi TTS (Piper/Coqui) ở đây
        fs.writeFileSync(filePath, "mock_audio_data");
        return { file: filePath, status: "created" };
    }
};
