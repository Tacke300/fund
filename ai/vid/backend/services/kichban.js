module.exports = {
    parse: async (text) => {
        // Giả lập phân tích kịch bản
        const lines = text.split('\n');
        return {
            scenes: lines.map((line, i) => ({
                id: i + 1,
                title: `Scene ${i + 1}`,
                content: line,
                prompt: "Cinematic shot, 4k",
                duration: 5,
                voice: "narrator"
            }))
        };
    }
};
