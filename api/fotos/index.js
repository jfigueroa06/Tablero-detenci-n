/**
 * /api/fotos — evidencia fotográfica en Azure Blob Storage
 *
 *   GET    /api/fotos?clave=<subtarea>              → lista las fotos, con un link temporal cada una
 *   POST   /api/fotos  {clave, nombre, planId}       → devuelve una URL temporal para subir
 *   DELETE /api/fotos?ruta=<ruta>                    → borra una foto
 *
 * El contenedor se crea SIN acceso público (ver la nota de más abajo).
 *
 * Además de subir el archivo, cada foto queda indexada como un documento
 * liviano en Cosmos: {tipo:'foto', planId, ruta}. No guarda la imagen —
 * solo su ubicación — pero permite que /api/limpiar sepa qué fotos borrar
 * de una detención sin tener que revisar subtarea por subtarea (con miles
 * de subtareas, eso significaría miles de invocaciones solo para encontrar
 * las pocas que sí tienen foto).
 */

const {
  BlobServiceClient, StorageSharedKeyCredential,
  generateBlobSASQueryParameters, BlobSASPermissions
} = require('@azure/storage-blob');
const { guardar, borrar, respuesta, manejar } = require('../compartido/cosmos');

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

/* El id de un documento en Cosmos no admite «/», así que la ruta del blob
   (que sí los lleva) se codifica al usarla como id. */
const idFoto = ruta => `foto:${encodeURIComponent(ruta)}`;

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
  // bloqueado por política de la organización (ver el aviso que resolvió
  // el error «Public access is not permitted on this storage account»).
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
    const { clave, nombre, planId } = req.body || {};
    const c = limpiar(clave), n = limpiar(nombre);
    if (!c || !n) return respuesta(400, { error: 'Faltan «clave» o «nombre»' });

    const ruta = `${c}/${n}`;

    // Se indexa aunque la subida real todavía no ocurra (el navegador la hace
    // después, directo al almacenamiento): en el peor caso, si la subida
    // fallara, queda un registro de una foto que no existe, y borrarla más
    // tarde es una operación silenciosa que no hace daño. Lo importante es
    // no perder el registro de las que sí se suben.
    if (planId){
      await guardar({ id: idFoto(ruta), planId, tipo: 'foto', ruta, clave: c, at: new Date().toISOString() });
    }

    return respuesta(200, {
      ruta,
      urlSubida: firmar(ruta, 'cw', MINUTOS_SUBIDA),
      expira: new Date(Date.now() + MINUTOS_SUBIDA * 60 * 1000)
    });
  }

  // ── borrar ────────────────────────────────────────────────────────────
  if (req.method === 'DELETE'){
    const ruta = String(req.query.ruta || '');
    const planId = req.query.planId || null;
    if (!ruta || ruta.includes('..')) return respuesta(400, { error: 'Ruta no válida' });
    const resultado = await contenedor.getBlockBlobClient(ruta).deleteIfExists();
    if (planId) await borrar(idFoto(ruta), planId).catch(() => {});   // limpiar el índice, sin bloquear si falla
    return respuesta(200, { ruta, borrada: resultado.succeeded });
  }

  return respuesta(405, { error: 'Método no permitido' });
});
