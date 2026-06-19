const fs = require('fs');

fs.writeFile('hello.txt', 'Chào bạn', (err) => {
    if (err) {
        console.error(err);
    } else {
        console.log('File đã được tạo thành công!');
    }
});