/**
 * Acceso compartido a Cosmos DB.
 *
 * Diseño: UN solo contenedor para todo, con clave de partición /planId.
 *   - Mantiene el consumo dentro del nivel gratuito (1.000 RU/s compartidos).
 *   - Toda consulta filtra por planId, así que las detenciones quedan aisladas
 *     por diseño, no por disciplina al escribir cada consulta.
 *
 * Los documentos se distinguen por el campo `tipo`:
 *   plan | marca | dueno | cambio | log
 */

const { CosmosClient } = require('@azure/cosmos');

const CONEXION = process.env.COSMOS_CONNECTION_STRING;
const BD = process.env.COSMOS_DATABASE || 'tablero';
const CONTENEDOR = process.env.COSMOS_CONTAINER || 'datos';

let _contenedor = null;

/** El cliente se crea una sola vez por instancia y se reutiliza entre
 *  invocaciones: crearlo en cada llamada agrega latencia y consume conexiones. */
function contenedor(){
  if (_contenedor) return _contenedor;
  if (!CONEXION) throw new Error('Falta la variable COSMOS_CONNECTION_STRING');
  const cliente = new CosmosClient(CONEXION);
  _contenedor = cliente.database(BD).container(CONTENEDOR);
  return _contenedor;
}

/** Ejecuta una consulta parametrizada. Nunca concatenar valores en el texto
 *  de la consulta: los parámetros evitan inyección. */
async function consultar(query, parameters = []){
  const { resources } = await contenedor().items.query({ query, parameters }).fetchAll();
  return resources;
}

/** Inserta o reemplaza un documento. */
async function guardar(doc){
  const { resource } = await contenedor().items.upsert(doc);
  return resource;
}

/** Inserta o reemplaza varios documentos.
 *  Se hace en tandas para no saturar el límite de RU/s del nivel gratuito:
 *  un lote grande de golpe provoca error 429 (demasiadas solicitudes). */
async function guardarVarios(docs, tanda = 20){
  const hechos = [];
  for (let i = 0; i < docs.length; i += tanda){
    const lote = docs.slice(i, i + tanda);
    const res = await Promise.allSettled(lote.map(d => guardar(d)));
    res.forEach(r => { if (r.status === 'fulfilled') hechos.push(r.value); });
  }
  return hechos;
}

async function borrar(id, planId){
  try {
    await contenedor().item(id, planId).delete();
    return true;
  } catch (e){
    if (e.code === 404) return false;   // ya no existe: no es un error
    throw e;
  }
}

/** Respuesta HTTP uniforme, con los encabezados que el navegador necesita. */
function respuesta(status, body){
  return {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: body === undefined ? null : body
  };
}

/** Envuelve un manejador para que cualquier error devuelva JSON legible en vez
 *  de una página de error genérica, y quede registrado en el log de Azure. */
function manejar(fn){
  return async function (context, req){
    try {
      context.res = await fn(context, req);
    } catch (e){
      context.log.error('Fallo en la función:', e);
      context.res = respuesta(500, {
        error: e.message || 'Error inesperado',
        detalle: e.code || null
      });
    }
  };
}

module.exports = { consultar, guardar, guardarVarios, borrar, respuesta, manejar, contenedor };
