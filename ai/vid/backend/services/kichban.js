const fs = require('fs');
const path = require('path');

module.exports = {
    /**
     * Hàm phân tích văn bản thô thành cấu trúc kịch bản đọc truyện nâng cao
     * @param {string} rawText Văn bản đầu vào từ phía người dùng nhập trên giao diện
     * @returns {Object} Đối tượng kịch bản đã được phân tích chi tiết
     */
    analyze: (rawText) => {
        if (!rawText || typeof rawText !== 'string') {
            throw new Error("Văn bản đầu vào không hợp lệ.");
        }

        // Làm sạch văn bản ban đầu
        const cleanInput = rawText.replace(/Style\s*=\s*.*?\n/gi, '').trim();
        
        // 1. XÁC ĐỊNH THỂ LOẠI (Dựa trên mật độ từ khóa đặc trưng)
        const genre = determineGenre(cleanInput);

        // 2. XÁC ĐỊNH NHÂN VẬT XUẤT HIỆN
        const characters = extractCharacters(cleanInput);

        // 3. CHIA SCENE & PHÂN TÍCH LỜI THOẠI CHI TIẾT (NGẮT NGHỈ, CẢM XÚC)
        // Bẻ văn bản thành các đoạn lớn dựa trên dấu xuống dòng để làm Scene
        const rawParagraphs = cleanInput.split(/\n+/).map(p => p.trim()).filter(p => p.length > 0);
        const scenes = [];
        let sceneCounter = 1;

        for (const paragraph of rawParagraphs) {
            // Tách đoạn văn thành các câu hoặc phân đoạn nhỏ dựa trên dấu ngắt câu để xử lý giọng đọc
            const subSegments = splitIntoSpeechSegments(paragraph);
            const dialogueLines = [];
            let totalSceneDuration = 0;

            for (const segment of subSegments) {
                if (segment.text.trim().length === 0) continue;

                // Phân tích người nói (Nhân vật nói hay Người dẫn chuyện)
                const speakerAnalysis = parseSpeaker(segment.text, characters);
                
                // Phân tích trạng thái cảm xúc cho phân đoạn này
                const emotion = detectEmotion(speakerAnalysis.content, genre);

                // Tính toán thời gian đọc (trung bình 3 chữ/giây) + thời gian ngắt nghỉ lý thuyết
                const wordCount = speakerAnalysis.content.split(/\s+/).length;
                const readingTime = Math.ceil(wordCount / 3); 
                const pauseTime = determinePause(segment.punctuation);
                const estimatedDuration = readingTime + pauseTime;
                totalSceneDuration += estimatedDuration;

                dialogueLines.push({
                    speaker: speakerAnalysis.speaker,
                    content: speakerAnalysis.content,
                    emotion: emotion,
                    speed: determineSpeed(emotion),
                    pauseAfter: pauseTime, // Thời gian nghỉ sau câu (giây) để nạp vào AI Voice
                    guide: `Đọc với giọng ${emotion}, ngắt ${pauseTime}s ở cuối phân đoạn.`
                });
            }

            if (dialogueLines.length > 0) {
                scenes.push({
                    sceneId: `Scene ${sceneCounter}`,
                    title: dialogueLines[0].content.substring(0, 30) + "...",
                    description: `Phân đoạn diễn biến thứ ${sceneCounter} của mạch truyện.`,
                    location: determineContext(paragraph, genre),
                    estimatedDuration: `${totalSceneDuration}s`,
                    dialogues: dialogueLines
                });
                sceneCounter++;
            }
        }

        // Trả ra cấu trúc cây kịch bản hoàn chỉnh
        return {
            metadata: {
                totalScenes: scenes.length,
                detectedGenre: genre,
                generatedAt: new Date().toISOString()
            },
            characters: characters,
            scenes: scenes
        };
    }
};

// ====================================================================
// HÀM BỔ TRỢ XỬ LÝ LOGIC NGÔN NGỮ (INTERNAL HELPERS)
// ====================================================================

