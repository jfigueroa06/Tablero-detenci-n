/**
 * POST /api/guardar
 * Cuerpo: { planId, tipo, items: [...] }
 *
 * Un solo endpoint para las cuatro escrituras del tablero (marcas, dueños,
 * cambios al plan y bitácora), en vez de una función por cada una. Menos
 * funciones significa menos arranques en frío y menos consumo de la cuota.
 *
 * Todas las escrituras son idempotentes: el mismo elemento enviado dos veces
 * queda igual, no duplicado. Eso permite que el cliente reintente sin riesgo.
 */

const { guardarVarios, respuesta, manejar } = require('../compartido/cosmos');

const TIPOS = {
  // cada tipo declara cómo construir el id del documento a partir del elemento.
  // marca / dueno / cambio: un solo valor vigente por clave — guardar de nuevo
  // pisa el anterior, por eso el id depende solo de la clave.
  marca:  it => `marca:${it.key}`,
  dueno:  it => `dueno:${it.pk}`,
  cambio: it => `cambio:${it.key}`,
  log:    () => `log:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
  // comentario: una tarea puede tener varios en el tiempo, así que el id
  // depende del comentario mismo (generado en el navegador), no de la clave —
  // si dependiera solo de la clave, cada comentario nuevo borraría al anterior.
  comentario: it => `comentario:${it.id}`
};

/** Traduce el formato que envía el navegador al que se guarda en Cosmos.
 *  Se mantienen nombres en español en la base y se traduce en la frontera,
 *  para no arrastrar el vocabulario de la implementación anterior. */
function aDocumento(tipo, it, planId, ahora){
  const base = { id: TIPOS[tipo](it), planId, tipo, at: ahora, quien: it.who || 'Anónimo' };
  if (tipo === 'marca')
    return { ...base, clave: it.key, estado: it.status, pct: it.pct ?? null };
  if (tipo === 'dueno')
    return { ...base, clave: it.pk, nombre: it.name || '' };
  if (tipo === 'cambio')
    return { ...base, clave: it.key, nueva: !!it.nueva, eliminada: !!it.eliminada,
             nombre: it.nombre ?? null, pk: it.pk ?? null,
             inicio: it.starts_at ?? null, fin: it.ends_at ?? null };
  if (tipo === 'comentario')
    return { ...base, clave: it.key, comentarioId: it.id, texto: String(it.txt || '').slice(0, 500) };
  return { ...base, texto: it.txt || '' };   // log
}

module.exports = manejar(async function (context, req){
  const { planId, tipo, items } = req.body || {};

  if (!planId)            return respuesta(400, { error: 'Falta planId' });
  if (!TIPOS[tipo])       return respuesta(400, { error: `Tipo no reconocido: ${tipo}` });
  if (!Array.isArray(items) || !items.length)
    return respuesta(400, { error: 'Se esperaba un arreglo «items» con al menos un elemento' });
  if (items.length > 2000)
    return respuesta(400, { error: 'Demasiados elementos en una sola llamada (máximo 2000)' });

  const ahora = new Date().toISOString();
  const docs = items.map(it => aDocumento(tipo, it, planId, ahora));
  const hechos = await guardarVarios(docs);

  return respuesta(200, { guardados: hechos.length, de: docs.length, at: ahora });
});
