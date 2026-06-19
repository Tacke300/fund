const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer'); // Thư viện xử lý dữ liệu form-data chứa file
const { exec } = require('child_process');

const vidService = require('./services/vid');
const kichbanService = require('./services/kichban');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cấu hình lưu trữ tệp tin tạm thời khi upload lên máy chủ
const upload = multer({ dest: path.join(__dirname, 'temp_uploads/') });

const productDir = path.join(__dirname, '../product');
const videoDir = path.join(productDir, 'videos');
const dbPath = path.join(__dirname, 'database.json');

if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, JSON.stringify({ videos: [] }, null, 2));

app.use('/product', express.static(productDir));
app.use(express.static(path.join(__dirname, '../frontend')));

let renderLogs = "Hệ thống sẵn sàng...";

const readDB = () => JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const writeDB = (data) => fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');

// API NHẬN YÊU CẦU PHÂN TÍCH CHỮ
app.post('/api/analyze', (req, res) => {
    try {
        const { script } = req.body;
        if (!script) return res.status(400).json({ status: 'Error', error: "Trống kịch bản" });
        const result = kichbanService.analyze(script);
        return res.json({ status: 'Success', data: result });
    } catch (err) {
        return res.status(500).json({ status: 'Error', error: err.message });
    }
});

// FIX TRIỆT ĐỂ LỖI BẰNG ĐƯỜNG TRUYỀN MULTIPART/FORM-DATA
app.post('/api/render', upload.fields([
    { name: 'audioSample', maxCount: 1 }, 
    { name: 'images', maxCount: 100 }
]), async (req, res) => {
    
    // Đọc các trường dữ liệu chữ trong form
    const bodyData = req.body;
    const outputName = `video_${Date.now()}.mp4`;
    renderLogs = `[${new Date().toLocaleTimeString()}] Nhận gói dữ liệu Form-data đa tầng từ client...\n`;

    if (!bodyData.script) {
        return res.status(400).json({ status: 'Error', error: "Văn bản đầu vào không hợp lệ hoặc rỗng." });
    }

    // 1. TÍNH TOÁN KÍCH THƯỚC KHUNG HÌNH (ĐÃ KHÔI PHỤC)
    const ratioData = bodyData.aspectRatio || '16:9-720';
    const [ratio, resTarget] = ratioData.split('-');
    let w = 1280, h = 720;
    if (ratio === '16:9') {
        w = resTarget === '1080' ? 1920 : 1280;
        h = resTarget === '1080' ? 1080 : 720;
    } else if (ratio === '9:16') {
        w = resTarget === '1080' ? 1080 : 720;
        h = resTarget === '1080' ? 1920 : 1280;
    } else if (ratio === '1:1') {
        w = 1080; h = 1080;
    }

    // Tổ chức lại object dữ liệu chuẩn để nạp vào tầng xử lý video dịch vụ
    const cleanRenderParams = {
        script: bodyData.script,
        targetWidth: w,
        targetHeight: h,
        fps: bodyData.fps || 30,
        audioBitrate: bodyData.audioBitrate || '320k',
        watermark: bodyData.watermark || '',
        wmOpacity: bodyData.wmOpacity || '0.15',
        voiceMode: bodyData.voiceMode || 'standard',
        uploadedAudioPath: null,
        uploadedImages: []
    };

    // 2. TRÍCH XUẤT AUDIO PHỤC VỤ CHỨC NĂNG FAKE GIỌNG (CLONE VOICE)
    if (req.files && req.files['audioSample']) {
        const audioFile = req.files['audioSample'][0];
        cleanRenderParams.uploadedAudioPath = audioFile.path; // Đường dẫn file audio tạm trên ổ cứng
        renderLogs += `[Voice Clone] Đã nhận diện được tệp âm thanh mẫu để clone giọng.\n`;
    }

    // 3. TRÍCH XUẤT DANH SÁCH ẢNH & NOTE TỪNG ẢNH ĐI KÈM
    if (req.files && req.files['images']) {
        const uploadedFiles = req.files['images'];
        // Ghi chú dạng mảng hoặc chuỗi đơn tùy thuộc số lượng ảnh gửi lên
        const rawNotes = bodyData.imageNotes;
        const notesArray = Array.isArray(rawNotes) ? rawNotes : [rawNotes];

        uploadedFiles.forEach((file, index) => {
            cleanRenderParams.uploadedImages.push({
                filePath: file.path,
                note: notesArray[index] || ""
            });
        });
        renderLogs += `[Image Manager] Đã nhận thành công ${cleanRenderParams.uploadedImages.length} ảnh bối cảnh minh họa.\n`;
    }

    try {
        // Gửi toàn bộ cấu trúc tham số sạch xuống Core dịch vụ FFmpeg thực thi
        await vidService.render(cleanRenderParams, outputName, (percent) => {
            renderLogs = `[${new Date().toLocaleTimeString()}] Đang dựng hình ảnh bối cảnh & Fake giọng đọc... Tiến độ: ${percent}%\n`;
        });

        // Dọn dẹp tệp tin tạm thời trên ổ đĩa sau khi render thành công
        if (cleanRenderParams.uploadedAudioPath && fs.existsSync(cleanRenderParams.uploadedAudioPath)) fs.unlinkSync(cleanRenderParams.uploadedAudioPath);
        cleanRenderParams.uploadedImages.forEach(img => { if (fs.existsSync(img.filePath)) fs.unlinkSync(img.filePath); });

        // Lưu thông tin database tránh mất dữ liệu khi người dùng ấn F5
        const db = readDB();
        db.videos.push({ fileName: outputName, title: bodyData.script.substring(0, 30) });
        writeDB(db);

        renderLogs += `[Thành công] Video chất lượng lớn đã xuất bản hoàn tất.\n`;
        autoGitPush(`Auto-render: ${outputName} kèm Fake Giọng và Ảnh Minh họa`);

        return res.json({
            status: 'Success',
            videoUrl: `/product/videos/${outputName}`,
            fileName: outputName
        });
    } catch (error) {
        // Dọn dẹp tệp tin tạm thời kể cả khi gặp lỗi để tránh đầy ổ cứng
        if (cleanRenderParams.uploadedAudioPath && fs.existsSync(cleanRenderParams.uploadedAudioPath)) fs.unlinkSync(cleanRenderParams.uploadedAudioPath);
        cleanRenderParams.uploadedImages.forEach(img => { if (fs.existsSync(img.filePath)) fs.unlinkSync(img.filePath); });

        renderLogs += `[Engine Lỗi]: ${error.message}\n`;
        return res.status(500).json({ status: 'Error', error: error.message });
    }
});

app.get('/api/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    return res.send(renderLogs);
});

function autoGitPush(msg) {
    const rootDir = path.join(__dirname, '../../');
    exec(`git add . && git commit -m "${msg}" && git push`, { cwd: rootDir }, (err) => {
        if (!err) renderLogs += `[Git System] Toàn bộ mã nguồn, database và video đã đồng bộ backup thành công lên GitHub.\n`;
    });
}

app.listen(PORT, () => {
    console.log(`🚀 Engine Server đang chạy mượt mà tại cổng: ${PORT}`);
});
