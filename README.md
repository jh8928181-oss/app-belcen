# app-belcen

Sistema de control de inventario y producción de la planta Belcen: registro de
guías de remisión, movimientos de almacén, producción, refinado y base de datos
de proveedores y órdenes de compra.

## Stack

- **Node.js** 18 o superior
- **Express 5** (CommonJS)
- **PostgreSQL** (`pg`) + **node-pg-migrate** para el esquema
- **Gemini API** para lectura de PDFs, con **Tesseract** como respaldo por OCR
- **Jest** para las pruebas, **ESLint 9** (formato plano) para el lint

## Puesta en marcha

```bash
npm install
cp .env.example .env    # y completar los valores
npm start
```

El servidor escucha en el puerto de `PORT` (3000 por defecto) y sirve el
frontend estático desde `public/`.

### `.env` vs `.env.local`

La base de datos activa se resuelve en este orden:

1. Variables ya presentes en el entorno del sistema.
2. `.env` — configuración compartida, normalmente la que documenta el despliegue.
3. `.env.local` — **tiene prioridad sobre `.env`**.

`.env.local` está en `.gitignore`. Úsalo para apuntar a otra base en tu
máquina sin editar el `.env` compartido, por ejemplo durante una migración de
proveedor:

```bash
echo 'DATABASE_URL=postgresql://usuario:clave@host:puerto/basedb' > .env.local
```

Si `.env.local` no existe, todo funciona igual usando solo `.env`.

### Variables de entorno

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `DATABASE_URL` | sí | Cadena de conexión de PostgreSQL. Si falta, `db.js` falla al importarse. |
| `TOKEN_SECRET` | sí | Secreto para firmar los tokens de sesión. Sin él se usa un valor de desarrollo inseguro. |
| `GEMINI_API_KEY` | no | Sin esta clave, la lectura de PDFs por IA se desactiva y queda solo el OCR. |
| `GEMINI_MODEL` | no | Modelo de Gemini a usar. |
| `PORT` | no | Puerto del servidor. Default `3000`. |
| `REDIS_URL` | no | Si está, el rate limiter usa Redis. Sin ella trabaja en memoria (se pierde al reiniciar). |
| `ENFORCE_ROLES` | no | Ver la sección de roles. |
| `SEED_PWD_*` | no | Contraseñas de los usuarios semilla. Solo desarrollo. |

## Base de datos

```bash
npm run migrate          # aplica las migraciones pendientes
npm run migrate:status   # muestra el estado
npm run migrate:down     # revierte la última
npm run migrate:create   # crea una migración nueva
```

## Usuarios de desarrollo

Los scripts de semilla se niegan a correr si `NODE_ENV=production`:

```bash
npm run seed:dev      # crea los usuarios con las SEED_PWD_* definidas
npm run create:users  # interactivo
```

En producción los usuarios se administran desde el panel, no con estos scripts.

## Autenticación y roles

El login es `POST /api/auth/login` y devuelve un token que se envía en
`Authorization: Bearer <token>` o en la cabecera `x-token`.

Los roles existentes son: `admin`, `supervisor`, `produccion`, `auditoria`,
`vigilancia`, `almacen`, `soplado`, `envasado`, `refinado` e `invitado`.

### Modo observación de roles

Cada ruta sensible tiene un guard de rol. Hay dos modos, según `ENFORCE_ROLES`:

- **`ENFORCE_ROLES` ausente o `false`** (default): los guards **no bloquean**.
  Registran en consola un aviso `[observa-roles]` con el usuario, su rol y la
  ruta, para medir el impacto antes de activarlos.
- **`ENFORCE_ROLES=true`**: los guards responden `403` cuando el rol no está en
  la lista de la ruta.

Este modo existe porque la matriz de roles por ruta se intestinea con el área
operativa. Actívalo solo cuando se haya validado que nadie legítimo pierde
acceso. Los guards que ya existían antes de este cambio (los de refinado, stock
de refinado y base de datos) se aplican siempre; `ENFORCE_ROLES` solo afecta a
los nuevos.

## Pruebas y lint

```bash
npm test              # pruebas unitarias
npm run test:coverage # con reporte de cobertura
npm run lint          # ESLint, falla también con warnings
npm run lint:fix      # autocorrige lo que se pueda
npm run check         # lint + pruebas
```

Las pruebas son **unitarias** y no levantan el servidor ni tocan la base de
datos: los módulos que dependen de `pg` se sustituyen con dobles. La cobertura
es **informativa**: no hay umbral que la haga fallar.

## Estructura

```
index.js            Servidor Express y las rutas de negocio heredadas
routes/             Rutas ya extraídas a módulos (auth, bd)
controllers/        Controladores (auth)
services/           Servicios externos (Gemini, rate limiter)
middleware/         Autenticación y guards de rol
utils/              Utilidades puras
scripts/            Semillas y utilidades de desarrollo
migrations/         Migraciones de node-pg-migrate
tests/              Pruebas unitarias
public/             Frontend estático
```

`index.js` todavía concentra la mayoría de las rutas de negocio. Los módulos de
`routes/`, `controllers/`, `services/`, `middleware/` y `utils/` son el destino
para las siguientes extracciones, y la razón de que existan `db.js` y los tests
unitarios.

## Notas de los parsers de PDF

La lectura de guías de remisión funciona con Tesseract (OCR) y, si hay
`GEMINI_API_KEY`, con Gemini. El parser reconoce el número de guía, el
remitente/destinatario, las direcciones de partida y llegada, y los productos
del catálogo con su cantidad. Aun así hay que revisar el resultado antes de
confirmarlo:

- El número de RUC y el nombre del destinatario se buscan con el patrón
  `REGISTRO [UÚ]?NICO DE CONTRIBUYENTES`, que acepta la palabra con y sin
  tilde. Si el PDF usa otra fórmula y no hay una etiqueta `RUC:` suelta, ambos
  campos salen vacíos.
- Las direcciones se separan por la **localidad final** (el último grupo tras
  un guion), que puede tener varias palabras: `JR. LAS BEGONIAS 123 - SAN
  MARTIN - LIMA` cierra bien. Si la localidad termina siendo un texto de
  varias palabras sin guion delante, la dirección se pegaría a la línea
  siguiente.
- La **medida del envase no se confunde con la cantidad**: antes de leer el
  número se borra el alias del producto (`B-1 X 200 ML`), y solo se toma la
  última cifra que queda. Si la fila no trae columna de cantidad, el item se
  devuelve con `cantidad: null` y una advertencia para que lo completes a
  mano, en lugar de asumir que eran las unidades.
- Una fila se reconoce aunque sea corta (`B-1 X 1 LT`), siempre que coincida
  con un producto del catálogo. El mínimo de longitud solo se usa para
  descartar líneas de ruido que no son productos.
- El parser solo reconoce los productos listados en `PRODUCTOS_PDF_KEYWORDS`.
  Un producto nuevo requiere añadir su alias ahí, y su clave en
  `PRODUCTOS_TERMINADOS_MAP`.

## Despliegue

El proyecto no incluye `Dockerfile`. En Render (o similar) hay que definir
como **Start Command** `node index.js`, no `npm start`, y configurar
`DATABASE_URL`, `TOKEN_SECRET` y `GEMINI_API_KEY` como secretos del entorno.
