// Estado inicial compartido por las pruebas: replica el esquema y los datos
// que hoy tiene produccion, para verificar el camino de migracion completo.
async function buildState(pglite) {
  // Esquema tal cual está hoy en producción (sin age, sin admin_scope,
  // sin official_key, y con el CHECK de roles viejo de 3 valores).
  await pglite.exec(`
    CREATE TABLE clubs (
      id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, logo_url TEXT,
      representative TEXT, contact_phone TEXT, city TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE users (
      id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CONSTRAINT users_role_check CHECK(role IN ('admin', 'profesor', 'juez')),
      club_id INTEGER REFERENCES clubs(id) ON DELETE SET NULL,
      email TEXT, phone TEXT, email_verified BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE user_clubs (
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      club_id INTEGER REFERENCES clubs(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, club_id)
    );
    CREATE TABLE students (
      id SERIAL PRIMARY KEY,
      teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      first_name TEXT NOT NULL, last_name TEXT NOT NULL, dni TEXT UNIQUE NOT NULL,
      cuil TEXT, birth_date DATE NOT NULL, category_default TEXT,
      health_insurance TEXT NOT NULL, policy_number TEXT NOT NULL, medical_notes TEXT,
      emergency_contact TEXT, emergency_phone TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE tournaments (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT, venue TEXT NOT NULL,
      event_date DATE NOT NULL, registration_deadline DATE NOT NULL, banner_url TEXT,
      status TEXT NOT NULL DEFAULT 'upcoming' CHECK(status IN ('upcoming','active','finished')),
      date_from DATE, date_to DATE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE categories (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      name TEXT NOT NULL, discipline TEXT NOT NULL, division TEXT, level TEXT,
      min_age INTEGER DEFAULT 0, max_age INTEGER DEFAULT 99,
      gender TEXT NOT NULL DEFAULT 'Mixto', schedule TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE registrations (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
      club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
      teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_group BOOLEAN DEFAULT false, group_name TEXT,
      group_type TEXT CHECK(group_type IN ('Individual','Dúo','Trío','Cuarteto','Small','Show','Precisión','Parejas Mixtas')),
      status TEXT NOT NULL DEFAULT 'registered' CHECK(status IN ('registered','confirmed','cancelled')),
      notes TEXT, age_band TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE registration_members (
      id SERIAL PRIMARY KEY,
      registration_id INTEGER NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message TEXT NOT NULL, link TEXT, is_read BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Datos parecidos a los de producción
  await pglite.exec(`
    INSERT INTO clubs (name, city) VALUES
      ('CIENCIA Y LABOR', 'CABA'), ('CLUB VILLEGAS', 'GBA'), ('GALAXY', 'CABA');

    INSERT INTO users (username, password_hash, full_name, role, club_id, email) VALUES
      ('admin', 'x', 'ADMINISTRADOR STAR DANCE', 'admin', 1, 'admin@stardance.com.ar'),
      ('gisellelorenaalarcon@hotmail.com', 'x', 'GISELLE', 'profesor', 1, 'gisellelorenaalarcon@hotmail.com'),
      ('sandrasil222@hotmail.com', 'x', 'SANDRA PUGLISI', 'profesor', 2, 'sandrasil222@hotmail.com');

    INSERT INTO user_clubs (user_id, club_id) VALUES (2, 1), (3, 2);

    INSERT INTO students (teacher_id, club_id, first_name, last_name, dni, birth_date, health_insurance, policy_number) VALUES
      (2, 1, 'SOFIA', 'MARTINEZ', '50111222', '2014-05-10', 'OSDE', 'P1'),
      (2, 1, 'LUCIA', 'GOMEZ',    '50111333', '2010-03-02', 'OSDE', 'P2'),
      (3, 2, 'CAMILA', 'PEREZ',   '50111444', '2006-08-21', 'SWISS', 'P3');

    INSERT INTO tournaments (name, description, venue, event_date, date_from, date_to, registration_deadline, status) VALUES
      ('ZONA SUR', 'D', 'POLIDEPORTIVO ZONA SUR', '2026-08-29', '2026-08-29', '2026-08-30', '2026-08-20', 'upcoming'),
      ('ZONA CABA', 'D', 'POLIDEPORTIVO CABA', '2026-09-06', '2026-09-06', '2026-10-04', '2026-08-28', 'upcoming'),
      ('MEGA COPA', 'D', 'ESTADIO CUBIERTO MEGA COPA', '2026-12-05', '2026-12-05', '2026-12-07', '2026-11-25', 'upcoming'),
      ('3 ERA FECHA ZONA SUR', 'D', 'INSTITUTO ESTRADA', '2026-08-30', '2026-08-30', '2026-08-30', '2026-08-10', 'finished');

    -- Categorías viejas, incluidas las de STAR DANCE y STYLE que se retiran del catálogo
    INSERT INTO categories (tournament_id, name, discipline, division) VALUES
      (1, 'LIBRE - 5TA C', 'LIBRE', '5TA C'),
      (1, 'STAR DANCE - AVANZADO', 'STAR DANCE', 'AVANZADO'),
      (1, 'STYLE - INFANTIL', 'STYLE', 'INFANTIL'),
      (1, 'FREE DANCE - MINI TOTS', 'FREE DANCE', 'MINI TOTS'),
      (1, 'STAR DANCE - INICIAL', 'STAR DANCE', 'INICIAL'),
      (2, 'LIBRE - 5TA C', 'LIBRE', '5TA C');

    -- Inscripciones existentes que NO se pueden perder
    INSERT INTO registrations (tournament_id, category_id, student_id, club_id, teacher_id, group_type, status) VALUES
      (1, 1, 1, 1, 2, 'Individual', 'registered'),
      (1, 2, 2, 1, 2, 'Individual', 'registered'),
      (1, 3, 3, 2, 3, 'Individual', 'registered'),
      (1, 4, 1, 1, 2, 'Individual', 'registered'),
      (2, 6, 2, 1, 2, 'Individual', 'registered');

    INSERT INTO registration_members (registration_id, student_id) VALUES
      (1, 1), (2, 2), (3, 3), (4, 1), (5, 2);
  `);
}

module.exports = { buildState };
