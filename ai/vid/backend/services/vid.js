const { exec } = require('child_process');
const path = require('path');

module.exports = {
    render: (input, output) => {
        return new Promise((resolve, reject) => {
            // Đây là lệnh ffmpeg thật, sẽ chạy trên server
            const cmd = `ffmpeg -i ${input} -vf "scale=1920:1080" ${output}`;
            exec(cmd, (error, stdout, stderr) => {
                if (error) reject(error);
                resolve(stdout);
            });
        });
    }
};
