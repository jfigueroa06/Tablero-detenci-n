/**
 * /api/fotos — evidencia fotográfica en Azure Blob Storage
 *
 *   GET    /api/fotos?clave=<subtarea>        → lista las fotos, con un link temporal cada una
 *   POST   /api/fotos  {clave, nombre}        → devuelve una URL temporal para subir
 *   DELETE /api/fotos?ruta=<ruta>             → borra una foto
 *
 * El contenedor se crea SIN acceso público. Ni para subir ni para ver una
 * foto existe una URL permanente que funcione para cualquiera — todo pasa
 * por un link firmado de corta duración, generado aquí. Es más trabajo que
 * dejar el contenedor público, pero evita dos problemas reales:
 *   1) Algunas organizaciones bloquean el acceso público por política de
 *      Azure; el interruptor de la cuenta puede parecer activado y no
 *      surtir efecto. Este diseño no depende de esa política en absoluto.
 *   2) Son fotos de la planta: no hay razón para que sean legibles por
 *      cualquiera con el link, indefinidamente.
 */

const {
  BlobServiceClient, StorageSharedKeyCredential,
  generateBlobSASQueryParameters, BlobSASPermissions
} = require('@azure/storage-blob');
const { respuesta, manejar } = require('../compartido/cosmos');

const CONEXION = process.env.STORAGE_CONNECTION_STRING;
const CONTENEDOR = process.env.STORAGE_CONTAINER || 'fotos';
const MINUTOS_SUBIDA = 15;
const HORAS_LECTURA = 12;   // dura un turno completo, para no regenerar a cada rato

function servicio(){
  if (!CONEXION) throw new Error('Falta la variable STORAGE_CONNECTION_STRING');
  return BlobServiceClient.fromConnectionString(CONEXION);
}

function credencial(){
  const cuenta = /AccountName=([^;]+)/.exec(CONEXION);
  const clave  = /AccountKey=([^;]+(?:==)?)/.exec(CONEXION);
  if (!cuenta || !clave) throw new Error('La cadena de conexión de Storage no tiene el formato esperado');
  return new StorageSharedKeyCredential(cuenta[1], clave[1]);
}

const limpiar = s => String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);

function firmar(ruta, permisos, minutos){
  const sas = generateBlobSASQueryParameters({
    containerName: CONTENEDOR,
    blobName: ruta,
    permissions: BlobSASPermissions.parse(permisos),
    expiresOn: new Date(Date.now() + minutos * 60 * 1000)
  }, credencial()).toString();
  return `${servicio().getContainerClient(CONTENEDOR).url}/${encodeURIComponent(ruta).replace(/%2F/g,'/')}?${sas}`;
}

module.exports = manejar(async function (context, req){
  const contenedor = servicio().getContainerClient(CONTENEDOR);
  // sin «access»: el contenedor queda privado. No requiere ningún permiso
  // especial de la cuenta, así que funciona aunque el acceso público esté
  // bloqueado por política de la organización.
  await contenedor.createIfNotExists();

  // ── listar ────────────────────────────────────────────────────────────
  if (req.method === 'GET'){
    const clave = limpiar(req.query.clave);
    if (!clave) return respuesta(400, { error: 'Falta el parámetro «clave»' });

    const fotos = [];
    for await (const blob of contenedor.listBlobsFlat({ prefix: `${clave}/` })){
      fotos.push({
        ruta: blob.name,
        nombre: blob.name.split('/').pop(),
        url: firmar(blob.name, 'r', HORAS_LECTURA * 60),   // link de lectura, temporal
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
    return respuesta(200, {
      ruta,
      urlSubida: firmar(ruta, 'cw', MINUTOS_SUBIDA),
      expira: new Date(Date.now() + MINUTOS_SUBIDA * 60 * 1000)
    });
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
