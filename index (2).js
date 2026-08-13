/**
 * POST /api/limpiar
 * Cuerpo: { planId }
 *
 * Borra de forma permanente todo lo asociado a una detención anterior:
 * plan, marcas, dueños, cambios y bitácora. Las fotos se borran aparte
 * (viven en Blob Storage, no en Cosmos).
 *
 * Es una operación destructiva e irreversible: el navegador debe pedir
 * confirmación explícita antes de llamarla.
 *
 * Se borra en tandas porque el nivel gratuito comparte 1.000 RU/s: intentar
 * eliminar miles de documentos de golpe provoca error 429 (limitación por
 * exceso de solicitudes) y la operación queda a medias.
 */

const { consultar, borrar, respuesta, manejar } = require('../compartido/cosmos');

const TANDA = 25;

module.exports = manejar(async function (context, req){
  const { planId } = req.body || {};
  if (!planId) return respuesta(400, { error: 'Falta planId' });

  const docs = await consultar(
    'SELECT c.id FROM c WHERE c.planId = @p',
    [{ name: '@p', value: planId }]
  );

  let borrados = 0, fallidos = 0;
  for (let i = 0; i < docs.length; i += TANDA){
    const lote = docs.slice(i, i + TANDA);
    const res = await Promise.allSettled(lote.map(d => borrar(d.id, planId)));
    res.forEach(r => { r.status === 'fulfilled' ? borrados++ : fallidos++; });
  }

  context.log(`Limpieza de ${planId}: ${borrados} borrados, ${fallidos} fallidos`);
  return respuesta(200, { planId, borrados, fallidos, total: docs.length });
});
