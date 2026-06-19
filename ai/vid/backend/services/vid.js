const ffmpeg = require('fluent-ffmpeg');

exports.processVideo = () => {
    ffmpeg('input.mp4')
        .output('output.mp4')
        .on('end', () => console.log('Video created'))
        .run();
};
