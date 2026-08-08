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
  CATEGORIA: 22, DISCIPLINA: 20, PROFESORA: 28, EMAIL_PROFESORA: 30, CELULAR_PROFESORA: 20,
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
      CASE WHEN s.birth_date IS NOT NULL THEN (EXTRACT(YEAR FROM CURRENT_DATE) - EXTRACT(YEAR FROM s.birth_date)) ELSE 0 END AS "EDAD",
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

module.exports = { EXPORT_FIELDS, buildQuery, fetchRegistrations, resolveFields, fieldValue, buildCsv, buildXlsx, buildMeta };
