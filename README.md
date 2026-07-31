# ⛸️ Liga de Patinaje Artístico Star Dance - Plataforma Web y Móvil

Plataforma web autónoma y responsive diseñada especialmente para la **Liga Star Dance**, con los colores institucionales violeta semioscuro (`#2d1245`) y dorado (`#d4af37`), e insignia de la estrella con la patinadora.

---

## 🚀 Inicio Rápido

1. **Abrir con doble clic**: Ejecutá `iniciar.bat` en la raíz del proyecto.
2. **Iniciar manualmente**:
   ```bash
   npm start
   ```
3. Accedé desde cualquier navegador o dispositivo móvil en la misma red local a:
   `http://localhost:3000`

---

## 🔐 Cuentas de Acceso Predeterminadas (Demo)

| Rol | Usuario | Contraseña | Funciones |
| :--- | :--- | :--- | :--- |
| **Administrador** | `admin` | `admin123` | Control total, armado de torneos, categorías, caja/pagos, exportables CSV, usuarios y clubes. |
| **Profesor/a** | `profe.ana` | `profe123` | Padrón de alumnos del club, fichas médicas/seguros, inscripciones y certificados de inscripción. |
| **Juez** | `juez` | `juez123` | Módulo de competencia, planillas de juzgamiento por categoría y orden de salida. |

---

## ✨ Funcionalidades Principales

### 📱 Sitio Público (Móvil y Escritorio)
- **Hero & Presentación**: Estética oficial con logo vectorial SVG y distintivos dorados.
- **Torneos y Fechas**: Listado de torneos con sedes, fechas del evento, categorías, niveles y aranceles.
- **Cuerpo de Jueces**: Presentación del jurado oficial de la liga.

### 👤 Módulo Profesores
- **Padrón de Alumnos**: Guardado único de patinadores para selección directa. Carga de DNI, fecha de nacimiento, obra social, número de afiliado, contacto de emergencia y ficha médica.
- **Subida de Documentos**: Adjuntos de aptos médicos y comprobantes en formato PDF/Imagen.
- **Inscripción en 1-Clic**: Selección de alumno -> torneo -> categoría/disciplina.
- **Certificados Imprimibles**: Generación de certificados de inscripción oficiales listos para imprimir o guardar en PDF.

### 👑 Módulo Administrador
- **Armador de Torneos y Categorías**: Creación de torneos y configuración de categorías (disciplinas Libre, Escuela, Danza, Show, niveles C Cero, C Tercera, C Segunda, B, Elite, horarios y precios).
- **Master de Inscripciones y Control de Pagos**: Marcación instantánea de pagos (`PAGADO` / `PENDIENTE`), cálculo de totales recaudados y saldos adeudados.
- **Dashboards e Indicadores**: Stat tiles con totales de atletas, inscripciones, clubes y saldo recaudado vs pendiente.
- **Exportables a Excel / CSV**: Generación de padrones en CSV con codificación UTF-8 BOM compatible con Excel y acentos en español.
- **Gestión de Clubes y Usuarios**: Registro de instituciones afiliadas y cuentas para profesores y jueces.

### ⚖️ Módulo Jueces
- **Planilla de Juzgamiento**: Listado ordenado por categoría, nivel, disciplina y orden de salida con casilleros para nota Técnica, Artística, Deducciones y Total.
- **Formato de Imprenta**: Configuración CSS para impresión limpia en papel A4.

---

## 🛠️ Tecnología

- **Backend**: Node.js + Express
- **Base de Datos**: `node:sqlite` (SQLite autónomo nativo en Node.js, sin dependencias C++)
- **Frontend**: EJS + CSS3 (Diseño responsivo móvil/escritorio con glassmorphism)
- **Seguridad**: `bcryptjs` para hashes de contraseña y manejo de sesiones.
