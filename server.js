require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const app = express();

/* ======================
   MIDDLEWARE - ВАЖНО: ВСЕ В НАЧАЛЕ
====================== */
// CORS с правильными настройками
app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With']
}));

// Парсинг JSON и URL-encoded - ДОЛЖНО БЫТЬ ПЕРЕД МАРШРУТАМИ
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Логирование всех запросов для отладки
app.use((req, res, next) => {
    console.log(`📥 ${req.method} ${req.path}`);
    if (req.method === 'POST' || req.method === 'PUT') {
        console.log('Body:', req.body);
    }
    next();
});

/* ======================
   MONGO CONNECT
====================== */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err));


/* ======================
   MODELS
====================== */
// Admin
const adminSchema = new mongoose.Schema({
    login: { type: String, unique: true, required: true },
    password: { type: String, required: true },
});
const Admin = mongoose.model("Admin", adminSchema);

// APK Schema с versionCode
const apkSchema = new mongoose.Schema({
    title: String,
    description: {
        type: String,
        required: true
    },
    version: {
        type: String, // для отображения "1.0.3"
        required: false
    },
    versionCode: {
        type: Number, // для сравнения 103
        required: true
    },
    apkUrl: String,
    iconUrl: String,
    apkKey: String,
    iconKey: String,
    packageName: {
        type: String,
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
});

const Apk = mongoose.model("Apk", apkSchema);

/* ======================
   R2 (Cloud Storage) CONFIG
====================== */
const r2 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY,
        secretAccessKey: process.env.R2_SECRET_KEY,
    },
});

/* ======================
   MULTER (для загрузки файлов)
====================== */
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 300 * 1024 * 1024 } // лимит 300MB
});

/* ======================
   AUTH MIDDLEWARE
====================== */
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        console.log("❌ No token provided");
        return res.status(401).json({ error: "No token" });
    }

    const token = authHeader.split(" ")[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.adminId = decoded.adminId;
        console.log("✅ Token verified for admin:", req.adminId);
        next();
    } catch (err) {
        console.log("❌ Invalid token:", err.message);
        return res.status(401).json({ error: "Invalid token" });
    }
}

/* ======================
   HEALTH CHECK - для проверки работы сервера
====================== */
app.get("/", (req, res) => {
    res.json({ status: "ok", message: "Server is running" });
});

app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date() });
});

