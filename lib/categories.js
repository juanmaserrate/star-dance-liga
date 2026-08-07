// Devuelve el nombre legible de una categoría quitando el prefijo
// "DISCIPLINA - " con el que se guardan (ej: "LIBRE - 1B" → "1B").
function formatCategoryName(name, discipline) {
  if (name === null || name === undefined) return '';
  let s = String(name).trim();
  if (!s) return '';

  if (discipline) {
    const prefix = String(discipline).trim();
    if (prefix && s.toUpperCase().startsWith(prefix.toUpperCase() + ' - ')) {
      return s.slice(prefix.length + 3).trim();
    }
    if (prefix && s.toUpperCase().startsWith(prefix.toUpperCase() + '-')) {
      return s.slice(prefix.length + 1).trim();
    }
  }

  // Fallback: quitar cualquier prefijo "XXXX - " que tenga delante
  const m = s.match(/^[^\-]+\s*-\s*(.+)$/);
  return m ? m[1].trim() : s;
}

module.exports = { formatCategoryName };
