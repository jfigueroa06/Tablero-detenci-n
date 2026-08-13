/**
 * POST /api/plan
 * Cuerpo: { planId, nombre, inicio, fin, estructura }
 *
 * Guarda la estructura del plan importado desde la carta Gantt.
 *
 * La estructura pesa cientos de KB (miles de subtareas), así que se guarda
 * como un único documento y solo se envía al navegador en la primera carga.
 * Cosmos DB admite documentos de hasta 2 MB; si un plan superara ese tamaño
 * habría que partirlo por área, pero un plan de ~1.000 tareas ronda los 400 KB.
 */

const { guardar, respuesta, manejar } = require('../compartido/cosmos');

const LIMITE_MB = 1.8;   // margen bajo el máximo real de 2 MB de Cosmos

module.exports = manejar(async function (context, req){
  const { planId, nombre, inicio, fin, estructura } = req.body || {};

  if (!planId)     return respuesta(400, { error: 'Falta planId' });
  if (!estructura) return respuesta(400, { error: 'Falta la estructura del plan' });

  const tamanoMB = Buffer.byteLength(JSON.stringify(estructura), 'utf8') / (1024 * 1024);
  if (tamanoMB > LIMITE_MB){
    return respuesta(413, {
      error: `El plan pesa ${tamanoMB.toFixed(1)} MB y el máximo por documento es ${LIMITE_MB} MB. ` +
             'Habría que dividirlo por área para poder guardarlo.'
    });
  }

  const doc = {
    id: `plan:${planId}`,
    planId, tipo: 'plan',
    nombre: nombre || 'Plan sin nombre',
    inicio: inicio || null,
    fin: fin || null,
    estructura,
    at: new Date().toISOString()
  };

  await guardar(doc);
  return respuesta(200, { planId, at: doc.at, tamanoMB: +tamanoMB.toFixed(2) });
});
