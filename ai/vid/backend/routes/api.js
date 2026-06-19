const express = require('express');
const router = express.Router();
const kichBanService = require('../services/kichban');

// API Phân tích kịch bản truyện chữ
router.post('/analyze-script', (req, res) => {
    try {
        const { script } = req.body;
        const result = kichBanService.analyze(script);
        
        return res.json({
            status: 'Success',
            data: result
        });
    } catch (err) {
        return res.status(500).json({
            status: 'Error',
            error: err.message
        });
    }
});

module.exports = router;
