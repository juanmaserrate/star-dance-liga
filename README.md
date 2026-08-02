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
- **Módulo Administrador**: torneos, categorías, inscripciones, pagos, finanzas, CMS, usuarios, clubes, CSV export
- **Módulo Jueces**: planilla de juzgamiento por categoría
