const bcrypt = require('bcryptjs');
const db = require('./database');

function seed() {
  console.log('🌱 Inicializando datos de prueba para Liga Star Dance...');

  // 1. Insert Clubs
  const insertClub = db.prepare(`INSERT OR IGNORE INTO clubs (id, name, representative, contact_phone, city) VALUES (?, ?, ?, ?, ?)`);
  insertClub.run(1, 'Club Deportivo Estrella', 'Prof. Ana Clara Gómez', '+54 9 264 412 3456', 'San Juan');
  insertClub.run(2, 'Escuela de Patín San Juan', 'Prof. Carlos Rossi', '+54 9 264 598 7654', 'San Juan');
  insertClub.run(3, 'Club Patín Sol Naciente', 'Prof. María Torres', '+54 9 261 433 2211', 'Mendoza');

  // 2. Insert Users
  const passwordHashAdmin = bcrypt.hashSync('admin123', 10);
  const passwordHashProfe = bcrypt.hashSync('profe123', 10);
  const passwordHashJuez = bcrypt.hashSync('juez123', 10);

  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (id, username, password_hash, full_name, role, club_id, email, phone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertUser.run(1, 'admin', passwordHashAdmin, 'Administrador Star Dance', 'admin', 1, 'admin@stardance.com.ar', '+54 9 264 000 1111');
  insertUser.run(2, 'profe.ana', passwordHashProfe, 'Prof. Ana Clara Gómez', 'profesor', 1, 'ana@estrellapatin.com', '+54 9 264 412 3456');
  insertUser.run(3, 'profe.carlos', passwordHashProfe, 'Prof. Carlos Rossi', 'profesor', 2, 'carlos@patinsanjuan.com', '+54 9 264 598 7654');
  insertUser.run(4, 'juez', passwordHashJuez, 'Juez Mariana Sola (Oficial)', 'juez', null, 'juez.mariana@stardance.com.ar', '+54 9 11 5432 1098');
  insertUser.run(5, 'juez.marta', passwordHashJuez, 'Juez Marta Benítez (Internacional)', 'juez', null, 'marta@patinart.com', '+54 9 11 6789 4321');

  // 3. Insert Tournaments
  const insertTournament = db.prepare(`
    INSERT OR IGNORE INTO tournaments (id, name, description, venue, event_date, registration_deadline, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insertTournament.run(
    1,
    'Gran Torneo Apertura Star Dance 2026',
    'Primer gran torneo clasificatorio de la temporada con todas las categorías de Escuela, Libre, Danza e Iniciación.',
    'Polideportivo Municipal San Juan, Estadio Aldo Cantoni',
    '2026-09-15',
    '2026-09-01',
    'upcoming'
  );

  insertTournament.run(
    2,
    'Copa Provincial de Invierno',
    'Torneo promocional interclubes de Patinaje Artístico.',
    'Club Deportivo Estrella - Sede Central',
    '2026-11-20',
    '2026-11-05',
    'upcoming'
  );

  // 4. Insert Categories for Tournament 1
  const insertCategory = db.prepare(`
    INSERT OR IGNORE INTO categories (id, tournament_id, name, min_age, max_age, discipline, level, gender, schedule, fee)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertCategory.run(1, 1, 'Iniciación Infantil (Tots / Promocional)', 4, 8, 'Iniciación', 'Iniciación', 'Mixto', 'Sábado 09:00 hs', 12000);
  insertCategory.run(2, 1, 'C Tercera Infantil B', 9, 12, 'Libre', 'C Tercera', 'Femenino', 'Sábado 11:30 hs', 15000);
  insertCategory.run(3, 1, 'C Segunda Juvenil', 13, 16, 'Libre', 'C Segunda', 'Mixto', 'Sábado 15:00 hs', 18000);
  insertCategory.run(4, 1, 'Elite Mayor (Senior A)', 17, 30, 'Libre', 'A / Elite', 'Mixto', 'Sábado 18:30 hs', 22000);
  insertCategory.run(5, 1, 'Danza Solo Infantil', 7, 12, 'Danza', 'B Avanzado', 'Mixto', 'Domingo 10:00 hs', 16000);

  // 5. Insert Students for Profe Ana (Teacher ID 2, Club ID 1)
  const insertStudent = db.prepare(`
    INSERT OR IGNORE INTO students (
      id, teacher_id, club_id, first_name, last_name, dni, birth_date,
      category_default, health_insurance, policy_number, medical_notes, emergency_contact, emergency_phone
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertStudent.run(1, 2, 1, 'Sofía', 'Martínez', '48123456', '2015-05-12', 'C Tercera Infantil B', 'OSDE 310', '987654321', 'Apto médico vigente hasta dic 2026', 'Laura Martínez (Mamá)', '+54 9 264 400 1122');
  insertStudent.run(2, 2, 1, 'Valentina', 'Gómez', '50876543', '2018-08-20', 'Iniciación Infantil', 'Swiss Medical', 'SM-45678', 'Sin observaciones', 'Roberto Gómez (Papá)', '+54 9 264 511 2233');
  insertStudent.run(3, 2, 1, 'Lucas', 'Rodríguez', '44112233', '2011-02-14', 'C Segunda Juvenil', 'OSECAC', 'OS-112233', 'Alergia a la penicilina', 'María Rodríguez', '+54 9 264 622 3344');

  // Insert Students for Profe Carlos (Teacher ID 3, Club ID 2)
  insertStudent.run(4, 3, 2, 'Camila', 'Fernández', '46778899', '2013-11-04', 'C Tercera Infantil B', 'Medife', 'MED-9988', 'Apto ok', 'Jorge Fernández', '+54 9 264 733 4455');
  insertStudent.run(5, 3, 2, 'Mateo', 'Sánchez', '42998877', '2008-07-30', 'Elite Mayor', 'Sancor Salud', 'SAN-5544', 'Entrena en doble turno', 'Elena Sánchez', '+54 9 264 844 5566');

  // 6. Insert Initial Registrations
  const insertReg = db.prepare(`
    INSERT OR IGNORE INTO registrations (id, tournament_id, category_id, student_id, club_id, teacher_id, status, payment_status, payment_date, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertReg.run(1, 1, 2, 1, 1, 2, 'registered', 'paid', '2026-07-30 14:20:00', 'Música recibida correctamente');
  insertReg.run(2, 1, 1, 2, 1, 2, 'registered', 'pending', null, 'Falta confirmar malla');
  insertReg.run(3, 1, 3, 3, 1, 2, 'registered', 'paid', '2026-07-31 09:10:00', 'Pago por transferencia abonado');
  insertReg.run(4, 1, 2, 4, 2, 3, 'registered', 'paid', '2026-07-31 10:00:00', 'Club San Juan');
  insertReg.run(5, 1, 4, 5, 2, 3, 'registered', 'pending', null, 'Categoría Elite Mayor');

  console.log('✅ Base de datos poblada exitosamente con datos de prueba.');
}

seed();
