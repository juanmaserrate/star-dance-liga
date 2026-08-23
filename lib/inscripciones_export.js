// Módulo compartido de exportación de inscripciones (CSV y Excel .xlsx estilizado).
// Centraliza: definición de campos exportables, consulta con filtros por campo,
// integración de los integrantes de inscripciones grupales y generación de archivos.
const ExcelJS = require('exceljs');
const db = require('../database');
const { formatEventDates } = require('./dates');
const { formatCategoryName } = require('./categories');

// Campos que se pueden exportar (id = clave en la fila, label = encabezado legible).
const EXPORT_FIELDS = [
  { id: 'TORNEO',            label: 'Torneo' },
  { id: 'FECHA_EVENTO',      label: 'Fecha del Evento' },
  { id: 'NOMBRE_APELLIDO',   label: 'Nombre y Apellido' },
  { id: 'DNI',               label: 'DNI' },
  { id: 'CUIL',              label: 'CUIL' },
  { id: 'FECHA_NACIMIENTO',  label: 'Fecha de Nacimiento' },
  { id: 'EDAD',              label: 'Edad' },
  { id: 'CLUB',              label: 'Club' },
  { id: 'TIPO',              label: 'Tipo de Inscripción' },
  { id: 'GRUPO',             label: 'Nombre del Grupo' },
  { id: 'PARTICIPANTES',     label: 'Participantes' },
  { id: 'CATEGORIA',         label: 'Categoría' },
  { id: 'CATEGORIA_EDAD',    label: 'Categoría de Edad' },
  { id: 'DISCIPLINA',        label: 'Disciplina' },
  { id: 'PROFESORA',         label: 'Profesora a Cargo' },
  { id: 'EMAIL_PROFESORA',   label: 'Email Profesora' },
  { id: 'CELULAR_PROFESORA', label: 'Celular Profesora' },
  { id: 'SEGURO_OBRA_SOCIAL', label: 'Seguro / Obra Social' },
  { id: 'NRO_POLIZA',        label: 'Número de Póliza' }
];

const FIELD_WIDTHS = {
  TORNEO: 26, FECHA_EVENTO: 20, NOMBRE_APELLIDO: 30, DNI: 14, CUIL: 16,
  FECHA_NACIMIENTO: 18, EDAD: 8, CLUB: 26, TIPO: 14, GRUPO: 24, PARTICIPANTES: 40,
  CATEGORIA: 22, CATEGORIA_EDAD: 20, DISCIPLINA: 20, PROFESORA: 28, EMAIL_PROFESORA: 30, CELULAR_PROFESORA: 20,
  SEGURO_OBRA_SOCIAL: 22, NRO_POLIZA: 18
};

// Construye la consulta de inscripciones con filtros por campo.
// Los alias van ENTRE COMILLAS ("NOMBRE") porque PostgreSQL devuelve los alias
// sin comillas en minúscula y eso hacía que el CSV saliera con celdas vacías.
function buildQuery(filters = {}) {
  const params = [];
  let query = `
    SELECT
      r.*,
      t.name AS tournament_name, t.name AS "TORNEO",
      COALESCE(t.date_from, t.event_date) AS "FECHA_EVENTO",
      s.id AS student_id,
      s.first_name AS first_name, s.first_name AS "FIRST_NAME",
      s.last_name AS last_name, s.last_name AS "LAST_NAME",
      s.dni AS dni, COALESCE(s.dni, '-') AS "DNI",
      s.cuil AS cuil, COALESCE(s.cuil, '-') AS "CUIL",
      s.birth_date AS birth_date, s.birth_date AS "FECHA_NACIMIENTO",
      s.health_insurance AS health_insurance, COALESCE(s.health_insurance, '-') AS "SEGURO_OBRA_SOCIAL",
      s.policy_number AS policy_number, COALESCE(s.policy_number, '-') AS "NRO_POLIZA",
      COALESCE(
        r.age,
        CASE WHEN s.birth_date IS NOT NULL THEN (EXTRACT(YEAR FROM CURRENT_DATE) - EXTRACT(YEAR FROM s.birth_date))::int ELSE 0 END
      ) AS "EDAD",
      COALESCE(r.age_band, '') AS "CATEGORIA_EDAD",
      cl.name AS club_name, cl.name AS "CLUB",
      c.name AS category_name, c.name AS "CATEGORIA",
      c.discipline AS discipline, c.discipline AS "DISCIPLINA",
      c.division AS level,
      u.full_name AS teacher_name, u.full_name AS "PROFESORA",
      COALESCE(u.email, '-') AS "EMAIL_PROFESORA",
      COALESCE(u.phone, '-') AS "CELULAR_PROFESORA",
      (SELECT COUNT(*) FROM student_documents d WHERE d.student_id = s.id) AS doc_count
    FROM registrations r
    LEFT JOIN students s ON r.student_id = s.id
    JOIN clubs cl ON r.club_id = cl.id
    JOIN tournaments t ON r.tournament_id = t.id
    JOIN categories c ON r.category_id = c.id
    JOIN users u ON r.teacher_id = u.id
    WHERE 1=1
  `;

  if (filters.tournament_id) { query += ` AND r.tournament_id = ?`; params.push(filters.tournament_id); }
  if (filters.club_id) { query += ` AND r.club_id = ?`; params.push(filters.club_id); }
  // Alcance del administrador por zona (ej: solo torneos de CABA).
  if (filters.tournament_scope) {
    query += ` AND UPPER(t.name) LIKE ?`;
    params.push(`%${String(filters.tournament_scope).trim().toUpperCase()}%`);
  }
  if (filters.disciplina) { query += ` AND UPPER(c.discipline) LIKE ?`; params.push(`%${String(filters.disciplina).trim().toUpperCase()}%`); }
  if (filters.categoria) { query += ` AND UPPER(c.name) LIKE ?`; params.push(`%${String(filters.categoria).trim().toUpperCase()}%`); }
  if (filters.buscar) {
    const q = `%${String(filters.buscar).trim().toUpperCase()}%`;
    query += ` AND (
      UPPER(COALESCE(s.first_name, r.group_name)) LIKE ? OR
      UPPER(COALESCE(s.last_name, '')) LIKE ? OR
      COALESCE(s.dni, '') LIKE ? OR
      UPPER(cl.name) LIKE ? OR
      UPPER(t.name) LIKE ? OR
      UPPER(c.name) LIKE ? OR
      UPPER(c.discipline) LIKE ?
    )`;
    params.push(q, q, q, q, q, q, q);
  }

  query += ` ORDER BY t.name ASC, cl.name ASC, COALESCE(s.last_name, r.group_name) ASC, r.created_at DESC`;
  return { query, params };
}

