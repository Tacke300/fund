module.exports = {
    select: (genre) => {
        const musicMap = {
            "news": "products/background/news.mp3",
            "horror": "products/background/horror.mp3",
            "chill": "products/background/chill.mp3"
        };
        return musicMap[genre] || musicMap["chill"];
    }
};