/* ======================
   LOGIN ROUTE - ИСПРАВЛЕН
====================== */
app.post("/login", async (req, res) => {
    console.log("🔐 LOGIN ATTEMPT");
    console.log("Request body:", req.body);
    console.log("Content-Type:", req.headers['content-type']);
    
    try {
        const { login, password } = req.body;
        
        // Проверка наличия полей
        if (!login || !password) {
            console.log("❌ Missing login or password");
            return res.status(400).json({ error: "Login and password are required" });
        }

        // Поиск админа
        const admin = await Admin.findOne({ login });
        if (!admin) {
            console.log("❌ Admin not found:", login);
            return res.status(401).json({ error: "Invalid credentials" });
        }
        console.log("✅ Admin found:", admin.login);

        // Проверка пароля
        const validPassword = await bcrypt.compare(password, admin.password);
        if (!validPassword) {
            console.log("❌ Invalid password for:", login);
            return res.status(401).json({ error: "Invalid credentials" });
        }
        console.log("✅ Password valid");

        // Создание токена
        const token = jwt.sign(
            { adminId: admin._id }, 
            process.env.JWT_SECRET, 
            { expiresIn: "24h" }
        );
        
        console.log("✅ Login successful for:", login);
        res.json({ 
            token,
            message: "Login successful"
        });

    } catch (err) {
        console.error("❌ Login error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/* ======================
   DEBUG ROUTE - ТОЛЬКО ДЛЯ ОТЛАДКИ, УДАЛИТЬ ПОТОМ
====================== */
app.get("/debug/admins", async (req, res) => {
    try {
        const admins = await Admin.find({}, { password: 0 });
        res.json({ 
            count: admins.length, 
            admins,
            dbStatus: mongoose.connection.readyState === 1 ? "connected" : "disconnected"
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ======================
   APK ROUTES
====================== */
// GET all APKs (public)
app.get("/apks", async (req, res) => {
    try {
        const apks = await Apk.find().sort({ createdAt: -1 });
        res.json(apks);
    } catch (err) {
        console.error("❌ Error fetching APKs:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// GET single APK by ID (public)
app.get("/apks/:id", async (req, res) => {
    try {
        const apk = await Apk.findById(req.params.id);
        if (!apk) {
            return res.status(404).json({ error: "APK not found" });
        }
        res.json(apk);
    } catch (err) {
        console.error("❌ Error fetching APK:", err);
        res.status(500).json({ error: "Server error" });
    }
});

// UPLOAD APK (protected)
app.post(
    "/apks",
    authMiddleware,
    upload.fields([
        { name: "apk", maxCount: 1 },
        { name: "icon", maxCount: 1 },
    ]),
    async (req, res) => {
        try {
            console.log("📦 Uploading APK...");

            const {
                title,
                packageName,
                description,
                version // 👈 необязательное
            } = req.body;

            // --------------------
            // ВАЛИДАЦИЯ
            // --------------------
            if (!packageName) {
                return res.status(400).json({ error: "packageName is required" });
            }

            if (!description) {
                return res.status(400).json({ error: "description is required" });
            }

            const apkFile = req.files?.apk?.[0];
            const iconFile = req.files?.icon?.[0];

            if (!apkFile) {
                return res.status(400).json({ error: "APK file is required" });
            }

            // --------------------
            // ЗАГРУЗКА APK В R2
            // --------------------
            const apkKey = `apks/${Date.now()}-${apkFile.originalname.replace(/[^a-zA-Z0-9.-]/g, "_")}`;

            await r2.send(
                new PutObjectCommand({
                    Bucket: process.env.R2_BUCKET,
                    Key: apkKey,
                    Body: apkFile.buffer,
                    ContentType: apkFile.mimetype,
                })
            );

            const apkUrl = `${process.env.R2_PUBLIC_URL}/${encodeURIComponent(apkKey)}`;
            console.log("✅ APK uploaded:", apkKey);

            // --------------------
            // ЗАГРУЗКА ИКОНКИ (ЕСЛИ ЕСТЬ)
            // --------------------
            let iconUrl = null;
            let iconKey = null;

            if (iconFile) {
                iconKey = `icons/${Date.now()}-${iconFile.originalname.replace(/[^a-zA-Z0-9.-]/g, "_")}`;

                await r2.send(
                    new PutObjectCommand({
                        Bucket: process.env.R2_BUCKET,
                        Key: iconKey,
                        Body: iconFile.buffer,
                        ContentType: iconFile.mimetype,
                    })
                );

                iconUrl = `${process.env.R2_PUBLIC_URL}/${encodeURIComponent(iconKey)}`;
                console.log("✅ Icon uploaded:", iconKey);
            }

            // --------------------
            // СОХРАНЕНИЕ В БД
            // --------------------
            const newApk = await Apk.create({
                title: title || apkFile.originalname,
                description,              // 👈 обязательно
                version: version || null, // 👈 необязательно
                packageName,
                apkUrl,
                iconUrl,
                apkKey,
                iconKey,
            });

            console.log("✅ APK saved to DB:", newApk._id);

            res.status(201).json(newApk);

        } catch (err) {
            console.error("❌ Upload error:", err);
            res.status(500).json({
                error: "Upload failed",
                details: err.message,
            });
        }
    }
);

// UPDATE APK (protected) - НОВЫЙ PUT МЕТОД
app.put(
    "/apks/:id",
    authMiddleware,
    upload.fields([
        { name: "apk", maxCount: 1 },
        { name: "icon", maxCount: 1 },
    ]),
    async (req, res) => {
        try {
            console.log("📝 Updating APK:", req.params.id);

            const {
                title,
                packageName,
                description,
                version,
                versionCode // 👈 Добавь это поле
            } = req.body;

            const existingApk = await Apk.findById(req.params.id);
            if (!existingApk) {
                return res.status(404).json({ error: "APK not found" });
            }

            const updateData = {
                title: title || existingApk.title,
                packageName: packageName || existingApk.packageName,
                description: description || existingApk.description,
                version: version || existingApk.version,
                versionCode: versionCode !== undefined ? parseInt(versionCode) : existingApk.versionCode,
            };

            

            const apkFile = req.files?.apk?.[0];
            const iconFile = req.files?.icon?.[0];

            // --------------------
            // ОБНОВЛЕНИЕ APK ФАЙЛА (ЕСЛИ ЗАГРУЖЕН НОВЫЙ)
            // --------------------
            if (apkFile) {
                console.log("🔄 Updating APK file...");
                
                // Удаляем старый файл из R2
                try {
                    await r2.send(new DeleteObjectCommand({ 
                        Bucket: process.env.R2_BUCKET, 
                        Key: existingApk.apkKey 
                    }));
                    console.log("✅ Old APK file deleted from R2");
                } catch (r2Error) {
                    console.error("❌ Error deleting old APK from R2:", r2Error);
                    // Продолжаем, даже если не удалось удалить старый файл
                }

                // Загружаем новый файл
                const newApkKey = `apks/${Date.now()}-${apkFile.originalname.replace(/[^a-zA-Z0-9.-]/g, "_")}`;
                
                await r2.send(
                    new PutObjectCommand({
                        Bucket: process.env.R2_BUCKET,
                        Key: newApkKey,
                        Body: apkFile.buffer,
                        ContentType: apkFile.mimetype,
                    })
                );

                updateData.apkKey = newApkKey;
                updateData.apkUrl = `${process.env.R2_PUBLIC_URL}/${encodeURIComponent(newApkKey)}`;
                console.log("✅ New APK uploaded:", newApkKey);
            }

            // --------------------
            // ОБНОВЛЕНИЕ ИКОНКИ (ЕСЛИ ЗАГРУЖЕНА НОВАЯ)
            // --------------------
            if (iconFile) {
                console.log("🔄 Updating icon...");
                
                // Удаляем старую иконку из R2 (если есть)
                if (existingApk.iconKey) {
                    try {
                        await r2.send(new DeleteObjectCommand({ 
                            Bucket: process.env.R2_BUCKET, 
                            Key: existingApk.iconKey 
                        }));
                        console.log("✅ Old icon deleted from R2");
                    } catch (r2Error) {
                        console.error("❌ Error deleting old icon from R2:", r2Error);
                    }
                }

                // Загружаем новую иконку
                const newIconKey = `icons/${Date.now()}-${iconFile.originalname.replace(/[^a-zA-Z0-9.-]/g, "_")}`;
                
                await r2.send(
                    new PutObjectCommand({
                        Bucket: process.env.R2_BUCKET,
                        Key: newIconKey,
                        Body: iconFile.buffer,
                        ContentType: iconFile.mimetype,
                    })
                );

                updateData.iconKey = newIconKey;
                updateData.iconUrl = `${process.env.R2_PUBLIC_URL}/${encodeURIComponent(newIconKey)}`;
                console.log("✅ New icon uploaded:", newIconKey);
            }

            // --------------------
            // ОБНОВЛЕНИЕ В БД
            // --------------------
            const updatedApk = await Apk.findByIdAndUpdate(
                req.params.id,
                updateData,
                { new: true } // возвращает обновленный документ
            );

            console.log("✅ APK updated in DB:", updatedApk._id);
            res.json(updatedApk);

        } catch (err) {
            console.error("❌ Update error:", err);
            res.status(500).json({
                error: "Update failed",
                details: err.message,
            });
        }
    }
);

// DELETE APK (protected)
app.delete("/apks/:id", authMiddleware, async (req, res) => {
    try {
        console.log("🗑️ Deleting APK:", req.params.id);
        
        const apk = await Apk.findById(req.params.id);
        if (!apk) {
            return res.status(404).json({ error: "APK not found" });
        }

        // Удаление файлов из R2
        try {
            await r2.send(new DeleteObjectCommand({ 
                Bucket: process.env.R2_BUCKET, 
                Key: apk.apkKey 
            }));
            console.log("✅ APK file deleted from R2");
            
            if (apk.iconKey) {
                await r2.send(new DeleteObjectCommand({ 
                    Bucket: process.env.R2_BUCKET, 
                    Key: apk.iconKey 
                }));
                console.log("✅ Icon file deleted from R2");
            }
        } catch (r2Error) {
            console.error("❌ Error deleting from R2:", r2Error);
            // Продолжаем удаление из БД даже если R2 не смог удалить
        }

        // Удаление из БД
        await Apk.findByIdAndDelete(req.params.id);
        console.log("✅ APK deleted from DB");
        
        res.json({ message: "APK deleted successfully" });

    } catch (err) {
        console.error("❌ Delete error:", err);
        res.status(500).json({ error: "Server error" });
    }
});

/* ======================
   ERROR HANDLER
====================== */
app.use((err, req, res, next) => {
    console.error("❌ Global error:", err);
    res.status(500).json({ error: "Internal server error" });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: "Route not found" });
});

/* ======================
   START SERVER
====================== */
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
});