// Trae todas las inscripciones con filtros, agregando los integrantes de grupos
// (los grupos "siempre van juntos": la fila lleva a TODAS sus participantes).
async function fetchRegistrations(filters = {}) {
  const { query, params } = buildQuery(filters);
  const rows = await db.prepare(query).all(...params);

  const memberRows = await db.prepare(`
    SELECT rm.registration_id, sm.first_name, sm.last_name, sm.dni
    FROM registration_members rm
    JOIN students sm ON sm.id = rm.student_id
    ORDER BY rm.id ASC
  `).all();
  const byReg = {};
  for (const m of memberRows) {
    if (!byReg[m.registration_id]) byReg[m.registration_id] = [];
    byReg[m.registration_id].push(m);
  }

  rows.forEach(r => {
    r.datesLabel = formatEventDates(r.date_from || r.FECHA_EVENTO || r.event_date, r.date_to);
    r.age = Number(r.EDAD) || 0;
    r.members = byReg[r.id] || [];
    r.participantes = r.members.length
      ? r.members.map(m => `${m.last_name} ${m.first_name}${m.dni ? ' (DNI ' + m.dni + ')' : ''}`.trim()).join(' · ')
      : `${r.LAST_NAME || ''}${r.LAST_NAME && r.FIRST_NAME ? ' ' : ''}${r.FIRST_NAME || ''}`.trim();
    r.FECHA_EVENTO_LABEL = r.datesLabel;
  });

  return rows;
}

// Resuelve el valor de un campo para una fila (usa el mismo criterio en CSV y Excel).
function fieldValue(row, id) {
  switch (id) {
    case 'FECHA_EVENTO': return row.FECHA_EVENTO_LABEL || row.FECHA_EVENTO || '-';
    case 'NOMBRE_APELLIDO': {
      if (row.is_group && row.group_name) return row.group_name;
      return `${row.LAST_NAME || ''}${row.LAST_NAME && row.FIRST_NAME ? ', ' : ''}${row.FIRST_NAME || ''}`.trim() || '-';
    }
    case 'TIPO': return row.group_type || 'Individual';
    case 'GRUPO': return row.is_group ? (row.group_name || '-') : '-';
    case 'PARTICIPANTES': return row.participantes || '-';
    case 'CATEGORIA': return formatCategoryName(row.CATEGORIA, row.DISCIPLINA) || '-';
    case 'EDAD': return row.EDAD === null || row.EDAD === undefined ? '' : Number(row.EDAD);
    default: {
      const v = row[id];
      if (v === null || v === undefined) return '';
      return String(v);
    }
  }
}

// Normaliza la selección de campos (acepta string o array desde req.query.fields).
function resolveFields(selected) {
  if (!selected || (Array.isArray(selected) && selected.length === 0)) {
    return EXPORT_FIELDS;
  }
  const list = Array.isArray(selected) ? selected : [selected];
  const valid = new Set(list.map(String));
  const out = EXPORT_FIELDS.filter(f => valid.has(f.id));
  return out.length ? out : EXPORT_FIELDS;
}

