const { exec } = require('child_process');
const path = require('path');

module.exports = {
    generateScene: async (data) => {
        return { status: "generated", file: `products/images/scene_${Date.now()}.png` };
    },
    renderFinal: async (data) => {
        const output = `products/videos/final_${Date.now()}.mp4`;
        // Logic gọi FFmpeg
        return { status: "success", output };
    }
};
