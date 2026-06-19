module.exports = {
    // Tách kịch bản thành mảng các đoạn
    xuLy: (script) => {
        return script.split('\n').filter(s => s.trim() !== '');
    }
};