// --- Generación CSV ---
function buildCsv(rows, fields) {
  let csv = '\uFEFF';
  csv += fields.map(f => `"${String(f.label).toUpperCase().replace(/"/g, '""')}"`).join(';') + '\n';
  if (!rows.length) {
    csv += 'SIN RESULTADOS;\n';
  } else {
    rows.forEach(row => {
      const values = fields.map(f => {
        const v = fieldValue(row, f.id);
        return `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
      });
      csv += values.join(';') + '\n';
    });
  }
  return csv;
}

// --- Generación Excel .xlsx con la paleta del sistema ---
function colLetter(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function buildXlsx(rows, fields, meta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Liga Star Dance';
  wb.created = new Date();
  const ws = wb.addWorksheet('Inscripciones', { views: [{ state: 'frozen', ySplit: 3 }] });

  const GOLD = 'FFD4AF37', GOLD_LIGHT = 'FFF2CA50', VIOLET = 'FF3D195B', VIOLET_DARK = 'FF1E0A2E';
  const CREAM = 'FFF8F0DE', WHITE = 'FFFFFFFF';
  const n = fields.length;

  const border = {
    top: { style: 'thin', color: { argb: GOLD } },
    left: { style: 'thin', color: { argb: GOLD } },
    bottom: { style: 'thin', color: { argb: GOLD } },
    right: { style: 'thin', color: { argb: GOLD } }
  };

  // Título principal
  ws.mergeCells(1, 1, 1, n);
  const title = ws.getCell(1, 1);
  title.value = 'LIGA STAR DANCE · PLANILLA DE INSCRIPCIONES';
  title.font = { bold: true, size: 15, color: { argb: GOLD_LIGHT }, name: 'Arial' };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VIOLET } };
  title.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 30;

  // Subtítulo con filtros y cantidad
  ws.mergeCells(2, 1, 2, n);
  const sub = ws.getCell(2, 1);
  sub.value = meta;
  sub.font = { bold: true, size: 10, color: { argb: VIOLET_DARK }, name: 'Arial' };
  sub.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GOLD } };
  sub.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(2).height = 20;

  // Fila de encabezados (dorada)
  fields.forEach((f, i) => {
    const cell = ws.getCell(3, i + 1);
    cell.value = String(f.label).toUpperCase();
    cell.font = { bold: true, size: 10.5, color: { argb: VIOLET_DARK }, name: 'Arial' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GOLD } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = border;
  });
  ws.getRow(3).height = 24;

  // Filas de datos (bandas crema/blanca)
  rows.forEach((row, ri) => {
    const er = ws.getRow(4 + ri);
    const fill = ri % 2 === 0 ? CREAM : WHITE;
    fields.forEach((f, ci) => {
      const cell = er.getCell(ci + 1);
      const val = fieldValue(row, f.id);
      cell.value = val;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.border = border;
      cell.font = { size: 10, color: { argb: VIOLET_DARK }, name: 'Arial' };

      if (typeof val === 'number') {
        cell.numFmt = '0';
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
      } else {
        cell.alignment = { vertical: 'middle', wrapText: f.id === 'PARTICIPANTES' || f.id === 'NOMBRE_APELLIDO' };
      }
    });
  });

  // Tabla dinámica: auto-filtro en el encabezado
  const lastRow = Math.max(3, rows.length + 3);
  ws.autoFilter = `A3:${colLetter(n)}${lastRow}`;

  // Anchos de columna
  fields.forEach((f, i) => {
    ws.getColumn(i + 1).width = FIELD_WIDTHS[f.id] || 16;
  });

  return wb.xlsx.writeBuffer();
}

// --- Planilla de un torneo agrupada por disciplina y categoría --------------
// Una sola hoja: la disciplina es el agrupador mayor y adentro va un bloque por
// cada categoría, con su cuadro de nombre completo, edad, categoría de edad y
// club. Es la planilla que se usa el día del torneo.

// Trae las inscripciones de un torneo ya ordenadas por disciplina y categoría,
// respetando el orden configurado del torneo (no el alfabético).
async function fetchForGroupedSheet(tournamentId) {
  const rows = await db.prepare(`
    SELECT
      r.id, r.is_group, r.group_name, r.group_type,
      c.discipline, c.name AS category_name, c.ruleset,
      COALESCE(c.order_index, 0) AS cat_order,
      COALESCE(td.order_index, 999) AS disc_order,
      COALESCE(ab.order_index, 999) AS band_order,
      COALESCE(s.last_name, '') AS apellido,
      COALESCE(s.first_name, '') AS nombre_pila,
      COALESCE(
        NULLIF(TRIM(COALESCE(s.last_name, '') || ' ' || COALESCE(s.first_name, '')), ''),
        r.group_name
      ) AS nombre,
      COALESCE(
        r.age,
        CASE WHEN s.birth_date IS NOT NULL
          THEN (EXTRACT(YEAR FROM CURRENT_DATE) - EXTRACT(YEAR FROM s.birth_date))::int END
      ) AS edad,
      COALESCE(r.age_band, '') AS categoria_edad,
      cl.name AS club
    FROM registrations r
    JOIN categories c ON r.category_id = c.id
    LEFT JOIN tournament_disciplines td
      ON td.tournament_id = r.tournament_id AND td.discipline = c.discipline
    LEFT JOIN tournament_age_bands ab
      ON ab.tournament_id = r.tournament_id AND ab.discipline = c.discipline
     AND UPPER(ab.name) = UPPER(COALESCE(r.age_band, ''))
    LEFT JOIN students s ON r.student_id = s.id
    JOIN clubs cl ON r.club_id = cl.id
    WHERE r.tournament_id = ? AND COALESCE(r.status, '') <> 'cancelled'
    ORDER BY disc_order ASC, c.discipline ASC, cat_order ASC, c.name ASC, nombre ASC
  `).all(tournamentId);

  // Integrantes de las inscripciones grupales, para listarlos bajo el grupo.
  const members = await db.prepare(`
    SELECT rm.registration_id, sm.first_name, sm.last_name
    FROM registration_members rm
    JOIN students sm ON sm.id = rm.student_id
    ORDER BY rm.id ASC
  `).all();
  const byReg = {};
  for (const m of members) {
    if (!byReg[m.registration_id]) byReg[m.registration_id] = [];
    byReg[m.registration_id].push(`${m.last_name || ''} ${m.first_name || ''}`.trim());
  }
  rows.forEach(r => { r.integrantes = byReg[r.id] || []; });

  return rows;
}

// Agrupa las filas en { disciplina -> [ { categoria, ruleset, filas } ] }
// conservando el orden en que vienen de la consulta.
function groupByDisciplineAndCategory(rows) {
  const disciplinas = [];
  const idxDisc = new Map();
  const idxCat = new Map();

  for (const r of rows) {
    if (!idxDisc.has(r.discipline)) {
      idxDisc.set(r.discipline, disciplinas.length);
      disciplinas.push({ discipline: r.discipline, categorias: [], total: 0 });
    }
    const d = disciplinas[idxDisc.get(r.discipline)];
    const key = r.discipline + '||' + r.category_name;
    if (!idxCat.has(key)) {
      idxCat.set(key, d.categorias.length);
      d.categorias.push({
        label: formatCategoryName(r.category_name, r.discipline),
        ruleset: r.ruleset || null,
        filas: []
      });
    }
    d.categorias[idxCat.get(key)].filas.push(r);
    d.total++;
  }
  return disciplinas;
}

// Paleta y trazos de la marca, compartidos por las dos planillas.
const GOLD = 'FFD4AF37', GOLD_LIGHT = 'FFF2CA50', GOLD_SOFT = 'FFF6E7B0';
const VIOLET = 'FF3D195B', VIOLET_DARK = 'FF1E0A2E', VIOLET_SOFT = 'FF6B4B8A';
const CREAM = 'FFF8F0DE', WHITE = 'FFFFFFFF';

const thin = c => ({ style: 'thin', color: { argb: c } });
const boxGold = { top: thin(GOLD), left: thin(GOLD), bottom: thin(GOLD), right: thin(GOLD) };

// Crea la hoja con el encabezado de la liga y devuelve las herramientas para
// seguir escribiendo abajo. Las dos planillas arrancan igual.
function nuevaHoja(tournament, total, widths) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Liga Star Dance';
  wb.created = new Date();
  return { wb, ...agregarHoja(wb, 'Planilla', tournament, total, widths) };
}

// Agrega una hoja más al mismo libro, con el mismo encabezado de la liga.
function agregarHoja(wb, nombre, tournament, total, widths, subtitulo) {
  const ws = wb.addWorksheet(nombre, {
    views: [{ state: 'frozen', ySplit: 3 }],
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  });

  const COLS = widths.length;
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  const merge = (r, height, value, font, fillColor, align, indent) => {
    ws.mergeCells(r, 1, r, COLS);
    const cell = ws.getCell(r, 1);
    cell.value = value;
    cell.font = font;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillColor } };
    cell.alignment = {
      horizontal: align || 'center', vertical: 'middle', wrapText: true,
      ...(indent ? { indent } : {})
    };
    ws.getRow(r).height = height;
    return cell;
  };

  let row = 1;
  merge(row++, 34, 'LIGA STAR DANCE · PLANILLA DE INSCRIPCIONES',
    { bold: true, size: 16, color: { argb: GOLD_LIGHT }, name: 'Arial' }, VIOLET);

  const sede = [tournament.name, tournament.datesLabel, tournament.venue].filter(Boolean).join('  ·  ');
  merge(row++, 22, sede,
    { bold: true, size: 11, color: { argb: VIOLET_DARK }, name: 'Arial' }, GOLD);

  const d = new Date();
  const fecha = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  merge(row++, 18, subtitulo || `${total} inscripciones · Generado el ${fecha}`,
    { italic: true, size: 9, color: { argb: VIOLET_DARK }, name: 'Arial' }, CREAM);

  return { ws, merge, row: row + 1, COLS };
}

// Escribe el encabezado del cuadro y sus renglones. Devuelve la fila siguiente.
function escribirCuadro(ws, row, encabezados, filas, valoresDe, colCentrada) {
  encabezados.forEach((h, i) => {
    const cell = ws.getCell(row, i + 1);
    cell.value = h;
    cell.font = { bold: true, size: 10, color: { argb: VIOLET_DARK }, name: 'Arial' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GOLD_SOFT } };
    cell.alignment = { horizontal: i === colCentrada ? 'center' : 'left', vertical: 'middle' };
    cell.border = boxGold;
  });
  ws.getRow(row).height = 18;
  row++;

  filas.forEach((r, i) => {
    const fill = i % 2 === 0 ? WHITE : CREAM;
    valoresDe(r).forEach((v, ci) => {
      const cell = ws.getCell(row, ci + 1);
      cell.value = v;
      cell.font = { size: 10, color: { argb: VIOLET_DARK }, name: 'Arial' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.border = boxGold;
      cell.alignment = ci === colCentrada
        ? { horizontal: 'center', vertical: 'middle' }
        : { horizontal: 'left', vertical: 'middle', wrapText: ci === 0 };
    });
    if (r.is_group && r.integrantes && r.integrantes.length) ws.getRow(row).height = 28;
    row++;
  });

  return row;
}

// Nombre de la fila: los grupos llevan sus integrantes debajo, en la misma celda.
function nombreDe(r) {
  return r.is_group && r.integrantes && r.integrantes.length
    ? `${r.nombre || 'GRUPO'}\n${r.integrantes.join(' · ')}`
    : (r.nombre || '-');
}

// Ordena por edad de menor a mayor; las que no tienen edad cargada van al final.
function porEdad(filas) {
  return filas.slice().sort((a, b) => {
    const ea = a.edad === null || a.edad === undefined ? Infinity : Number(a.edad);
    const eb = b.edad === null || b.edad === undefined ? Infinity : Number(b.edad);
    if (ea !== eb) return ea - eb;
    return String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es');
  });
}

async function buildXlsxPorCategoria(rows, tournament) {
  const { wb, ws, merge, COLS } = nuevaHoja(tournament, rows.length, [34, 8, 24, 22, 28]);
  let row = 5;

  if (!rows.length) {
    merge(row, 24, 'Este torneo todavía no tiene inscripciones.',
      { bold: true, size: 11, color: { argb: VIOLET_DARK }, name: 'Arial' }, CREAM);
    return wb.xlsx.writeBuffer();
  }

  for (const disc of groupByDisciplineAndCategory(rows)) {
    // Franja de disciplina: el agrupador mayor
    merge(row++, 28, `${disc.discipline}   (${disc.total})`,
      { bold: true, size: 13, color: { argb: GOLD_LIGHT }, name: 'Arial' }, VIOLET, 'left', 1);

    for (const cat of disc.categorias) {
      // Encabezado del bloque de categoría
      const titulo = cat.ruleset
        ? `${cat.label}   ·   ${cat.ruleset}   (${cat.filas.length})`
        : `${cat.label}   (${cat.filas.length})`;
      merge(row, 22, titulo,
        { bold: true, size: 11, color: { argb: WHITE }, name: 'Arial' }, VIOLET_SOFT, 'left', 1);
      row++;

      // La categoría también va como dato de cada renglón, además de titular el
      // bloque, para que el cuadro se pueda leer o filtrar por sí solo.
      row = escribirCuadro(ws, row,
        ['NOMBRE COMPLETO', 'EDAD', 'CATEGORÍA', 'CATEGORÍA DE EDAD', 'CLUB'],
        porEdad(cat.filas),
        r => [nombreDe(r), r.edad === null ? '' : Number(r.edad), cat.label, r.categoria_edad || '-', r.club || '-'],
        1);

      row++; // aire entre bloques
    }
    row++; // aire entre disciplinas
  }

  return wb.xlsx.writeBuffer();
}

// Agrupa solo por categoría, sin importar la disciplina: la misma categoría de
// dos disciplinas distintas (ej: 4TA de LIBRE y de PAREJAS MIXTAS) cae en el
// mismo bloque, y la disciplina pasa a ser una columna del cuadro.
// Los bloques salen en el orden oficial del catálogo, no alfabético.
function groupByCategory(rows) {
  const porNombre = new Map();

  for (const r of rows) {
    const label = formatCategoryName(r.category_name, r.discipline);
    const key = String(label).toUpperCase();
    if (!porNombre.has(key)) {
      porNombre.set(key, { label, orden: Number(r.cat_order) || 0, filas: [] });
    }
    const bloque = porNombre.get(key);
    bloque.orden = Math.min(bloque.orden, Number(r.cat_order) || 0);
    bloque.filas.push(r);
  }

  return [...porNombre.values()]
    .sort((a, b) => (a.orden - b.orden) || a.label.localeCompare(b.label, 'es'))
    .map(b => ({ ...b, filas: porEdad(b.filas), total: b.filas.length }));
}

async function buildXlsxPorCategoriaSola(rows, tournament) {
  const { wb, ws, merge } = nuevaHoja(tournament, rows.length, [34, 8, 22, 22, 22, 28]);
  let row = 5;

  if (!rows.length) {
    merge(row, 24, 'Este torneo todavía no tiene inscripciones.',
      { bold: true, size: 11, color: { argb: VIOLET_DARK }, name: 'Arial' }, CREAM);
    return wb.xlsx.writeBuffer();
  }

  for (const cat of groupByCategory(rows)) {
    // Franja de categoría: acá el agrupador mayor es la categoría
    merge(row++, 28, `${cat.label}   (${cat.total})`,
      { bold: true, size: 13, color: { argb: GOLD_LIGHT }, name: 'Arial' }, VIOLET, 'left', 1);

    row = escribirCuadro(ws, row,
      ['NOMBRE COMPLETO', 'EDAD', 'DISCIPLINA', 'CATEGORÍA', 'CATEGORÍA DE EDAD', 'CLUB'],
      cat.filas,
      r => [
        nombreDe(r),
        r.edad === null ? '' : Number(r.edad),
        r.discipline || '-',
        cat.label,
        r.categoria_edad || '-',
        r.club || '-'
      ],
      1);

    row++; // aire entre bloques
  }

  return wb.xlsx.writeBuffer();
}

// --- Planilla con una hoja por categoría ------------------------------------
// Mismo agrupamiento que la anterior (por categoría, con la disciplina como
// columna), pero cada categoría va en su propia hoja del libro. Al principio
// hay una hoja de índice para no perderse entre tantas solapas.

// Excel no admite : \ / ? * [ ] en el nombre de la hoja, ni más de 31
// caracteres, ni dos hojas que se llamen igual.
function sheetName(base, usados) {
  let s = String(base || 'CATEGORIA').replace(/[:\\/?*[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > 31) s = s.slice(0, 31).trim();
  if (!s) s = 'CATEGORIA';

  let nombre = s;
  let n = 2;
  while (usados.has(nombre.toUpperCase())) {
    const sufijo = ` (${n})`;
    nombre = s.slice(0, 31 - sufijo.length).trim() + sufijo;
    n++;
  }
  usados.add(nombre.toUpperCase());
  return nombre;
}

async function buildXlsxHojaPorCategoria(rows, tournament) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Liga Star Dance';
  wb.created = new Date();

  const bloques = groupByCategory(rows);

  // Hoja índice: qué categorías hay, cuántas inscriptas y en qué solapa está cada una.
  const idx = agregarHoja(wb, 'Índice', tournament, rows.length, [24, 14, 34],
    `${rows.length} inscripciones en ${bloques.length} categorías`);

  if (!bloques.length) {
    idx.merge(idx.row, 24, 'Este torneo todavía no tiene inscripciones.',
      { bold: true, size: 11, color: { argb: VIOLET_DARK }, name: 'Arial' }, CREAM);
    return wb.xlsx.writeBuffer();
  }

  const usados = new Set(['ÍNDICE']);
  const encabezados = ['NOMBRE COMPLETO', 'EDAD', 'DISCIPLINA', 'CATEGORÍA', 'CATEGORÍA DE EDAD', 'CLUB'];

  for (const cat of bloques) {
    cat.hoja = sheetName(cat.label, usados);

    const { ws, merge, row } = agregarHoja(wb, cat.hoja, tournament, cat.total, [34, 8, 22, 22, 22, 28]);

    merge(row, 28, `${cat.label}   (${cat.total})`,
      { bold: true, size: 13, color: { argb: GOLD_LIGHT }, name: 'Arial' }, VIOLET, 'left', 1);

    // cat.filas ya viene ordenado por edad de menor a mayor desde groupByCategory
    const ultima = escribirCuadro(ws, row + 1, encabezados, cat.filas,
      r => [
        nombreDe(r),
        r.edad === null || r.edad === undefined ? '' : Number(r.edad),
        r.discipline || '-',
        cat.label,
        r.categoria_edad || '-',
        r.club || '-'
      ],
      1);

    ws.autoFilter = { from: { row: row + 1, column: 1 }, to: { row: ultima - 1, column: 6 } };
  }

  // Renglones del índice
  escribirCuadro(idx.ws, idx.row, ['CATEGORÍA', 'INSCRIPTAS', 'HOJA'], bloques,
    b => [b.label, b.total, b.hoja], 1);

  return wb.xlsx.writeBuffer();
}

// --- Libro Mayor (planilla de orden de salida a pista) ------------------------------------
// Reproduce el formato de la planilla que se usa en la pista: un bloque por
// cada combinación de disciplina + categoría + categoría de edad, y adentro las
// patinadoras con Apellido, Nombre, Institución y el número de salida.
//
// Solo se vuelca lo que hay cargado. La columna de horario queda vacía porque
// hoy ninguna categoría lo tiene definido, y la de la izquierda también, para
// anotar el puesto a mano durante la competencia.

// Agrupa por disciplina + categoría + categoría de edad, respetando el orden
// configurado del torneo (disciplina, categoría y franja etaria).
function groupByOrdenDePista(rows) {
  const bloques = [];
  const porClave = new Map();

  for (const r of rows) {
    const label = formatCategoryName(r.category_name, r.discipline);
    const franja = String(r.categoria_edad || '').trim();
    const clave = [r.discipline, label, franja.toUpperCase()].join('||');

    if (!porClave.has(clave)) {
      const bloque = {
        discipline: r.discipline,
        label,
        franja,
        // Título tal como se lee en la planilla: "FREE DANCE STAR DANCE NOVICIO"
        titulo: [r.discipline, label, franja].filter(Boolean).join(' '),
        discOrden: Number(r.disc_order) || 0,
        catOrden: Number(r.cat_order) || 0,
        bandaOrden: Number(r.band_order) || 0,
        filas: []
      };
      porClave.set(clave, bloque);
      bloques.push(bloque);
    }
    porClave.get(clave).filas.push(r);
  }

  bloques.sort((a, b) =>
    (a.discOrden - b.discOrden) ||
    a.discipline.localeCompare(b.discipline, 'es') ||
    (a.catOrden - b.catOrden) ||
    a.label.localeCompare(b.label, 'es') ||
    (a.bandaOrden - b.bandaOrden) ||
    a.franja.localeCompare(b.franja, 'es'));

  return bloques.map(b => ({ ...b, filas: porEdad(b.filas), total: b.filas.length }));
}

// Arma el Libro Mayor con el mismo formato que la planilla que usa la liga
// (LIBRO 3ER FECHA V2.xlsx): título amarillo arriba, y después un bloque por
// cada disciplina + categoría + categoría de edad. Cada bloque lleva su franja
// violeta, la fila de encabezados con la celda celeste del horario, y las
// patinadoras en renglones de doble alto.
//
// Quedan en blanco, para completar a mano: el horario, la salida a pista y las
// tres columnas de jueces. No son datos que tenga el sistema.
async function buildXlsxLibroMayor(rows, tournament) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Liga Star Dance';
  wb.created = new Date();

  const ws = wb.addWorksheet('Libro Mayor', {
    pageSetup: { paperSize: 9, orientation: 'portrait', scale: 33 }
  });

  // Paleta exacta de la plantilla
  const AMARILLO = 'FFFFFF00';
  const VIOLETA = 'FF7030A0';
  const CELESTE = 'FF00B0F0';
  const BLANCO = 'FFFFFFFF';

  const FUENTE = { name: 'Calibri', size: 28, bold: true, italic: true };
  const tinta = color => ({ ...FUENTE, color: { argb: color } });
  const relleno = color => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: color } });
  const linea = { style: 'thin', color: { argb: 'FF000000' } };
  const marco = { top: linea, left: linea, bottom: linea, right: linea };

  // A: horario · B: apellido · C: nombre · D: edad · E: institución
  // F: salida a pista · G/H/I: los tres jueces
  const A = 1, B = 2, C = 3, D = 4, E = 5, F = 6, G = 7, H = 8, I = 9;
  [21.7, 62.9, 36, 12, 67.3, 19.7, 20.1, 20.1, 20.1]
    .forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  const pintar = (fila, col, valor, fondo, colorTexto, alineacion) => {
    const celda = ws.getCell(fila, col);
    if (valor !== undefined && valor !== null) celda.value = valor;
    celda.font = tinta(colorTexto || 'FF000000');
    if (fondo) celda.fill = relleno(fondo);
    celda.border = marco;
    celda.alignment = { horizontal: alineacion || 'center', vertical: 'middle', wrapText: true };
    return celda;
  };

  let fila = 1;

  // Título: el nombre del torneo y su fecha, sobre fondo amarillo
  ws.mergeCells(fila, A, fila, I);
  const titulo = ws.getCell(fila, A);
  titulo.value = [tournament.name, tournament.datesLabel].filter(Boolean).join('  ·  ');
  titulo.font = tinta('FF000000');
  titulo.fill = relleno(AMARILLO);
  titulo.border = marco;
  titulo.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  ws.getRow(fila).height = 36.6;
  fila++;

  if (!rows.length) {
    ws.mergeCells(fila, A, fila, I);
    const aviso = ws.getCell(fila, A);
    aviso.value = 'Este torneo todavía no tiene inscripciones.';
    aviso.font = tinta('FF000000');
    aviso.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(fila).height = 36.6;
    return wb.xlsx.writeBuffer();
  }

  for (const bloque of groupByOrdenDePista(rows)) {
    const filaFranja = fila;
    const filaEncabezado = fila + 1;

    // Franja violeta con el nombre completo del bloque
    [A, B, C, D, E, G, H, I].forEach(col => pintar(filaFranja, col, null, VIOLETA, BLANCO));
    ws.mergeCells(filaFranja, B, filaFranja, E);
    const tituloBloque = ws.getCell(filaFranja, B);
    tituloBloque.value = bloque.titulo;
    tituloBloque.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };

    // "Salida a pista" ocupa las dos filas del encabezado
    ws.mergeCells(filaFranja, F, filaEncabezado, F);
    pintar(filaFranja, F, 'Salida a pista', VIOLETA, BLANCO);
    ws.getRow(filaFranja).height = 36.6;

    // Fila de encabezados: la celda del horario va celeste y vacía
    pintar(filaEncabezado, A, null, CELESTE, 'FF000000');
    pintar(filaEncabezado, B, 'Apellido', VIOLETA, BLANCO);
    pintar(filaEncabezado, C, 'Nombre', VIOLETA, BLANCO);
    pintar(filaEncabezado, D, 'Edad', VIOLETA, BLANCO);
    pintar(filaEncabezado, E, 'Institución', VIOLETA, BLANCO);
    pintar(filaEncabezado, G, 'JUEZ 1', VIOLETA, BLANCO);
    pintar(filaEncabezado, H, 'JUEZ 2', VIOLETA, BLANCO);
    pintar(filaEncabezado, I, 'JUEZ 3', VIOLETA, BLANCO);
    ws.getRow(filaEncabezado).height = 36.6;

    fila = filaEncabezado + 1;

    // Cada patinadora ocupa dos renglones combinados, como en la plantilla
    bloque.filas.forEach(r => {
      const arriba = fila, abajo = fila + 1;

      const apellido = r.is_group ? (r.group_name || 'GRUPO') : (r.apellido || '');
      const nombre = r.is_group
        ? (r.integrantes || []).join(' · ')
        : (r.nombre_pila || '');

      [[A, null], [B, apellido], [C, nombre],
       [D, r.edad === null || r.edad === undefined ? null : Number(r.edad)],
       [E, r.club || ''], [F, null]].forEach(([col, valor]) => {
        ws.mergeCells(arriba, col, abajo, col);
        pintar(arriba, col, valor, null, 'FF000000');
        ws.getCell(abajo, col).border = marco;
      });

      // Los jueces quedan sin combinar, para escribir arriba y abajo
      [G, H, I].forEach(col => {
        pintar(arriba, col, null, null, 'FF000000');
        pintar(abajo, col, null, null, 'FF000000');
      });

      ws.getRow(arriba).height = 19;
      ws.getRow(abajo).height = 19;
      fila = abajo + 1;
    });
  }

  return wb.xlsx.writeBuffer();
}

// Subtítulo de metadatos para el Excel
function buildMeta(filters = {}, count) {
  const parts = [];
  if (filters.tournament_name) parts.push(`Torneo: ${filters.tournament_name}`);
  if (filters.club_name) parts.push(`Club: ${filters.club_name}`);
  if (filters.disciplina) parts.push(`Disciplina: ${filters.disciplina.toUpperCase()}`);
  if (filters.categoria) parts.push(`Categoría: ${filters.categoria.toUpperCase()}`);
  if (filters.buscar) parts.push(`Búsqueda: ${filters.buscar.toUpperCase()}`);
  const d = new Date();
  const fecha = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${parts.length ? parts.join(' · ') + ' — ' : ''}${count} inscripciones · Generado el ${fecha}`;
}

module.exports = {
  EXPORT_FIELDS, buildQuery, fetchRegistrations, resolveFields, fieldValue,
  buildCsv, buildXlsx, buildMeta,
  fetchForGroupedSheet, groupByDisciplineAndCategory, groupByCategory,
  buildXlsxPorCategoria, buildXlsxPorCategoriaSola, buildXlsxHojaPorCategoria,
  groupByOrdenDePista, buildXlsxLibroMayor,
  buildXlsxOrdenDePista: buildXlsxLibroMayor,
  sheetName
};
