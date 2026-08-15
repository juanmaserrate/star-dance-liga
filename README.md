# Liga de Patinaje Artístico Star Dance - Plataforma Web

Plataforma web responsive para la **Liga Star Dance**, con colores institucionales violeta (`#2d1245`) y dorado (`#d4af37`).

## Stack

- **Backend**: Node.js + Express
- **Base de Datos**: PostgreSQL (vía `pg`)
- **Frontend**: EJS + CSS3 (diseño responsivo con glassmorphism)
- **Seguridad**: bcryptjs para hashes de contraseña + sesiones

## Deploy en Railway

1. Crear proyecto en [railway.app](https://railway.app)
2. Agregar servicio **PostgreSQL** al proyecto
3. Conectar el repositorio de GitHub
4. Railway detecta Node.js automáticamente y ejecuta `npm start`
5. Configurar variables de entorno en Railway:

| Variable | Valor |
| :--- | :--- |
| `DATABASE_URL` | Se configura automáticamente al agregar PostgreSQL |
| `SESSION_SECRET` | Una clave secreta larga y aleatoria |
| `NODE_ENV` | `production` |
| `SMTP_HOST` | (opcional) servidor SMTP para emails |
| `SMTP_USER` | (opcional) usuario SMTP |
| `SMTP_PASS` | (opcional) contraseña SMTP |
| `SMTP_PORT` | (opcional) puerto, default 587 |

6. Ejecutar seed para cargar datos iniciales:

```bash
railway run npm run seed
```

## Desarrollo Local

1. Tener PostgreSQL instalado o usar la URL de Railway
2. Crear archivo `.env`:

```
DATABASE_URL=postgresql://usuario:password@localhost:5432/stardance
SESSION_SECRET=mi-clave-secreta-local
```

3. Instalar dependencias e iniciar:

```bash
npm install
npm run seed
npm start
```

4. Acceder en `http://localhost:3000`

## Cuentas Demo

| Rol | Usuario | Contraseña |
| :--- | :--- | :--- |
| Admin | `admin` | `admin` |
| Profesora | `profe` | `profe` |
| Juez | `juez` | `juez` |
| Admin 2 | `sandra` | `Sandra2026` |

## Funcionalidades

- **Sitio Público**: torneos, jueces, disciplinas
- **Módulo Profesores**: padrón de alumnos, fichas médicas, inscripción, certificados
- **Módulo Administrador**: torneos, categorías, inscripciones, CMS, usuarios, clubes, CSV/Excel export
- **Módulo Jueces**: planilla de juzgamiento por categoría

## Roles

| Rol | Qué ve |
| :--- | :--- |
| `profesor` | Solo su módulo de profesora |
| `admin` | Solo el panel de administración |
| `profesor_admin` | Primero su módulo de profesora y además el panel de administración |
| `juez` | Planilla de juzgamiento |

El campo `users.admin_scope` limita el alcance del panel de administración: vacío
significa "todos los torneos"; con un valor (ej. `CABA`) la persona solo ve y
edita los torneos cuyo nombre lo contenga, y no accede a Usuarios ni al CMS.

## Catálogo de disciplinas y categorías

`data/catalogo_categorias.json` es la **semilla**, no la fuente de verdad. La
primera vez que se ve un torneo se copian sus disciplinas, categorías y
categorías de edad a la base; a partir de ahí manda lo que el administrador
configure desde *Torneos → Disciplinas y Categorías*.

Para volver a alinear los torneos con el catálogo hay que subir
`CATALOG_REVISION` en `lib/tournament_config.js`. Mientras no cambie, el arranque
no toca la configuración de la base. Lo mismo aplica a
`ensure_official_tournaments` (sede y fechas) y a `ensure_roles` (asignación de
roles), cada uno con su propia revisión.

Las categorías que salen del catálogo pero tienen inscripciones **no se borran**:
quedan con `is_active = false`, se siguen viendo en las inscripciones ya hechas y
dejan de ofrecerse en el formulario. El administrador puede reactivarlas.

Los torneos oficiales se identifican por `tournaments.official_key`, así se
pueden renombrar desde el panel sin que el arranque los vuelva a crear.

## Pruebas

Las pruebas levantan un PostgreSQL real en proceso (PGlite), reproducen el estado
de producción, aplican las migraciones encima y recorren todas las pantallas. No
tocan ninguna base real.

```bash
npm test
```

Para revisar las pantallas a mano con datos de prueba:

```bash
npm run preview
```

y abrir `http://localhost:3100` (se puede cambiar de usuario con
`?como=profe`, `?como=admin` o `?como=ambos`).
