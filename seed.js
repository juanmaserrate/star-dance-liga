const bcrypt = require('bcryptjs');
const db = require('./database');

async function seed() {
  console.log('🌱 Inicializando catálogo completo de disciplinas y categorías para Liga Star Dance...');

  await db.initPromise;

  // 1. Insert Clubs
  const insertClub = db.prepare(`INSERT INTO clubs (id, name, representative, contact_phone, city) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`);
  await insertClub.run(1, 'CLUB DEPORTIVO ESTRELLA', 'PROF. ANA CLARA GÓMEZ', '+54 9 264 412 3456', 'SAN JUAN');
  await insertClub.run(2, 'ESCUELA DE PATÍN SAN JUAN', 'PROF. CARLOS ROSSI', '+54 9 264 598 7654', 'SAN JUAN');
  await insertClub.run(3, 'CLUB PATÍN SOL NACIENTE', 'PROF. MARÍA TORRES', '+54 9 261 433 2211', 'MENDOZA');

  // 2. Insert Users
  const passwordHashAdmin = bcrypt.hashSync('admin', 10);
  const passwordHashSandra = bcrypt.hashSync('Sandra2026', 10);
  const passwordHashProfe = bcrypt.hashSync('profe', 10);
  const passwordHashJuez = bcrypt.hashSync('juez', 10);

  const insertUser = db.prepare(`
    INSERT INTO users (id, username, password_hash, full_name, role, club_id, email, phone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
  `);

  await insertUser.run(1, 'admin', passwordHashAdmin, 'ADMINISTRADOR STAR DANCE', 'admin', 1, 'ADMIN@STARDANCE.COM.AR', '+54 9 264 000 1111');
  await insertUser.run(2, 'profe', passwordHashProfe, 'PROF. ANA CLARA GÓMEZ', 'profesor', 1, 'ANA@ESTRELLAPATIN.COM', '+54 9 264 412 3456');
  await insertUser.run(3, 'profe.carlos', passwordHashProfe, 'PROF. CARLOS ROSSI', 'profesor', 2, 'CARLOS@PATINSANJUAN.COM', '+54 9 264 598 7654');
  await insertUser.run(4, 'juez', passwordHashJuez, 'MARIANA SOLA (JUEZ OFICIAL)', 'juez', null, 'JUEZ.MARIANA@STARDANCE.COM.AR', '+54 9 11 5432 1098');
  await insertUser.run(5, 'sandra', passwordHashSandra, 'SANDRA (ADMINISTRADORA)', 'admin', 1, 'sandra@stardance.com.ar', '+54 9 264 555 7777');

  // Multi-club assignment for teachers
  await db.prepare(`INSERT INTO user_clubs (user_id, club_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(2, 1);
  await db.prepare(`INSERT INTO user_clubs (user_id, club_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(2, 2);
  await db.prepare(`INSERT INTO user_clubs (user_id, club_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(3, 2);
  await db.prepare(`INSERT INTO user_clubs (user_id, club_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(5, 1);
  await db.prepare(`INSERT INTO user_clubs (user_id, club_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(5, 2);

  // 3. Insert Tournaments
  const insertTournament = db.prepare(`
    INSERT INTO tournaments (id, name, description, venue, event_date, registration_deadline, status)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
  `);

  await insertTournament.run(
    1,
    'GRAN TORNEO APERTURA STAR DANCE 2026',
    'Torneo oficial clasificatorio de Patinaje Artístico. Disciplinas: Libre, Free Dance, Solo Dance, Parejas, Dúos, Tríos, Cuartetos, Small, Show y Precisión.',
    'ESTADIO ALDO CANTONI, POLIDEPORTIVO SAN JUAN',
    '2026-09-15',
    '2026-09-01',
    'upcoming'
  );

  await insertTournament.run(
    2,
    'TORNEO PRUEBA',
    'Torneo de prueba oficial de la Liga Star Dance. Disciplinas: Libre, Free Dance, Solo Dance, Parejas, Dúos, Tríos, Cuartetos, Small, Show y Precisión.',
    'ESTADIO ALDO CANTONI / POLIDEPORTIVO SAN JUAN',
    '2026-10-15',
    '2026-10-01',
    'upcoming'
  );

  // 4. Insert Comprehensive Disciplines & Categories
  const insertCategory = db.prepare(`
    INSERT INTO categories (id, tournament_id, name, discipline, division, min_age, max_age, gender, schedule, fee)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
  `);

  let catId = 1;

  // --- LIBRE (División C, B, A) ---
  const libreCDivs = ['EXHIBICIÓN', 'INICIACIÓN B', 'INICIACIÓN A', 'ESCUELA FORMATIVA', 'PRE 5TA C', '5TA C', 'CUARTA C', 'PRE 3ERA C', '3ERA C', 'SEGUNDA C', 'PRIMERA C'];
  for (const div of libreCDivs) {
    await insertCategory.run(catId++, 1, `LIBRE C - ${div}`, 'LIBRE', 'C', 4, 18, 'MIXTO', 'SÁBADO MAÑANA', 15000);
  }

  const libreBDivs = ['PROMO B', 'TERCERA B', 'SEGUNDA B', 'PRIMERA B'];
  for (const div of libreBDivs) {
    await insertCategory.run(catId++, 1, `LIBRE B - ${div}`, 'LIBRE', 'B', 8, 25, 'MIXTO', 'SÁBADO TARDE', 18000);
  }
  await insertCategory.run(catId++, 1, 'LIBRE A - FEDERADAS', 'LIBRE', 'A', 12, 30, 'MIXTO', 'SÁBADO NOCHE', 22000);

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

  for (const age of danceAges) {
    await insertCategory.run(catId++, 1, `FREE DANCE - STAR DANCE ${age.name}`, 'FREE DANCE', 'STAR DANCE', age.min, age.max, 'MIXTO', 'DOMINGO MAÑANA', 16000);
    await insertCategory.run(catId++, 1, `SOLO DANCE - STAR DANCE ${age.name}`, 'SOLO DANCE', 'STAR DANCE', age.min, age.max, 'MIXTO', 'DOMINGO MAÑANA', 16000);
  }

  // --- PAREJAS MIXTAS ---
  await insertCategory.run(catId++, 1, 'PAREJAS MIXTAS - C CERO / INICIACIÓN', 'PAREJAS MIXTAS', 'C', 6, 18, 'MIXTO', 'DOMINGO TARDE', 20000);
  await insertCategory.run(catId++, 1, 'PAREJAS MIXTAS - B PROMO / AVANZADO', 'PAREJAS MIXTAS', 'B', 10, 25, 'MIXTO', 'DOMINGO TARDE', 24000);

  // --- DÚO, TRÍO, CUARTETO (COLORES) ---
  const colors = ['NARANJA', 'TURQUESA', 'VERDE', 'ROSA', 'AMARILLO', 'VIOLETA'];
  for (const col of colors) {
    await insertCategory.run(catId++, 1, `DÚO - COLOR ${col}`, 'DÚO', col, 4, 30, 'MIXTO', 'SÁBADO TARDE', 22000);
    await insertCategory.run(catId++, 1, `TRÍO - COLOR ${col}`, 'TRÍO', col, 4, 30, 'MIXTO', 'SÁBADO TARDE', 28000);
    await insertCategory.run(catId++, 1, `CUARTETO - COLOR ${col}`, 'CUARTETO', col, 4, 30, 'MIXTO', 'SÁBADO TARDE', 34000);
  }

  // --- SMALL (Hasta 6), SHOW (Hasta 30), PRECISIÓN (Hasta 30) ---
  for (const age of danceAges) {
    await insertCategory.run(catId++, 1, `SMALL GROUP (HASTA 6) - ${age.name}`, 'SMALL', 'GRUPO', age.min, age.max, 'MIXTO', 'DOMINGO NOCHE', 40000);
    await insertCategory.run(catId++, 1, `SHOW (HASTA 30) - ${age.name}`, 'SHOW', 'GRUPO', age.min, age.max, 'MIXTO', 'DOMINGO NOCHE', 60000);
    await insertCategory.run(catId++, 1, `PRECISIÓN (HASTA 30) - ${age.name}`, 'PRECISIÓN', 'GRUPO', age.min, age.max, 'MIXTO', 'DOMINGO NOCHE', 60000);
  }

  // 5. Insert Students
  const insertStudent = db.prepare(`
    INSERT INTO students (
      id, teacher_id, club_id, first_name, last_name, dni, cuil, birth_date,
      category_default, health_insurance, policy_number, medical_notes, emergency_contact, emergency_phone
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
  `);

  await insertStudent.run(101, 3, 1, 'FLORENCIA', 'VALENZUELA', '52114477', '27-52114477-8', '2014-06-15', 'LIBRE C - 3ERA C', 'OSDE 310', 'POL-88221', 'APTO MÉDICO OK', 'LILIANA VALENZUELA', '+54 9 264 411 2233');
  await insertStudent.run(102, 3, 1, 'MARTINA', 'BENÍTEZ', '54332211', '27-54332211-3', '2016-09-22', 'LIBRE C - INICIACIÓN A', 'SWISS MEDICAL', 'POL-33441', 'SIN OBSERVACIONES', 'GUSTAVO BENÍTEZ', '+54 9 264 522 3344');
  await insertStudent.run(103, 3, 1, 'ISABELLA', 'PEREYRA', '56998811', '27-56998811-5', '2018-03-10', 'SOLO DANCE - MINI TOTS', 'SANCOR SALUD', 'POL-77112', 'ALERGIA POLVO', 'ROSA PEREYRA', '+54 9 264 633 4455');
  await insertStudent.run(104, 3, 1, 'CAMILA EMILIA', 'PAREDES', '49887766', '27-49887766-1', '2012-11-05', 'LIBRE B - PROMO B', 'MEDIFE', 'POL-55667', 'APTO MÉDICO OK', 'MARCELO PAREDES', '+54 9 264 744 5566');
  await insertStudent.run(4, 3, 2, 'CAMILA', 'FERNÁNDEZ', '46778899', '27-46778899-2', '2013-11-04', 'LIBRE C - 3ERA C', 'MEDIFE', 'MED-9988', 'APTO OK', 'JORGE FERNÁNDEZ', '+54 9 264 733 4455');
  await insertStudent.run(5, 3, 2, 'MATEO', 'SÁNCHEZ', '42998877', '20-42998877-5', '2008-07-30', 'LIBRE A - FEDERADAS', 'SANCOR SALUD', 'SAN-5544', 'ENTRENA DOBLE TURNO', 'ELENA SÁNCHEZ', '+54 9 264 844 5566');

  // 6. Registrations
  const insertReg = db.prepare(`
    INSERT INTO registrations (
      id, tournament_id, category_id, student_id, club_id, teacher_id, is_group, group_name, group_type,
      status, payment_status, original_fee, discount_amount, discount_reason, final_fee, payment_date, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
  `);

  await insertReg.run(1, 1, 9, 1, 1, 2, false, null, 'Individual', 'registered', 'paid', 15000, 0, null, 15000, '2026-07-30 14:20:00', 'MÚSICA OK');
  await insertReg.run(2, 1, 3, 2, 1, 2, false, null, 'Individual', 'registered', 'pending', 15000, 3000, 'BECA PROMOCIONAL PROFE', 12000, null, 'PENDIENTE PAGO');
  await insertReg.run(3, 1, 14, 3, 1, 2, false, null, 'Individual', 'registered', 'paid', 18000, 0, null, 18000, '2026-07-31 09:10:00', 'PAGO TRANSFERENCIA');

  // 7. Initial Tournament Expenses
  const insertExpense = db.prepare(`
    INSERT INTO tournament_expenses (id, tournament_id, expense_category, description, amount, expense_date)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
  `);

  await insertExpense.run(1, 1, 'Medallas y Trofeos', 'MEDALLAS DE ORO, PLATA Y BRONCE APERTURA', 450000, '2026-08-01');
  await insertExpense.run(2, 1, 'Alquiler de Polideportivo', 'ALQUILER ALDO CANTONI (2 DÍAS)', 1200000, '2026-08-01');
  await insertExpense.run(3, 1, 'Sonido e Iluminación', 'EQUIPO DE SONIDO PROFESIONAL Y PANTALLA LED', 350000, '2026-08-01');

  // 8. CMS Site Settings
  const setSetting = db.prepare(`INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  await setSetting.run('hero_title', 'LIGA DE PATINAJE ARTÍSTICO STAR DANCE');
  await setSetting.run('hero_subtitle', 'Plataforma oficial de gestión de torneos, cuerpo de jueces, inscripción digital de patinadoras y fichas técnicas.');
  await setSetting.run('about_title', 'SOBRE LA LIGA STAR DANCE Y NUESTRO PROPÓSITO');
  await setSetting.run('about_content', 'La Liga Star Dance nace con la misión de impulsar, promover y profesionalizar el Patinaje Artístico sobre ruedas. Ofrecemos un marco competitivo sano, transparente y de máxima calidad técnica para deportistas desde categorías Iniciales e Infantil hasta Másters y Elite.');

  // 9. CMS Home Slides
  const insertSlide = db.prepare(`
    INSERT INTO home_slides (id, title, subtitle, image_url, button_text, button_link, order_index)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
  `);
  await insertSlide.run(1, 'GRAN TORNEO APERTURA 2026', 'Competencia clasificatoria en el Estadio Aldo Cantoni con todas las disciplinas.', '/img/logo.svg', 'VER PRÓXIMOS TORNEOS', '/torneos', 1);
  await insertSlide.run(2, 'CUERPO DE JUECES OFICIALES', 'Conoce a nuestro distinguido jurado acreditado para evaluaciones individuales y grupales.', '/img/logo.svg', 'CONOCER JURADO', '/jueces', 2);

  // 10. CMS Judge Profiles
  const insertJudge = db.prepare(`
    INSERT INTO judge_profiles (id, name, title, photo_url, bio, specialty, order_index)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
  `);
  await insertJudge.run(1, 'MARIANA SOLA', 'JUEZ NACIONAL OFICIAL', '/img/logo.svg', 'Especialista técnica en disciplinas Libre y Parejas con más de 12 años de trayectoria arbitral.', 'LIBRE Y PAREJAS', 1);
  await insertJudge.run(2, 'MARTA BENÍTEZ', 'JUEZ INTERNACIONAL DE DANZA', '/img/logo.svg', 'Juez oficial de Free Dance, Solo Dance, Show y Precisión. Certificación continental.', 'DANCE, SHOW Y PRECISIÓN', 2);

  // 11. CMS Discipline Info
  const insertDisciplineInfo = db.prepare(`
    INSERT INTO discipline_info (id, name, description, icon, order_index)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
  `);
  await insertDisciplineInfo.run(1, 'LIBRE', 'Evaluación técnica de saltos, trompos y trabajo de pies. Divisiones C (Exhibición a 1era C), B (Promo B a 1era B) y A Federadas.', '⛸️', 1);
  await insertDisciplineInfo.run(2, 'FREE DANCE & SOLO DANCE', 'Danza sobre ruedas con énfasis en la interpretación musical, técnica de cantos y fluidez. Niveles desde Debutantes hasta Style.', '💃', 2);
  await insertDisciplineInfo.run(3, 'PAREJAS MIXTAS', 'Trabajo en pareja con elevaciones, trompos combinados y sincronismo perfecto. Evaluación según el integrante de mayor categoría.', '👫', 3);
  await insertDisciplineInfo.run(4, 'DÚOS, TRÍOS Y CUARTETOS', 'Grupos pequeños categorizados por colores (Naranja a Violeta). Evaluación según la deportista de mayor categoría o edad.', '⭐', 4);
  await insertDisciplineInfo.run(5, 'SMALL GROUP, SHOW Y PRECISIÓN', 'Grandes producciones grupales de hasta 30 patinadoras. Impresionantes coreografías, sincronía y vestuarios temáticos.', '🏆', 5);

  // 12. Reset sequences to match inserted IDs
  const sequences = [
    { table: 'clubs', seq: 'clubs_id_seq' },
    { table: 'users', seq: 'users_id_seq' },
    { table: 'tournaments', seq: 'tournaments_id_seq' },
    { table: 'categories', seq: 'categories_id_seq' },
    { table: 'students', seq: 'students_id_seq' },
    { table: 'registrations', seq: 'registrations_id_seq' },
    { table: 'tournament_expenses', seq: 'tournament_expenses_id_seq' },
    { table: 'home_slides', seq: 'home_slides_id_seq' },
    { table: 'judge_profiles', seq: 'judge_profiles_id_seq' },
    { table: 'discipline_info', seq: 'discipline_info_id_seq' }
  ];

  for (const { table, seq } of sequences) {
    await db.exec(`SELECT setval('${seq}', COALESCE((SELECT MAX(id) FROM ${table}), 1))`);
  }

  console.log('✅ Base de datos PostgreSQL inicializada con catálogo completo y CMS de la página principal.');
}

seed().then(() => process.exit(0)).catch(err => {
  console.error('Error en seed:', err);
  process.exit(1);
});
