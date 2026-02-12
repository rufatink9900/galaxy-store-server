require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
app.use(cors());
app.use(express.json());

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

// APK
const apkSchema = new mongoose.Schema({
  title: String,
  apkUrl: String,
  iconUrl: String,
  apkKey: String,
  iconKey: String,
  createdAt: { type: Date, default: Date.now },
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
const upload = multer({ storage: multer.memoryStorage() });

/* ======================
   AUTH MIDDLEWARE
====================== */
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No token" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.adminId = decoded.adminId;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* ======================
   LOGIN ROUTE
====================== */
app.post("/login", async (req, res) => {
  const { login, password } = req.body; 
  try {
    const admin = await Admin.findOne({ login }); 
    if (!admin) return res.status(401).json({ error: "Invalid credentials" });

    const validPassword = await bcrypt.compare(password, admin.password);
    if (!validPassword) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ adminId: admin._id }, process.env.JWT_SECRET, { expiresIn: "2h" });
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
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
      const { title } = req.body;
      const apkFile = req.files.apk?.[0];
      const iconFile = req.files.icon?.[0];

      if (!apkFile) return res.status(400).json({ error: "APK required" });

      const apkKey = `apks/${Date.now()}-${apkFile.originalname}`;
      await r2.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: apkKey,
        Body: apkFile.buffer,
        ContentType: apkFile.mimetype,
      }));
      const apkUrl = `${process.env.R2_PUBLIC_URL}/${encodeURIComponent(apkKey)}`;

      let iconUrl = null;
      let iconKey = null;
      if (iconFile) {
        iconKey = `icons/${Date.now()}-${iconFile.originalname}`;
        await r2.send(new PutObjectCommand({
          Bucket: process.env.R2_BUCKET,
          Key: iconKey,
          Body: iconFile.buffer,
          ContentType: iconFile.mimetype,
        }));
        iconUrl = `${process.env.R2_PUBLIC_URL}/${encodeURIComponent(iconKey)}`;
      }

      const newApk = await Apk.create({ title: title || apkFile.originalname, apkUrl, iconUrl, apkKey, iconKey });
      res.json(newApk);

    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Upload error" });
    }
  }
);

// DELETE APK (protected)
app.delete("/apks/:id", authMiddleware, async (req, res) => {
  try {
    const apk = await Apk.findById(req.params.id);
    if (!apk) return res.status(404).json({ error: "Not found" });

    await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: apk.apkKey }));
    if (apk.iconKey) await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: apk.iconKey }));

    await Apk.findByIdAndDelete(req.params.id);
    res.json({ message: "Deleted" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ======================
   START SERVER
====================== */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
