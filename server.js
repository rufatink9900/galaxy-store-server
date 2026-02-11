require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
const PORT = process.env.PORT || 3000;

const AUTH_TOKEN = process.env.API_AUTH_TOKEN || "supersecret123"; // хардкод/из env

// Middleware для проверки токена
function authMiddleware(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || authHeader !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}


// CORS для Android и других клиентов
app.use(cors());
app.use(express.json());

// Настройка multer (хранение в памяти)
const upload = multer({ storage: multer.memoryStorage() });
const PUBLIC_URL = process.env.R2_PUBLIC_URL;


// Подключение к R2
const r2 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT, // https://ACCOUNT_ID.r2.cloudflarestorage.com
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

let apks = []; 

app.get("/apks", (req, res) => {
  res.json(apks);
});

app.post(
  "/apks",
  authMiddleware,
  upload.fields([
    { name: "apk", maxCount: 1 },
    { name: "icon", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
        
      const apkFile = req.files.apk?.[0];
      const iconFile = req.files.icon?.[0];
      const { title } = req.body;

      if (!apkFile) return res.status(400).json({ error: "APK обязателен" });

      // Генерируем ключи файлов
      const apkKey = `apks/${Date.now()}-${apkFile.originalname}`;
      const iconKey = iconFile
        ? `icons/${Date.now()}-${iconFile.originalname}`
        : null;

      // Загружаем APK в R2
      await r2.send(
        new PutObjectCommand({
          Bucket: process.env.R2_BUCKET,
          Key: apkKey,
          Body: apkFile.buffer,
          ContentType: apkFile.mimetype,
        })
      );

      // Загружаем иконку
      if (iconFile) {
        await r2.send(
          new PutObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: iconKey,
            Body: iconFile.buffer,
            ContentType: iconFile.mimetype,
          })
        );
      }


// Формируем URL через public domain, с кодированием
const apkUrl = `${process.env.R2_PUBLIC_URL}/${encodeURIComponent(apkKey)}`;
const iconUrl = iconKey
  ? `${process.env.R2_PUBLIC_URL}/${encodeURIComponent(iconKey)}`
  : null;


      // Сохраняем метаданные
      const newApk = {
        id: Date.now(),
        title: title || apkFile.originalname,
        apkUrl,
        iconUrl,
        apkKey,
        iconKey,
        createdAt: new Date().toISOString(),
      };
      apks.push(newApk);

      res.json(newApk);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Ошибка загрузки в R2" });
    }
  }
);

app.put("/apks/:id", authMiddleware, upload.fields([
  { name: "apk", maxCount: 1 },
  { name: "icon", maxCount: 1 },
]), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const apkIndex = apks.findIndex(a => a.id === id);
    if (apkIndex === -1) return res.status(404).json({ error: "APK не найден" });

    const apk = apks[apkIndex];
    const { title } = req.body;
    const apkFile = req.files.apk?.[0];
    const iconFile = req.files.icon?.[0];

    // Обновляем APK
    if (apkFile) {
      const apkKey = `apks/${Date.now()}-${apkFile.originalname}`;
      await r2.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: apkKey,
        Body: apkFile.buffer,
        ContentType: apkFile.mimetype,
      }));
      // Удаляем старый файл
      await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: apk.apkKey }));
      apk.apkKey = apkKey;
      apk.apkUrl = `${process.env.R2_PUBLIC_URL}/${encodeURIComponent(apkKey)}`;
    }

    // Обновляем иконку
    if (iconFile) {
      const iconKey = `icons/${Date.now()}-${iconFile.originalname}`;
      await r2.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: iconKey,
        Body: iconFile.buffer,
        ContentType: iconFile.mimetype,
      }));
      if (apk.iconKey) {
        await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: apk.iconKey }));
      }
      apk.iconKey = iconKey;
      apk.iconUrl = `${process.env.R2_PUBLIC_URL}/${encodeURIComponent(iconKey)}`;
    }

    // Обновляем title
    if (title) {
      apk.title = `${title} (NEW)`;
    }

    apks[apkIndex] = apk;
    res.json(apk);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка обновления APK" });
  }
});


// DELETE /apks/:id — удалить приложение и файлы из R2
app.delete("/apks/:id",authMiddleware, async (req, res) => {
  const id = Number(req.params.id);
  const apkIndex = apks.findIndex((a) => a.id === id);

  if (apkIndex === -1)
    return res.status(404).json({ error: "APK не найден" });

  const apk = apks[apkIndex];

  try {
    // Удаляем APK
    await r2.send(
      new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: apk.apkKey,
      })
    );

    // Удаляем иконку, если есть
    if (apk.iconKey) {
      await r2.send(
        new DeleteObjectCommand({
          Bucket: process.env.R2_BUCKET,
          Key: apk.iconKey,
        })
      );
    }

    // Удаляем из памяти / MongoDB
    apks.splice(apkIndex, 1);

    res.json({ message: "APK и иконка удалены" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка удаления файлов из R2" });
  }
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});
