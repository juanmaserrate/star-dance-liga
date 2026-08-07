const MONTHS_ES = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];
const DAYS_ES = ['DOMINGO', 'LUNES', 'MARTES', 'MIÉRCOLES', 'JUEVES', 'VIERNES', 'SÁBADO'];

// Parsea fechas evitando el corrimiento de zona horaria (usa solo componentes).
function parseDate(v) {
  if (!v) return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const [y, m, d] = v.slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const dt = new Date(v);
  return isNaN(dt.getTime()) ? null : dt;
}

// "VIERNES 1 DE AGOSTO DE 2026" — fecha larga en español.
function formatLongEs(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return dateStr || '';
  return `${DAYS_ES[d.getDay()]} ${d.getDate()} DE ${MONTHS_ES[d.getMonth()]} DE ${d.getFullYear()}`;
}

// "29 Y 30 DE AGOSTO" / "6 DE SEPTIEMBRE Y 4 DE OCTUBRE" / "5, 6 Y 7 DE DICIEMBRE"
function formatEventDates(dateFrom, dateTo) {
  const f = parseDate(dateFrom);
  if (!f) return dateFrom || '';
  const t = parseDate(dateTo);
  if (!t || (t.getFullYear() === f.getFullYear() && t.getMonth() === f.getMonth() && t.getDate() === f.getDate())) {
    return `${f.getDate()} DE ${MONTHS_ES[f.getMonth()]}`;
  }

  const days = [];
  const cur = new Date(f.getFullYear(), f.getMonth(), f.getDate());
  const end = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  while (cur <= end) {
    days.push(cur.getDate());
    cur.setDate(cur.getDate() + 1);
  }

  if (f.getMonth() === t.getMonth() && f.getFullYear() === t.getFullYear()) {
    const list = days.slice(0, -1).join(', ') + ' Y ' + days[days.length - 1];
    return `${list} DE ${MONTHS_ES[f.getMonth()]}`;
  }

  return `${f.getDate()} DE ${MONTHS_ES[f.getMonth()]} Y ${t.getDate()} DE ${MONTHS_ES[t.getMonth()]}`;
}

// "1 DE OCTUBRE" — fecha de cierre en español, sin hora ni GMT.
function formatDeadline(dateStr) {
  return formatEventDates(dateStr, null);
}

module.exports = { formatLongEs, formatEventDates, formatDeadline, parseDate };
