const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'stardance.db');
const db = new DatabaseSync(dbPath);

// Enable foreign keys
db.exec('PRAGMA foreign_keys = ON;');

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clubs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      logo_url TEXT,
      representative TEXT,
      contact_phone TEXT,
      city TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'profesor', 'juez')),
      club_id INTEGER REFERENCES clubs(id) ON DELETE SET NULL,
      email TEXT,
      phone TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_clubs (
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      club_id INTEGER REFERENCES clubs(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, club_id)
    );

    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      dni TEXT UNIQUE NOT NULL,
      cuil TEXT,
      birth_date DATE NOT NULL,
      category_default TEXT,
      health_insurance TEXT NOT NULL,
      policy_number TEXT NOT NULL,
      medical_notes TEXT,
      emergency_contact TEXT,
      emergency_phone TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS student_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      doc_type TEXT NOT NULL DEFAULT 'apto_medico',
      file_path TEXT NOT NULL,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tournaments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      venue TEXT NOT NULL,
      event_date DATE NOT NULL,
      registration_deadline DATE NOT NULL,
      banner_url TEXT,
      status TEXT NOT NULL DEFAULT 'upcoming' CHECK(status IN ('upcoming', 'active', 'finished')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      discipline TEXT NOT NULL,
      division TEXT,
      min_age INTEGER DEFAULT 0,
      max_age INTEGER DEFAULT 99,
      gender TEXT NOT NULL DEFAULT 'Mixto',
      schedule TEXT,
      fee REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
      club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_group BOOLEAN DEFAULT 0,
      group_name TEXT,
      group_type TEXT CHECK(group_type IN ('Individual', 'Dúo', 'Trío', 'Cuarteto', 'Small', 'Show', 'Precisión', 'Parejas Mixtas')),
      status TEXT NOT NULL DEFAULT 'registered' CHECK(status IN ('registered', 'confirmed', 'cancelled')),
      payment_status TEXT NOT NULL DEFAULT 'pending' CHECK(payment_status IN ('pending', 'paid')),
      original_fee REAL DEFAULT 0,
      discount_amount REAL DEFAULT 0,
      discount_reason TEXT,
      final_fee REAL DEFAULT 0,
      payment_date DATETIME,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS registration_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      registration_id INTEGER NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      registration_id INTEGER NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
      judge_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      score_technical REAL DEFAULT 0,
      score_artistic REAL DEFAULT 0,
      deductions REAL DEFAULT 0,
      total_score REAL DEFAULT 0,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(registration_id, judge_id)
    );

    CREATE TABLE IF NOT EXISTS club_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      judge_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      points REAL DEFAULT 0,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tournament_id, club_id, judge_id)
    );

    CREATE TABLE IF NOT EXISTS tournament_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      expense_category TEXT NOT NULL CHECK(expense_category IN ('Medallas y Trofeos', 'Alquiler de Polideportivo', 'Sonido e Iluminación', 'Alimentos y Catering', 'Jueces y Personal', 'Otros')),
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      expense_date DATE DEFAULT CURRENT_DATE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

initDb();

module.exports = db;
