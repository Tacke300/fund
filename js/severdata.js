const express = require('express');
const path = require('path');
const db = require('./database.js');
const bcrypt = require('bcrypt');
const cors = require('cors');

const app = express();
const port = 80;

app.use(cors());
app.use(express.json());

const saltRounds = 10;

app.post('/register', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ message: "Username and password are required." });
    }

    bcrypt.hash(password, saltRounds, (err, hash) => {
        if (err) {
            return res.status(500).json({ message: "Error hashing password." });
        }

        const sql = `INSERT INTO users (username, password) VALUES (?, ?)`;
        db.run(sql, [username, hash], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    return res.status(409).json({ message: "Username already exists." });
                }
                return res.status(500).json({ message: "Database error.", error: err.message });
            }
            res.status(201).json({ message: "User registered successfully!", userId: this.lastID });
        });
    });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ message: "Username and password are required." });
    }

    const sql = `SELECT * FROM users WHERE username = ?`;
    db.get(sql, [username], (err, user) => {
        if (err) {
            return res.status(500).json({ message: "Database error." });
        }
        if (!user) {
            return res.status(401).json({ message: "Invalid credentials." });
        }

        bcrypt.compare(password, user.password, (err, result) => {
            if (result) {
                res.status(200).json({ message: "Login successful!" });
            } else {
                res.status(401).json({ message: "Invalid credentials." });
            }
        });
    });
});

app.use(express.static(path.join(__dirname, '..')));
app.use(express.static(path.join(__dirname, '..', 'html')));

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
