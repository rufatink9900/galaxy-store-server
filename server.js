require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const mongoose = require("mongoose");

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

const app = express();
app.use(cors());
app.use(express.json());

/* ============================
   MongoDB CONNECT
============================ */

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err));

/* ============================
   APK MODEL
============================ */

const apkSchema = new mongoose.Schema({
  title: String,
  apkUrl: String,
  iconUrl: String,
  apkKey: String,
  iconKey: String,
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const Apk = mongoose.model("Apk", apkSchema);

/* ============================
   R2 CONFIG
============================ */

const r2 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

/* ============================
   MULTER
============================ */

const upload = multer({
  storage: multer.memoryStorage(),
});

/* ============================
   AUTH MIDDLEWARE
============================ */

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Invalid token" });
  }

  next();
}

/* ============================
   ROUTES
============================ */

// GET ALL APKS
app.get("/apks", async (req, res) => {
  try {
    const apks = await Apk.find().sort({ createdAt: -1 });
    res.json(apks);
  } catch (err) {
    res.status(500).json({ error: "Ошибка получения APK" });
  }
});

// UPLOAD APK
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

      if (!apkFile) {
        return res.status(400).json({ error: "APK file required" });
      }

      // Upload APK
      const apkKey = `apks/${Date.now()}-${apkFile.originalname}`;

      await r2.send(
        new PutObjectCommand({
          Bucket: process.env.R2_BUCKET,
          Key: apkKey,
          Body: apkFile.buffer,
          ContentType: apkFile.mimetype,
        })
      );

      const apkUrl = `${process.env.R2_PUBLIC_URL}/${encodeURIComponent(apkKey)}`;

      // Upload Icon (optional)
      let iconUrl = null;
      let iconKey = null;

      if (iconFile) {
        iconKey = `icons/${Date.now()}-${iconFile.originalname}`;

        await r2.send(
          new PutObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: iconKey,
            Body: iconFile.buffer,
            ContentType: iconFile.mimetype,
          })
        );

        iconUrl = `${process.env.R2_PUBLIC_URL}/${encodeURIComponent(iconKey)}`;
      }

      const newApk = await Apk.create({
        title: title || apkFile.originalname,
        apkUrl,
        iconUrl,
        apkKey,
        iconKey,
      });

      res.json(newApk);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Ошибка загрузки" });
    }
  }
);

// DELETE APK
app.delete("/apks/:id", authMiddleware, async (req, res) => {
  try {
    const apk = await Apk.findById(req.params.id);
    if (!apk) return res.status(404).json({ error: "APK not found" });

    // Delete APK file
    await r2.send(
      new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: apk.apkKey,
      })
    );

    // Delete icon if exists
    if (apk.iconKey) {
      await r2.send(
        new DeleteObjectCommand({
          Bucket: process.env.R2_BUCKET,
          Key: apk.iconKey,
        })
      );
    }

    await Apk.findByIdAndDelete(req.params.id);

    res.json({ message: "APK deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка удаления" });
  }
});

/* ============================
   START SERVER
============================ */

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
