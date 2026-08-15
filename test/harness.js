// Arranca un Postgres real en proceso (PGlite) y hace que database.js lo use,
// para probar migraciones, arranque y rutas sin tocar la base de producción.
const { PGlite } = require('@electric-sql/pglite');

const pglite = new PGlite();

// Adaptador con la misma interfaz que usa database.js (pool.query -> {rows, rowCount})
// database.js registra setTypeParser para DATE/TIMESTAMP y recibe el texto
// crudo ('YYYY-MM-DD'), no objetos Date. PGlite devuelve Date, así que se
// convierte para que la prueba se comporte igual que producción.
function normalizeDates(rows) {
  for (const row of rows || []) {
    for (const key of Object.keys(row)) {
      const v = row[key];
      if (v instanceof Date) {
        const iso = v.toISOString();
        row[key] = iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
      }
    }
  }
  return rows;
}

const fakePool = {
  async query(sql, params) {
    // pglite.query() no acepta varias sentencias en una sola llamada; para eso
    // está exec(). Cuando no hay parámetros usamos exec y devolvemos el último
    // resultado, que es lo que espera database.js.
    if (!params || params.length === 0) {
      const results = await pglite.exec(sql);
      const last = Array.isArray(results) ? results[results.length - 1] : results;
      return {
        rows: normalizeDates((last && last.rows) || []),
        rowCount: last && last.affectedRows != null ? last.affectedRows : ((last && last.rows) || []).length
      };
    }
    const res = await pglite.query(sql, params);
    return {
      rows: normalizeDates(res.rows || []),
      rowCount: res.affectedRows != null ? res.affectedRows : (res.rows || []).length
    };
  },
  async end() { await pglite.close(); }
};

// Intercepta `require('pg')` antes de que database.js lo pida.
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'pg') {
    return {
      Pool: function () { return fakePool; },
      types: { setTypeParser() {} }
    };
  }
  return originalLoad.apply(this, arguments);
};

module.exports = { pglite, fakePool };
