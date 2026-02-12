require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

// Подключение к MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => {
    console.error("Mongo error:", err);
    process.exit(1);
  });

// Схема админа
const adminSchema = new mongoose.Schema({
  login: {
    type: String,
    unique: true,
    required: true,
  },
  password: {
    type: String,
    required: true,
  },
});

const Admin = mongoose.model("Admin", adminSchema);

const LOGIN = "admin";
const PASSWORD = "kazimrufat11"; 

async function createAdmin() {
  try {
    const existing = await Admin.findOne({ login: LOGIN });

    if (existing) {
      console.log("⚠ Admin already exists");
      process.exit();
    }

    const hashedPassword = await bcrypt.hash(PASSWORD, 10);

    await Admin.create({
      login: LOGIN,
      password: hashedPassword,
    });

    console.log("✅ Admin created successfully");
    process.exit();

  } catch (err) {
    console.error("Error creating admin:", err);
    process.exit(1);
  }
}

createAdmin();
