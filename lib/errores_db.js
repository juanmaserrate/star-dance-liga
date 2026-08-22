// Traduce los errores de la base a mensajes que se entiendan en pantalla.
//
// La app arrancó en SQLite y quedaron chequeos del tipo
// err.message.includes('UNIQUE constraint failed'). En PostgreSQL ese texto no
// existe: la violación de unicidad llega con code '23505' y un mensaje
// "duplicate key value violates unique constraint ...". Por eso los avisos
// amables nunca se mostraban y el usuario veía siempre el error genérico.
const db = require('../database');

function esDuplicado(err) {
  if (!err) return false;
  if (err.code === '23505') return true;
  return !!(err.message && (
    err.message.includes('UNIQUE constraint failed') ||
    err.message.includes('duplicate key value violates unique constraint')
  ));
}

// ¿A qué columna corresponde la violación? Sirve para distinguir, por ejemplo,
// un DNI repetido de un CUIL repetido.
function campoDuplicado(err) {
  const texto = String((err && (err.constraint || err.detail || err.message)) || '').toLowerCase();
  if (texto.includes('dni')) return 'dni';
  if (texto.includes('cuil')) return 'cuil';
  if (texto.includes('username')) return 'username';
  if (texto.includes('email')) return 'email';
  return null;
}

// Mensaje para un DNI repetido: dice quién ya lo tiene cargado, para que la
// profesora sepa que no hace falta cargarla de nuevo y a quién reclamarla.
async function mensajeDniRepetido(dni) {
  const limpio = String(dni || '').trim().toUpperCase();
  if (!limpio) return 'Ya existe una patinadora registrada con ese DNI.';

  const ya = await db.prepare(`
    SELECT s.first_name, s.last_name, s.birth_date,
      c.name AS club_name,
      COALESCE(u.full_name, u.username) AS teacher_name
    FROM students s
    LEFT JOIN clubs c ON c.id = s.club_id
    LEFT JOIN users u ON u.id = s.teacher_id
    WHERE s.dni = ?
  `).get(limpio);

  if (!ya) return `Ya existe una patinadora registrada con el DNI ${limpio}.`;

  const nombre = `${ya.last_name || ''} ${ya.first_name || ''}`.trim() || 'una patinadora';
  const donde = [
    ya.club_name ? `del club ${ya.club_name}` : null,
    ya.teacher_name ? `en el padrón de ${ya.teacher_name}` : null
  ].filter(Boolean).join(', ');

  return `El DNI ${limpio} ya está cargado: ${nombre}${donde ? ', ' + donde : ''}. ` +
    'Si es la misma patinadora no hace falta cargarla de nuevo: pedile al administrador que te la pase a tu padrón. ' +
    'Si es otra persona, revisá el número de documento.';
}

module.exports = { esDuplicado, campoDuplicado, mensajeDniRepetido };
