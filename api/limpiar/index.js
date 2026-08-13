/**
 * POST /api/limpiar
 * Cuerpo: { planId }
 *
 * Borra de forma permanente todo lo asociado a una detención anterior:
 * plan, marcas, dueños, cambios, bitácora — y las fotos.
 *
 * Las fotos viven en Blob Storage, no en Cosmos, así que no basta con borrar
 * documentos. Para saber cuáles borrar sin tener que revisar subtarea por
 * subtarea (con miles de subtareas, eso son miles de invocaciones para
 * encontrar las pocas que sí tienen foto), se usa el índice liviano que
 * /api/fotos escribe en Cosmos cada vez que alguien sube una: un documento
 * {tipo:'foto', planId, ruta} por cada archivo. Aquí basta con consultar
 * esos índices — ya vienen en la misma consulta que trae todo lo demás.
 *
 * Es una operación destructiva e irreversible: el navegador debe pedir
 * confirmación explícita antes de llamarla.
 *
 * Se borra en tandas porque el nivel gratuito comparte 1.000 RU/s: intentar
 * eliminar miles de documentos de golpe provoca error 429 (limitación por
 * exceso de solicitudes) y la operación queda a medias.
 */

const { consultar, borrar, respuesta, manejar } = require('../compartido/cosmos');
const { BlobServiceClient } = require('@azure/storage-blob');

const TANDA = 25;
const CONEXION = process.env.STORAGE_CONNECTION_STRING;
const CONTENEDOR = process.env.STORAGE_CONTAINER || 'fotos';

async function borrarEnTandas(items, borrarUno){
  let ok = 0, fallidos = 0;
  for (let i = 0; i < items.length; i += TANDA){
    const lote = items.slice(i, i + TANDA);
    const res = await Promise.allSettled(lote.map(borrarUno));
    res.forEach(r => { r.status === 'fulfilled' ? ok++ : fallidos++; });
  }
  return { ok, fallidos };
}

module.exports = manejar(async function (context, req){
  const { planId } = req.body || {};
  if (!planId) return respuesta(400, { error: 'Falta planId' });

  const docs = await consultar(
    'SELECT c.id, c.tipo, c.ruta FROM c WHERE c.planId = @p',
    [{ name: '@p', value: planId }]
  );

  // ── fotos: borrar los archivos del almacenamiento ──────────────────────
  const fotos = docs.filter(d => d.tipo === 'foto' && d.ruta);
  let fotosBorradas = 0, fotosFallidas = 0;
  if (fotos.length && CONEXION){
    try {
      const contenedor = BlobServiceClient.fromConnectionString(CONEXION).getContainerClient(CONTENEDOR);
      const r = await borrarEnTandas(fotos, async f => {
        const res = await contenedor.getBlockBlobClient(f.ruta).deleteIfExists();
        if (!res.succeeded) throw new Error('no se pudo borrar ' + f.ruta);
      });
      fotosBorradas = r.ok; fotosFallidas = r.fallidos;
    } catch (e){
      context.log.error('Fallo borrando fotos:', e.message);
    }
  }

  // ── documentos de Cosmos: plan, marcas, dueños, cambios, log, índice de fotos ──
  const r = await borrarEnTandas(docs, d => borrar(d.id, planId));

  context.log(`Limpieza de ${planId}: ${r.ok} documentos, ${fotosBorradas} fotos, ${r.fallidos + fotosFallidas} fallos`);
  return respuesta(200, {
    planId,
    borrados: r.ok, fallidos: r.fallidos, total: docs.length,
    fotosBorradas, fotosFallidas
  });
});
