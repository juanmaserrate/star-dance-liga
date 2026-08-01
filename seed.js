const bcrypt = require('bcryptjs');
const db = require('./database');

function seed() {
  console.log('🌱 Inicializando catálogo completo de disciplinas y categorías para Liga Star Dance...');

  // 1. Insert Clubs
  const insertClub = db.prepare(`INSERT OR IGNORE INTO clubs (id, name, representative, contact_phone, city) VALUES (?, ?, ?, ?, ?)`);
  insertClub.run(1, 'CLUB DEPORTIVO ESTRELLA', 'PROF. ANA CLARA GÓMEZ', '+54 9 264 412 3456', 'SAN JUAN');
  insertClub.run(2, 'ESCUELA DE PATÍN SAN JUAN', 'PROF. CARLOS ROSSI', '+54 9 264 598 7654', 'SAN JUAN');
  insertClub.run(3, 'CLUB PATÍN SOL NACIENTE', 'PROF. MARÍA TORRES', '+54 9 261 433 2211', 'MENDOZA');

  // 2. Insert Users
  const passwordHashAdmin = bcrypt.hashSync('admin123', 10);
  const passwordHashProfe = bcrypt.hashSync('profe123', 10);
  const passwordHashJuez = bcrypt.hashSync('juez123', 10);

  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (id, username, password_hash, full_name, role, club_id, email, phone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertUser.run(1, 'admin', passwordHashAdmin, 'ADMINISTRADOR STAR DANCE', 'admin', 1, 'ADMIN@STARDANCE.COM.AR', '+54 9 264 000 1111');
  insertUser.run(2, 'profe.ana', passwordHashProfe, 'PROF. ANA CLARA GÓMEZ', 'profesor', 1, 'ANA@ESTRELLAPATIN.COM', '+54 9 264 412 3456');
  insertUser.run(3, 'profe.carlos', passwordHashProfe, 'PROF. CARLOS ROSSI', 'profesor', 2, 'CARLOS@PATINSANJUAN.COM', '+54 9 264 598 7654');
  insertUser.run(4, 'juez', passwordHashJuez, 'MARIANA SOLA (JUEZ OFICIAL)', 'juez', null, 'JUEZ.MARIANA@STARDANCE.COM.AR', '+54 9 11 5432 1098');

  // Multi-club assignment for teachers
  db.prepare(`INSERT OR IGNORE INTO user_clubs (user_id, club_id) VALUES (?, ?)`).run(2, 1);
  db.prepare(`INSERT OR IGNORE INTO user_clubs (user_id, club_id) VALUES (?, ?)`).run(2, 2); // Ana also manages Club 2
  db.prepare(`INSERT OR IGNORE INTO user_clubs (user_id, club_id) VALUES (?, ?)`).run(3, 2);

  // 3. Insert Tournaments
  const insertTournament = db.prepare(`
    INSERT OR IGNORE INTO tournaments (id, name, description, venue, event_date, registration_deadline, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insertTournament.run(
    1,
    'GRAN TORNEO APERTURA STAR DANCE 2026',
    'Torneo oficial clasificatorio de Patinaje Artístico. Disciplinas: Libre, Free Dance, Solo Dance, Parejas, Dúos, Tríos, Cuartetos, Small, Show y Precisión.',
    'ESTADIO ALDO CANTONI, POLIDEPORTIVO SAN JUAN',
    '2026-09-15',
    '2026-09-01',
    'upcoming'
  );

  // 4. Insert Comprehensive Disciplines & Categories
  const insertCategory = db.prepare(`
    INSERT OR IGNORE INTO categories (id, tournament_id, name, discipline, division, min_age, max_age, gender, schedule, fee)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let catId = 1;

  // --- LIBRE (División C, B, A) ---
  const libreCDivs = ['EXHIBICIÓN', 'INICIACIÓN B', 'INICIACIÓN A', 'ESCUELA FORMATIVA', 'PRE 5TA C', '5TA C', 'CUARTA C', 'PRE 3ERA C', '3ERA C', 'SEGUNDA C', 'PRIMERA C'];
  libreCDivs.forEach(div => {
    insertCategory.run(catId++, 1, `LIBRE C - ${div}`, 'LIBRE', 'C', 4, 18, 'MIXTO', 'SÁBADO MAÑANA', 15000);
  });

  const libreBDivs = ['PROMO B', 'TERCERA B', 'SEGUNDA B', 'PRIMERA B'];
  libreBDivs.forEach(div => {
    insertCategory.run(catId++, 1, `LIBRE B - ${div}`, 'LIBRE', 'B', 8, 25, 'MIXTO', 'SÁBADO TARDE', 18000);
  });
  insertCategory.run(catId++, 1, 'LIBRE A - FEDERADAS', 'LIBRE', 'A', 12, 30, 'MIXTO', 'SÁBADO NOCHE', 22000);

  // --- FREE DANCE & SOLO DANCE ---
  const danceAges = [
    { name: 'MINI TOTS', min: 6, max: 7 },
    { name: 'TOTS', min: 8, max: 9 },
    { name: 'MINIS', min: 10, max: 11 },
    { name: 'INFANTIL', min: 12, max: 13 },
    { name: 'JUVENIL', min: 14, max: 17 },
    { name: 'SENIOR', min: 18, max: 20 },
    { name: 'CLÁSICO', min: 21, max: 30 },
    { name: 'NOVICIO', min: 31, max: 40 },
    { name: 'PROFESIONAL', min: 41, max: 50 },
    { name: 'MASTER', min: 51, max: 60 },
    { name: 'EXPERTO', min: 61, max: 70 }
  ];

  danceAges.forEach(age => {
    insertCategory.run(catId++, 1, `FREE DANCE - STAR DANCE ${age.name}`, 'FREE DANCE', 'STAR DANCE', age.min, age.max, 'MIXTO', 'DOMINGO MAÑANA', 16000);
    insertCategory.run(catId++, 1, `SOLO DANCE - STAR DANCE ${age.name}`, 'SOLO DANCE', 'STAR DANCE', age.min, age.max, 'MIXTO', 'DOMINGO MAÑANA', 16000);
  });

  // --- PAREJAS MIXTAS ---
  insertCategory.run(catId++, 1, 'PAREJAS MIXTAS - C CERO / INICIACIÓN', 'PAREJAS MIXTAS', 'C', 6, 18, 'MIXTO', 'DOMINGO TARDE', 20000);
  insertCategory.run(catId++, 1, 'PAREJAS MIXTAS - B PROMO / AVANZADO', 'PAREJAS MIXTAS', 'B', 10, 25, 'MIXTO', 'DOMINGO TARDE', 24000);

  // --- DÚO, TRÍO, CUARTETO (COLORES) ---
  const colors = ['NARANJA', 'TURQUESA', 'VERDE', 'ROSA', 'AMARILLO', 'VIOLETA'];
  colors.forEach(col => {
    insertCategory.run(catId++, 1, `DÚO - COLOR ${col}`, 'DÚO', col, 4, 30, 'MIXTO', 'SÁBADO TARDE', 22000);
    insertCategory.run(catId++, 1, `TRÍO - COLOR ${col}`, 'TRÍO', col, 4, 30, 'MIXTO', 'SÁBADO TARDE', 28000);
    insertCategory.run(catId++, 1, `CUARTETO - COLOR ${col}`, 'CUARTETO', col, 4, 30, 'MIXTO', 'SÁBADO TARDE', 34000);
  });

  // --- SMALL (Hasta 6), SHOW (Hasta 30), PRECISIÓN (Hasta 30) ---
  danceAges.forEach(age => {
    insertCategory.run(catId++, 1, `SMALL GROUP (HASTA 6) - ${age.name}`, 'SMALL', 'GRUPO', age.min, age.max, 'MIXTO', 'DOMINGO NOCHE', 40000);
    insertCategory.run(catId++, 1, `SHOW (HASTA 30) - ${age.name}`, 'SHOW', 'GRUPO', age.min, age.max, 'MIXTO', 'DOMINGO NOCHE', 60000);
    insertCategory.run(catId++, 1, `PRECISIÓN (HASTA 30) - ${age.name}`, 'PRECISIÓN', 'GRUPO', age.min, age.max, 'MIXTO', 'DOMINGO NOCHE', 60000);
  });

  // 5. Insert Students for Profe Ana (Upper case formatting & mandatory email/insurance)
  const insertStudent = db.prepare(`
    INSERT OR IGNORE INTO students (
      id, teacher_id, club_id, first_name, last_name, dni, cuil, birth_date,
      category_default, health_insurance, policy_number, medical_notes, emergency_contact, emergency_phone
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertStudent.run(1, 2, 1, 'SOFÍA', 'MARTÍNEZ', '48123456', '27-48123456-4', '2015-05-12', 'LIBRE C - 3ERA C', 'OSDE 310', '987654321', 'APTO MÉDICO AL DÍA', 'LAURA MARTÍNEZ', '+54 9 264 400 1122');
  insertStudent.run(2, 2, 1, 'VALENTINA', 'GÓMEZ', '50876543', '27-50876543-8', '2018-08-20', 'LIBRE C - INICIACIÓN A', 'SWISS MEDICAL', 'SM-45678', 'SIN OBSERVACIONES', 'ROBERTO GÓMEZ', '+54 9 264 511 2233');
  insertStudent.run(3, 2, 1, 'LUCAS', 'RODRÍGUEZ', '44112233', '20-44112233-3', '2011-02-14', 'LIBRE B - SEGUNDA B', 'OSECAC', 'OS-112233', 'ALERGIA PENICILINA', 'MARÍA RODRÍGUEZ', '+54 9 264 622 3344');

  // Insert Students for Profe Carlos
  insertStudent.run(4, 3, 2, 'CAMILA', 'FERNÁNDEZ', '46778899', '27-46778899-2', '2013-11-04', 'LIBRE C - 3ERA C', 'MEDIFE', 'MED-9988', 'APTO OK', 'JORGE FERNÁNDEZ', '+54 9 264 733 4455');
  insertStudent.run(5, 3, 2, 'MATEO', 'SÁNCHEZ', '42998877', '20-42998877-5', '2008-07-30', 'LIBRE A - FEDERADAS', 'SANCOR SALUD', 'SAN-5544', 'ENTRENA DOBLE TURNO', 'ELENA SÁNCHEZ', '+54 9 264 844 5566');

  // 6. Registrations
  const insertReg = db.prepare(`
    INSERT OR IGNORE INTO registrations (
      id, tournament_id, category_id, student_id, club_id, teacher_id, is_group, group_name, group_type,
      status, payment_status, original_fee, discount_amount, discount_reason, final_fee, payment_date, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertReg.run(1, 1, 9, 1, 1, 2, 0, null, 'Individual', 'registered', 'paid', 15000, 0, null, 15000, '2026-07-30 14:20:00', 'MÚSICA OK');
  insertReg.run(2, 1, 3, 2, 1, 2, 0, null, 'Individual', 'registered', 'pending', 15000, 3000, 'BECA PROMOCIONAL PROFE', 12000, null, 'PENDIENTE PAGO');
  insertReg.run(3, 1, 14, 3, 1, 2, 0, null, 'Individual', 'registered', 'paid', 18000, 0, null, 18000, '2026-07-31 09:10:00', 'PAGO TRANSFERENCIA');

  // 7. Initial Tournament Expenses (Admin Financials)
  const insertExpense = db.prepare(`
    INSERT OR IGNORE INTO tournament_expenses (id, tournament_id, expense_category, description, amount, expense_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  insertExpense.run(1, 1, 'Medallas y Trofeos', 'MEDALLAS DE ORO, PLATA Y BRONCE APERTURA', 450000, '2026-08-01');
  insertExpense.run(2, 1, 'Alquiler de Polideportivo', 'ALQUILER ALDO CANTONI (2 DÍAS)', 1200000, '2026-08-01');
  insertExpense.run(3, 1, 'Sonido e Iluminación', 'EQUIPO DE SONIDO PROFESIONAL Y PANTALLA LED', 350000, '2026-08-01');

  console.log('✅ Base de datos actualizada con catálogo completo de disciplinas, formato MAYÚSCULAS y módulo financiero.');
}

seed();
