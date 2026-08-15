// Chequeo de sintaxis: parsea todos los .js del proyecto y compila todas las
// plantillas EJS sin conectarse a la base.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'public', 'scratch', 'data']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

let errors = 0;
const files = walk(ROOT);

for (const file of files) {
  const rel = path.relative(ROOT, file);
  try {
    if (file.endsWith('.js')) {
      new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
    } else if (file.endsWith('.ejs')) {
      ejs.compile(fs.readFileSync(file, 'utf8'), { filename: file });
    } else {
      continue;
    }
  } catch (err) {
    errors++;
    console.log(`❌ ${rel}\n   ${err.message.split('\n')[0]}`);
  }
}

// Chequeo extra del catálogo
const catalog = require('../data/catalogo_categorias.json');
console.log(`\nCatálogo: ${catalog.length} disciplinas → ${catalog.map(g => g.discipline).join(', ')}`);

console.log(errors === 0 ? '\n✅ Sintaxis OK en todos los archivos.' : `\n❌ ${errors} archivo(s) con errores.`);
process.exit(errors === 0 ? 0 : 1);
