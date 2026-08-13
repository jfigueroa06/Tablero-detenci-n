/**
 * GET /api/estado?desde=<ISO>
 *
 * Devuelve TODO lo que cambió desde una marca de tiempo, en una sola llamada.
 *
 * Por qué una sola: el nivel gratuito de Azure Functions da 1 millón de
 * ejecuciones al mes. La versión anterior de este tablero hacía 5 consultas
 * cada 3 segundos por persona — unas 720.000 al día con 10 usuarios, que
 * agotaría la cuota en día y medio. Consolidando en un endpoint y consultando
 * cada 15 s, el consumo baja dos órdenes de magnitud.
 *
 * Sin `desde` devuelve el estado completo (primera carga).
 * Con `desde` devuelve solo las novedades (sincronización periódica).
 */

const { consultar, respuesta, manejar } = require('../compartido/cosmos');

module.exports = manejar(async function (context, req){
  const desde = req.query.desde || null;

  // El plan vive en un documento único por detención. Se busca el más reciente:
  // así, si se cargó una detención nueva, el cliente la detecta solo.
  const planes = await consultar(
    'SELECT TOP 1 * FROM c WHERE c.tipo = @t ORDER BY c.at DESC',
    [{ name: '@t', value: 'plan' }]
  );

  if (!planes.length){
    return respuesta(200, { plan: null, planId: null, marcas: [], duenos: [], cambios: [], comentarios: [], log: [] });
  }

  const doc = planes[0];
  const planId = doc.planId;

  // Filtro incremental: solo lo modificado después de `desde`.
  const filtroFecha = desde ? ' AND c.at > @desde' : '';
  const params = [{ name: '@p', value: planId }];
  if (desde) params.push({ name: '@desde', value: desde });

  const traer = tipo => consultar(
    `SELECT * FROM c WHERE c.planId = @p AND c.tipo = @tipo${filtroFecha}`,
    [...params, { name: '@tipo', value: tipo }]
  );

  const [marcas, duenos, cambios, comentarios] = await Promise.all([
    traer('marca'), traer('dueno'), traer('cambio'), traer('comentario')
  ]);

  // La bitácora se limita: solo interesan los eventos recientes para el panel
  // en vivo. Los informes de turno la consultan aparte, por rango de fechas.
  const log = await consultar(
    `SELECT TOP 40 * FROM c WHERE c.planId = @p AND c.tipo = 'log'${filtroFecha} ORDER BY c.at DESC`,
    params
  );

  return respuesta(200, {
    plan: doc.estructura,
    planId,
    cargadoEn: doc.at,
    // Solo se envía la estructura completa en la primera carga: pesa cientos de
    // KB y no cambia entre sincronizaciones.
    incluyeEstructura: !desde,
    marcas: marcas.map(m => ({ key: m.clave, status: m.estado, pct: m.pct, who: m.quien, at: m.at })),
    duenos: duenos.map(d => ({ pk: d.clave, name: d.nombre, who: d.quien, at: d.at })),
    cambios: cambios.map(c => ({
      key: c.clave, nueva: c.nueva, eliminada: c.eliminada, nombre: c.nombre,
      pk: c.pk, starts_at: c.inicio, ends_at: c.fin, who: c.quien, at: c.at
    })),
    comentarios: comentarios.map(c => ({ key: c.clave, id: c.comentarioId, txt: c.texto, who: c.quien, at: c.at })),
    log: log.map(l => ({ id: l.id, who: l.quien, txt: l.texto, at: l.at }))
  });
});
