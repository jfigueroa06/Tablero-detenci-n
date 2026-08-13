/**
 * /api/fotos — evidencia fotográfica en Azure Blob Storage
 *
 *   GET    /api/fotos?clave=<subtarea>        → lista las fotos de una subtarea
 *   POST   /api/fotos  {clave, nombre}        → devuelve una URL temporal para subir
 *   DELETE /api/fotos?ruta=<ruta>             → borra una foto
 *
 * Por qué Blob Storage y no Cosmos: una foto comprimida pesa 200-500 KB.
 * Guardarla en Cosmos consumiría del orden de 2.000 RU por escritura y
 * chocaría con el límite de 1.000 RU/s del nivel gratuito, provocando
 * errores de limitación. Blob Storage cuesta centavos y está hecho para esto.
 *
 * El navegador sube directo al blob usando una URL firmada de corta duración
 * (SAS). Así el archivo no pasa por la función, que tiene límite de tamaño
 * de petición y se cobraría por tiempo de ejecución.
 */

const {
  BlobServiceClient, StorageSharedKeyCredential,
  generateBlobSASQueryParameters, BlobSASPermissions
} = require('@azure/storage-blob');
const { respuesta, manejar } = require('../compartido/cosmos');

const CONEXION = process.env.STORAGE_CONNECTION_STRING;
const CONTENEDOR = process.env.STORAGE_CONTAINER || 'fotos';
const MINUTOS_VALIDEZ = 15;

function servicio(){
  if (!CONEXION) throw new Error('Falta la variable STORAGE_CONNECTION_STRING');
  return BlobServiceClient.fromConnectionString(CONEXION);
}

/** Extrae nombre y clave de la cadena de conexión para poder firmar las URL. */
function credencial(){
  const cuenta = /AccountName=([^;]+)/.exec(CONEXION);
  const clave  = /AccountKey=([^;]+(?:==)?)/.exec(CONEXION);
  if (!cuenta || !clave) throw new Error('La cadena de conexión de Storage no tiene el formato esperado');
  return new StorageSharedKeyCredential(cuenta[1], clave[1]);
}

/** Los nombres de archivo se sanean: la clave viene del navegador y no debe
 *  poder salirse de su carpeta ni introducir caracteres problemáticos. */
const limpiar = s => String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);

module.exports = manejar(async function (context, req){
  const contenedor = servicio().getContainerClient(CONTENEDOR);
  await contenedor.createIfNotExists({ access: 'blob' });   // lectura pública de las fotos

  // ── listar ────────────────────────────────────────────────────────────
  if (req.method === 'GET'){
    const clave = limpiar(req.query.clave);
    if (!clave) return respuesta(400, { error: 'Falta el parámetro «clave»' });

    const fotos = [];
    for await (const blob of contenedor.listBlobsFlat({ prefix: `${clave}/` })){
      fotos.push({
        ruta: blob.name,
        nombre: blob.name.split('/').pop(),
        url: `${contenedor.url}/${encodeURIComponent(blob.name).replace(/%2F/g, '/')}`,
        tamano: blob.properties.contentLength,
        at: blob.properties.createdOn
      });
    }
    fotos.sort((a, b) => String(b.nombre).localeCompare(String(a.nombre)));
    return respuesta(200, { clave, fotos });
  }

  // ── URL temporal para subir ───────────────────────────────────────────
  if (req.method === 'POST'){
    const { clave, nombre } = req.body || {};
    const c = limpiar(clave), n = limpiar(nombre);
    if (!c || !n) return respuesta(400, { error: 'Faltan «clave» o «nombre»' });

    const ruta = `${c}/${n}`;
    const expira = new Date(Date.now() + MINUTOS_VALIDEZ * 60 * 1000);
    const sas = generateBlobSASQueryParameters({
      containerName: CONTENEDOR,
      blobName: ruta,
      permissions: BlobSASPermissions.parse('cw'),   // crear y escribir, no leer ni borrar
      expiresOn: expira
    }, credencial()).toString();

    const base = `${contenedor.url}/${encodeURIComponent(ruta).replace(/%2F/g, '/')}`;
    return respuesta(200, { ruta, urlSubida: `${base}?${sas}`, urlPublica: base, expira });
  }

  // ── borrar ────────────────────────────────────────────────────────────
  if (req.method === 'DELETE'){
    const ruta = String(req.query.ruta || '');
    if (!ruta || ruta.includes('..')) return respuesta(400, { error: 'Ruta no válida' });
    const resultado = await contenedor.getBlockBlobClient(ruta).deleteIfExists();
    return respuesta(200, { ruta, borrada: resultado.succeeded });
  }

  return respuesta(405, { error: 'Método no permitido' });
});
