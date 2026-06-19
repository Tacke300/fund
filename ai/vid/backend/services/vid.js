const ffmpeg = require('fluent-ffmpeg');
const path = require('path');

module.exports = {
    render: (audioFile, outputName, watermark, onProgress) => {
        return new Promise((resolve, reject) => {
            const inputVideo = path.join(__dirname, '../../input.mp4'); // BẮT BUỘC CÓ FILE NÀY
            const outputPath = path.join(__dirname, '../../products/videos', outputName);
            
            ffmpeg(inputVideo)
                .input(path.join(__dirname, '../../products/audio', audioFile))
                .videoFilters(`drawtext=text='${watermark}':x=w-tw-10:y=h-th-10:fontsize=24:fontcolor=white`)
                .output(outputPath)
                .on('progress', (p) => onProgress(p.percent))
                .on('end', () => resolve(outputPath))
                .on('error', (err) => reject(err))
                .run();
        });
    }
};