/**
 * Phân tích thể loại bài viết dựa trên từ khóa cốt lõi
 */
function determineGenre(text) {
    const lower = text.toLowerCase();
    if (lower.includes("bóng ma") || lower.includes("kinh dị") || lower.includes("âm ti") || lower.includes("rùng rợn")) return "Kinh dị";
    if (lower.includes("giết") || lower.includes("súng") || lower.includes("đuổi theo") || lower.includes("chạy trốn")) return "Hành động";
    if (lower.includes("yêu") || lower.includes("nước mắt") || lower.includes("hẹn hò") || lower.includes("kết hôn")) return "Tình cảm";
    if (lower.includes("hài hước") || lower.includes("gắt") || lower.includes("cười")) return "Hài hước";
    if (lower.includes("ngày xửa ngày xưa") || lower.includes("hoàng tử") || lower.includes("công chúa")) return "Cổ tích";
    if (lower.includes("kính thưa quý vị") || lower.includes("bản tin") || lower.includes("thời sự")) return "Tin tức";
    if (lower.includes("sản phẩm") || lower.includes("mới nhất") || lower.includes("giá rẻ")) return "Quảng cáo";
    return "Truyện ngắn"; // Mặc định
}

/**
 * Trích xuất tự động danh sách nhân vật dựa trên cấu trúc Viết Hoa hoặc dấu hai chấm
 */
function extractCharacters(text) {
    const characters = [];
    const lines = text.split('\n');
    const defaultList = ["Minh", "Lan", "Nam", "Vy", "Phong", "Linh"]; // Bộ từ điển quét nhanh

    // Quét tìm dạng "Tên:"
    lines.forEach(line => {
        const match = line.match(/^([A-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚĂĐĨŨƠƯĂÂÊÔƠƯỨỨỰ\s]{2,15}):/);
        if (match) {
            const name = match[1].trim();
            if (!characters.some(c => c.name === name)) {
                characters.push({ name: name, gender: "Chưa rõ", age: "Ước lượng 20-30", role: "Nhân vật xuất hiện", personality: "Theo diễn biến" });
            }
        }
    });

    // Quét dự phòng theo từ điển mẫu nếu không có dấu hai chấm trực diện
    defaultList.forEach(name => {
        if (text.includes(name) && !characters.some(c => c.name === name)) {
            let guessedGender = ["Lan", "Vy", "Linh"].includes(name) ? "Nữ" : "Nam";
            characters.push({
                name: name,
                gender: guessedGender,
                age: "25 tuổi",
                role: "Nhân vật chính",
                personality: "Tò mò, biến thiên theo mạch truyện"
            });
        }
    });

    // Nếu trống rỗng thì chỉ có người dẫn chuyện
    if (characters.length === 0) {
        characters.push({ name: "Dẫn chuyện", gender: "Trung tính", age: "Không tuổi", role: "Người kể chuyện", personality: "Khách quan" });
    }

    return characters;
}

/**
 * Cắt nhỏ đoạn văn thành các phân đoạn nói dựa trên dấu câu để ép AI Voice nghỉ
 */
function splitIntoSpeechSegments(paragraph) {
    // Tách bằng regex giữ lại các dấu ngắt câu quan trọng: ., ?, !, ..., ,, ;
    const tokens = paragraph.split(/([.\!?…;]+)/g);
    const segments = [];
    
    for (let i = 0; i < tokens.length; i += 2) {
        const text = tokens[i] ? tokens[i].trim() : '';
        const punctuation = tokens[i + 1] ? tokens[i + 1].trim() : '.';
        if (text.length > 0) {
            segments.push({ text: text, punctuation: punctuation });
        }
    }
    return segments;
}

/**
 * Phân tích dòng text xem thuộc về nhân vật nào hay là lời dẫn chuyện
 */
