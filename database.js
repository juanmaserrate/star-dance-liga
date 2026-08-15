const { Pool, types } = require('pg');

// Las columnas DATE/TIMESTAMP llegan de Postgres como objetos Date y, al
// imprimirlas en las vistas EJS con <%= %> salen en formato
// "Mon Feb 02 2009 00:00:00 GMT+0000 (Coordinated Universal Time)".
// Devolvemos el texto crudo (YYYY-MM-DD) para que se rendericen correctamente.
types.setTypeParser(1082, (val) => val); // DATE
types.setTypeParser(1114, (val) => val); // TIMESTAMP
types.setTypeParser(1184, (val) => val); // TIMESTAMPTZ

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false
});

function toParams(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

const db = {
  prepare(sql) {
    const pgSql = toParams(sql);
    return {
      async get(...params) {
        const { rows } = await pool.query(pgSql, params);
        return rows[0] || undefined;
      },
      async all(...params) {
        const { rows } = await pool.query(pgSql, params);
        return rows;
      },
      async run(...params) {
        const { rows, rowCount } = await pool.query(pgSql, params);
        return { changes: rowCount, lastInsertRowid: rows[0]?.id };
      }
    };
  },

  async exec(sql) {
    await pool.query(sql);
  }
};

async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS clubs (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      logo_url TEXT,
      representative TEXT,
      contact_phone TEXT,
      city TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'profesor', 'juez')),
      club_id INTEGER REFERENCES clubs(id) ON DELETE SET NULL,
      email TEXT,
      phone TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT true;

    CREATE TABLE IF NOT EXISTS user_clubs (
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      club_id INTEGER REFERENCES clubs(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, club_id)
    );

    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS student_documents (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      doc_type TEXT NOT NULL DEFAULT 'apto_medico',
      file_path TEXT NOT NULL,
      uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tournaments (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      venue TEXT NOT NULL,
      event_date DATE NOT NULL,
      registration_deadline DATE NOT NULL,
      banner_url TEXT,
      status TEXT NOT NULL DEFAULT 'upcoming' CHECK(status IN ('upcoming', 'active', 'finished')),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS date_from DATE;
    ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS date_to DATE;
    UPDATE tournaments SET date_from = COALESCE(date_from, event_date) WHERE date_from IS NULL;
    UPDATE tournaments SET date_to = COALESCE(date_to, event_date) WHERE date_to IS NULL;

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      discipline TEXT NOT NULL,
      division TEXT,
      level TEXT,
      min_age INTEGER DEFAULT 0,
      max_age INTEGER DEFAULT 99,
      gender TEXT NOT NULL DEFAULT 'Mixto',
      schedule TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS registrations (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
      club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_group BOOLEAN DEFAULT false,
      group_name TEXT,
      group_type TEXT CHECK(group_type IN ('Individual', 'Dúo', 'Trío', 'Cuarteto', 'Small', 'Show', 'Precisión', 'Parejas Mixtas')),
      status TEXT NOT NULL DEFAULT 'registered' CHECK(status IN ('registered', 'confirmed', 'cancelled')),
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Categorías que salieron del catálogo pero se conservan porque tienen
    -- inscripciones: quedan en la base (is_active = false) para no romper nada,
    -- pero ya no se ofrecen en el formulario de inscripción.
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS age_band TEXT;

    -- Edad de la patinadora al momento de inscribirse. Se precarga desde la
    -- ficha de la alumna y el profesor la puede corregir a mano.
    ALTER TABLE registrations ADD COLUMN IF NOT EXISTS age INTEGER;

    -- Quita definitiva de aranceles y control de pagos
    ALTER TABLE categories DROP COLUMN IF EXISTS fee;
    ALTER TABLE registrations DROP COLUMN IF EXISTS payment_status;
    ALTER TABLE registrations DROP COLUMN IF EXISTS original_fee;
    ALTER TABLE registrations DROP COLUMN IF EXISTS discount_amount;
    ALTER TABLE registrations DROP COLUMN IF EXISTS discount_reason;
    ALTER TABLE registrations DROP COLUMN IF EXISTS final_fee;
    ALTER TABLE registrations DROP COLUMN IF EXISTS payment_date;

    CREATE TABLE IF NOT EXISTS registration_members (
      id SERIAL PRIMARY KEY,
      registration_id INTEGER NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scores (
      id SERIAL PRIMARY KEY,
      registration_id INTEGER NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
      judge_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      score_technical REAL DEFAULT 0,
      score_artistic REAL DEFAULT 0,
      deductions REAL DEFAULT 0,
      total_score REAL DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(registration_id, judge_id)
    );

    CREATE TABLE IF NOT EXISTS club_scores (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      judge_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      points REAL DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tournament_id, club_id, judge_id)
    );

    CREATE TABLE IF NOT EXISTS tournament_expenses (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      expense_category TEXT NOT NULL CHECK(expense_category IN ('Medallas y Trofeos', 'Alquiler de Polideportivo', 'Sonido e Iluminación', 'Alimentos y Catering', 'Jueces y Personal', 'Otros')),
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      expense_date DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS home_slides (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      subtitle TEXT,
      image_url TEXT,
      button_text TEXT,
      button_link TEXT,
      order_index INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS judge_profiles (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      title TEXT NOT NULL,
      photo_url TEXT,
      bio TEXT,
      specialty TEXT,
      order_index INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS discipline_info (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      icon TEXT DEFAULT '⛸️',
      image_url TEXT,
      order_index INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS email_verifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      link TEXT,
      is_read BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Rol combinado profesor + administrador: ve primero su módulo de profesora
    -- y además el panel de administración.
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('admin', 'profesor', 'juez', 'profesor_admin'));

    -- Alcance del panel de administración. NULL / vacío = todos los torneos.
    -- Con valor (ej: 'CABA') solo puede editar los torneos cuyo nombre lo contenga.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_scope TEXT;

    -- Clave estable de los torneos oficiales: permite renombrarlos sin que el
    -- arranque los vuelva a crear por nombre.
    ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS official_key TEXT;

    -- Disciplinas habilitadas por torneo (orden y alta/baja editables por el admin).
    CREATE TABLE IF NOT EXISTS tournament_disciplines (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      discipline TEXT NOT NULL,
      order_index INTEGER DEFAULT 0,
      is_enabled BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (tournament_id, discipline)
    );

    -- Categorías de edad (franjas) por torneo y disciplina, editables por el admin.
    CREATE TABLE IF NOT EXISTS tournament_age_bands (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      discipline TEXT NOT NULL,
      name TEXT NOT NULL,
      min_age INTEGER NOT NULL DEFAULT 0,
      max_age INTEGER NOT NULL DEFAULT 99,
      order_index INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (tournament_id, discipline, name)
    );
  `);
}

db.initPromise = initDb();

module.exports = db;