function parseSpeaker(text, characters) {
    const match = text.match(/^([^:]+):\s*(.*)$/);
    if (match) {
        return { speaker: match[1].trim(), content: match[2].trim() };
    }
    
    // Tìm xem trong câu có chứa tên nhân vật nào không để gán ngữ cảnh dữ liệu
    for (const char of characters) {
        if (text.startsWith(char.name)) {
            return { speaker: char.name, content: text };
        }
    }
    return { speaker: "Dẫn chuyện", content: text };
}

/**
 * Bộ lọc Heuristic nhận diện cảm xúc dựa trên từ ngữ biểu đạt tiếng Việt
 */
function detectEmotion(text, genre) {
    const lower = text.toLowerCase();
    
    if (lower.includes("bất ngờ") || lower.includes("sao lại") || lower.includes("kỳ lạ") || lower.includes("gì thế")) return "Ngạc nhiên";
    if (lower.includes("sợ") || lower.includes("hoảng hốt") || lower.includes("run rẩy") || lower.includes("nguy hiểm")) return "Sự hãi";
    if (lower.includes("khóc") || lower.includes("đau lòng") || lower.includes("tiếc nuối") || lower.includes("mất đi")) return "Buồn";
    if (lower.includes("tức giận") || lower.includes("khốn kiếp") || lower.includes("đập phá") || lower.includes("đáng chết")) return "Tức giận";
    if (lower.includes("tuyệt vời") || lower.includes("vui") || lower.includes("ha ha") || lower.includes("may mắn")) return "Vui vẻ";
    if (lower.includes("tìm kiếm") || lower.includes("bí mật") || lower.includes("tò mò") || lower.includes("khám phá")) return "Tò mò";
    if (lower.includes("hồi hộp") || lower.includes("tim đập") || lower.includes("nín thở")) return "Hồi hộp";
    if (lower.includes("lo lắng") || lower.includes("làm sao đây") || lower.includes("bồn chồn")) return "Lo lắng";

    // Trả về cảm xúc nền theo thể loại nếu không dính từ khóa đặc biệt
    if (genre === "Kinh dị") return "Bí ẩn";
    if (genre === "Hành động") return "Kịch tính";
    if (genre === "Tin tức") return "Tin tức";
    if (genre === "Quảng cáo") return "Quảng cáo";
    
    return "Bình thường";
}

/**
 * Xác định tốc độ đọc cho AI Voice căn cứ vào trạng thái cảm xúc
 */
function determineSpeed(emotion) {
    if (["Sợ hãi", "Hồi hộp", "Tức giận", "Kịch tính"].includes(emotion)) return "Nhanh";
    if (["Buồn", "Bí ẩn", "Kinh dị"].includes(emotion)) return "Chậm / Sâu";
    return "Vừa phải";
}

/**
 * Định hình thời gian ngắt nghỉ (giây) dựa trên dấu câu phân mảnh
 */
function determinePause(punctuation) {
    if (punctuation.includes('…') || punctuation.includes('...')) return 2.0; // Nghỉ dài tạo sự tò mò, kịch tính
    if (punctuation.includes('!') || punctuation.includes('?')) return 1.5;   // Nghỉ để nhấn mạnh cảm xúc câu hỏi/câu cảm thán
    if (punctuation.includes('.')) return 1.2;                                 // Hết câu nghỉ chuẩn
    if (punctuation.includes(',')) return 0.5;                                 // Ngắt giữa câu nghỉ ngắn lấy hơi
    return 1.0;
}

/**
 * Nhận diện bối cảnh không gian dựa trên từ khóa địa điểm
 */
function determineContext(text, genre) {
    const lower = text.toLowerCase();
    if (lower.includes("nhà") || lower.includes("phòng")) return "Trong nhà";
    if (lower.includes("rừng") || lower.includes("cây") || lower.includes("đường")) return "Ngoài trời / Tự nhiên";
    if (lower.includes("trường") || lower.includes("lớp")) return "Trường học";
    if (genre === "Kinh dị") return "Không gian u tối, biệt lập";
    return "Bối cảnh mặc định";
}
