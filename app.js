// CALM B2B — Lógica de la PWA (v0.3: Agenda + recordatorios + memoria Pipedrive)
'use strict';

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.CALM_CONFIG;
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---- Helpers ----
const $ = (id) => document.getElementById(id);
const clp = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CL');
// Con Bsale en vivo, "meses sin comprar" se calcula contra HOY.
const CORTE = new Date();
const MESES_ES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

function mesesSinComprar(f) { return f ? Math.round((CORTE - new Date(f)) / 2592e6) : null; }

// El estado se calcula SIEMPRE contra hoy, nunca se lee de la base: así un cliente
// que se enfría aparece solo en "Recuperar" sin que nadie tenga que recalcular nada.
// Cortes acordados: al día <90 días · dormido 90-180 · perdido >180.
function clasificar(fechaUltimaCompra) {
  if (!fechaUltimaCompra) return 'prospecto';
  const dias = (CORTE - new Date(fechaUltimaCompra)) / 86400000;
  if (dias < 90) return 'activo';
  if (dias < 180) return 'dormido';
  return 'perdido';
}
function mesCorto(f) {
  if (!f) return '—';
  const d = new Date(f);
  return MESES_ES[d.getUTCMonth()] + ' ' + String(d.getUTCFullYear()).slice(2);
}
function fechaCorta(f) {
  const d = new Date(f);
  return d.getDate() + ' ' + MESES_ES[d.getMonth()];
}
function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function toast(txt) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = txt;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

let EMPRESAS = [];
let PENDIENTES = [];
let FILTRO = 'recuperar';
let BUSCA = '';
let CANAL = '';   // filtro por canal en Todos/Prospectos ('' = todos)
const CANAL_LBL = {
  hoteleria_turismo: '🏨 Hotelería', moteles: '🏩 Motel',
  instituciones: '🏛️ Institución', empresas_wellness: '🏢 Wellness',
};
// Título a mostrar: nombre comercial (fantasía) si existe, si no la razón social.
const nombreMostrar = (e) => (e && (e.nombre_fantasia || e.nombre)) || '';

// ==================== AUTH ====================
let modoSignup = false;

$('li-toggle').onclick = (e) => {
  e.preventDefault();
  modoSignup = !modoSignup;
  $('li-btn').textContent = modoSignup ? 'Crear cuenta' : 'Entrar';
  $('li-toggle-txt').textContent = modoSignup ? '¿Ya tienes cuenta? ' : '¿Primera vez? ';
  $('li-toggle').textContent = modoSignup ? 'Entrar' : 'Crear cuenta';
  $('li-msg').classList.add('hidden');
};

$('li-btn').onclick = async () => {
  const email = $('li-email').value.trim();
  const pass = $('li-pass').value;
  if (!email || !pass) { showMsg('Escribe tu correo y contraseña', 'err'); return; }
  $('li-btn').disabled = true;
  try {
    if (modoSignup) {
      const { error } = await sb.auth.signUp({ email, password: pass });
      if (error) throw error;
      showMsg('Cuenta creada ✓ Revisa tu correo para confirmarla y luego entra.', 'ok');
      modoSignup = false; $('li-btn').textContent = 'Entrar';
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password: pass });
      if (error) throw error;
    }
  } catch (err) {
    showMsg(traducirError(err.message), 'err');
  } finally {
    $('li-btn').disabled = false;
  }
};

function showMsg(t, tipo) {
  const m = $('li-msg');
  m.textContent = t; m.className = 'msg ' + tipo; m.classList.remove('hidden');
}
function traducirError(m) {
  if (/invalid login/i.test(m)) return 'Correo o contraseña incorrectos';
  if (/not confirmed/i.test(m)) return 'Tu correo aún no está confirmado. Revisa tu bandeja.';
  if (/already registered/i.test(m)) return 'Ese correo ya tiene cuenta. Usa "Entrar".';
  if (/at least 6/i.test(m)) return 'La contraseña debe tener al menos 6 caracteres';
  return m;
}

$('logout').onclick = () => sb.auth.signOut();

sb.auth.onAuthStateChange((_e, session) => {
  if (session) {
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    cargar();
  } else {
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
  }
});

// ==================== DATA ====================
// Trae TODAS las empresas paginando (Supabase devuelve máx 1.000 por consulta).
async function cargarEmpresas() {
  const cols = 'id,rut,nombre,nombre_fantasia,razon_social,grupo_relacionados,tipo_cliente,canal,telefono,email,comentario,direccion,comuna,camas,habitaciones,giro,monto_total_hist_clp,cantidad_compras,fecha_ultima_compra';
  const PAG = 1000; let desde = 0; const todo = [];
  for (;;) {
    const { data, error } = await sb.from('empresas').select(cols)
      .order('monto_total_hist_clp', { ascending: false, nullsFirst: false })
      .range(desde, desde + PAG - 1);
    if (error) return { error };
    todo.push(...data);
    if (data.length < PAG) break;
    desde += PAG;
  }
  return { data: todo };
}

async function cargar() {
  const [emp, acc] = await Promise.all([
    cargarEmpresas(),
    sb.from('acciones')
      .select('id,empresa_id,tipo,titulo,fecha_programada,prioridad')
      .eq('estado', 'pendiente')
      .order('fecha_programada'),
  ]);
  if (emp.error) {
    $('list').innerHTML = `<div class="empty"><div class="ico">⚠️</div>No pude cargar los clientes.<br>${escapeHtml(emp.error.message)}</div>`;
    return;
  }
  EMPRESAS = emp.data.map(e => ({
    ...e,
    meses: mesesSinComprar(e.fecha_ultima_compra),
    tipo_cliente: clasificar(e.fecha_ultima_compra),
  }));
  PENDIENTES = acc.data || [];
  render();
  renderHeaderMeta();
}

// Meta del mes en el header — visible siempre
async function renderHeaderMeta() {
  const el = $('h-meta');
  const { data, error } = await sb.from('v_meta_cumplimiento').select('*');
  if (error || !data) { el.innerHTML = ''; return; }
  const hoy = new Date();
  const m = data.find(x => x.anio === hoy.getFullYear() && x.mes === hoy.getMonth() + 1);
  if (!m) { el.innerHTML = ''; return; }
  const MESES_L = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const meta = Number(m.meta), real = Number(m.real);
  const pct = meta > 0 ? Math.round(100 * real / meta) : 0;
  const diasMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
  const proy = hoy.getDate() > 0 ? Math.round(real / hoy.getDate() * diasMes) : real;
  const pctProy = meta > 0 ? Math.round(100 * proy / meta) : 0;
  const col = pctProy >= 90 ? 'var(--olive)' : pctProy >= 60 ? '#e0b552' : '#e08a7a';
  el.innerHTML = `
    <div class="h-meta-top">
      <div class="h-meta-lbl">🎯 Meta ${MESES_L[hoy.getMonth()+1]}: <b>${clp(real)}</b> de ${clp(meta)}</div>
      <div class="h-meta-pct" style="color:${col}">${pct}%</div>
    </div>
    <div class="h-meta-bar-wrap">
      <div class="h-meta-bar proj" style="width:${Math.min(100,pctProy)}%;background:${col}"></div>
      <div class="h-meta-bar" style="width:${Math.min(100,pct)}%;background:${col}"></div>
    </div>
    <div class="h-meta-foot">Día ${hoy.getDate()} de ${diasMes} · Proyección: ${clp(proy)} (${pctProy}%)</div>`;
}

function grupos() {
  return {
    rec: EMPRESAS.filter(e => e.tipo_cliente === 'dormido' || e.tipo_cliente === 'perdido'),
    act: EMPRESAS.filter(e => e.tipo_cliente === 'activo'),
  };
}

function render() {
  const { rec, act } = grupos();
  const totalRec = rec.reduce((s, e) => s + Number(e.monto_total_hist_clp || 0), 0);
  $('kpi-monto').textContent = clp(totalRec);
  $('kpi-foot').textContent = `${rec.length} clientes que dejaron de comprar`;
  $('n-recuperar').textContent = rec.length;
  $('n-activo').textContent = act.length;
  $('n-agenda').textContent = PENDIENTES.length;
  $('n-todos').textContent = EMPRESAS.length;
  const pros = EMPRESAS.filter(e => e.tipo_cliente === 'prospecto');
  if ($('n-prospecto')) $('n-prospecto').textContent = pros.length;

  // Mostrar/ocultar contenedores según pestaña
  const esAnalisis = FILTRO === 'analisis';
  $('analisis').classList.toggle('hidden', !esAnalisis);
  $('list').classList.toggle('hidden', esAnalisis);
  $('kpi').classList.toggle('hidden', esAnalisis);
  document.querySelector('.search-wrap').classList.toggle('hidden', esAnalisis);
  // Chips de canal: solo en Todos y Prospectos
  const conCanal = FILTRO === 'todos' || FILTRO === 'prospecto';
  if ($('canal-chips')) $('canal-chips').classList.toggle('hidden', !conCanal);
  if (esAnalisis) { renderAnalisis(); return; }

  if (FILTRO === 'agenda') { renderAgenda(); return; }

  let items;
  if (BUSCA) {
    // Búsqueda GLOBAL: busca en TODA la base (clientes + prospectos), sin importar la pestaña.
    const q = BUSCA.toLowerCase();
    items = EMPRESAS.filter(e =>
      (e.nombre_fantasia || '').toLowerCase().includes(q) ||
      (e.nombre || '').toLowerCase().includes(q) ||
      (e.razon_social || '').toLowerCase().includes(q) ||
      (e.grupo_relacionados || '').toLowerCase().includes(q) ||
      (e.rut || '').includes(q) ||
      (e.comuna || '').toLowerCase().includes(q));
  } else {
    items = FILTRO === 'recuperar' ? rec
          : FILTRO === 'activo' ? act
          : FILTRO === 'prospecto' ? pros
          : EMPRESAS;
    if (conCanal && CANAL) items = items.filter(e => e.canal === CANAL);
  }
  // Prospectos se ordenan por nombre; el resto por plata
  items = FILTRO === 'prospecto'
    ? items.slice().sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
    : items.slice().sort((a, b) => Number(b.monto_total_hist_clp) - Number(a.monto_total_hist_clp));

  const cont = $('list');
  if (!items.length) {
    cont.innerHTML = BUSCA
      ? `<div class="empty"><div class="ico">🔍</div>No encontré "${escapeHtml(BUSCA)}"</div>`
      : `<div class="empty"><div class="ico">🎉</div>Nada por aquí.</div>`;
    return;
  }

  // Tope de render (rendimiento): con miles de fichas no se pintan todas de una
  const TOPE = 200;
  const total = items.length;
  const visibles = items.slice(0, TOPE);
  let hint = '';
  if (BUSCA) hint = `<div class="hint">🔎 ${total} resultado${total===1?'':'s'} en toda la base (clientes y prospectos).</div>`;
  else if (FILTRO === 'recuperar') hint = `<div class="hint">Ordenados por lo que más plata dejaron. Parte por arriba 👇</div>`;
  else if (FILTRO === 'prospecto') hint = `<div class="hint">Prospectos de Pipedrive — aún no te han comprado (${total}).</div>`;
  const masNota = total > TOPE
    ? `<div class="hint" style="margin-top:10px">Mostrando ${TOPE} de ${total}. Usa el buscador 🔍 o filtra por canal para acotar.</div>` : '';
  cont.innerHTML = hint + visibles.map(cardHTML).join('') + masNota;
  wireCards(cont);
}

function wireCards(cont) {
  cont.querySelectorAll('[data-ficha]').forEach(el => el.onclick = () => abrirFicha(el.dataset.ficha));
  cont.querySelectorAll('[data-anotar]').forEach(b => b.onclick = (ev) => { ev.stopPropagation(); abrirResultado(b.dataset.anotar); });
  cont.querySelectorAll('[data-addtel]').forEach(b => b.onclick = (ev) => { ev.stopPropagation(); abrirTel(b.dataset.addtel); });
  cont.querySelectorAll('[data-call]').forEach(a => a.onclick = (ev) => {
    ev.stopPropagation();
    const id = a.dataset.call;
    setTimeout(() => abrirResultado(id), 1200);
  });
}

function lineaEstado(e) {
  if (e.tipo_cliente === 'prospecto') return `<span style="color:var(--teal);font-weight:600">🧭 ${CANAL_LBL[e.canal] || 'Prospecto'}</span>`;
  if (e.tipo_cliente === 'activo') return `<span class="ok">✓ Compró hace poco</span> (${mesCorto(e.fecha_ultima_compra)})`;
  if (e.meses == null) return 'Sin compras registradas';
  const clase = e.tipo_cliente === 'perdido' ? 'alerta' : 'alerta suave';
  return `<span class="${clase}">⚠️ Hace ${e.meses} meses que no compra</span>`;
}

function cardHTML(e) {
  const telLimpio = (e.telefono || '').replace(/[^\d+]/g, '');
  const btnLlamar = e.telefono
    ? `<a class="btn btn-call" href="tel:${telLimpio}" data-call="${e.id}">📞 Llamar</a>`
    : `<button class="btn btn-tel-add" data-addtel="${e.id}">➕ Poner teléfono</button>`;
  const memo = e.comentario ? `<div class="c-memo">📌 ${escapeHtml(e.comentario.slice(0, 90))}${e.comentario.length > 90 ? '…' : ''}</div>` : '';
  const infoMonto = e.tipo_cliente === 'prospecto'
    ? ''
    : `<div class="c-monto">Nos ha comprado <b>${clp(e.monto_total_hist_clp)}</b> en total</div>`;
  return `
  <div class="card ${e.tipo_cliente}">
    <div class="c-tap" data-ficha="${e.id}">
      <div class="c-top">
        <div class="c-name">${escapeHtml(nombreMostrar(e))}</div>
        <div class="c-ver">Ver ficha ›</div>
      </div>
      <div class="c-line">${lineaEstado(e)}</div>
      ${infoMonto}
      ${memo}
    </div>
    <div class="c-actions">
      ${btnLlamar}
      <button class="btn btn-note" data-anotar="${e.id}">✍️ Anotar</button>
    </div>
  </div>`;
}

// ==================== AGENDA ====================
function renderAgenda() {
  const cont = $('list');
  if (!PENDIENTES.length) {
    cont.innerHTML = `<div class="empty"><div class="ico">🌴</div>No tienes tareas pendientes.<br>
      <span style="font-size:13px">Se crean solas cuando anotas una llamada,<br>o con "⏰ Recordarme" en la ficha de un cliente.</span></div>`;
    return;
  }
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  const manana = new Date(hoy); manana.setDate(manana.getDate() + 1);
  const finSemana = new Date(hoy); finSemana.setDate(finSemana.getDate() + (7 - finSemana.getDay() || 7));
  const finMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 1);

  const grupos = { atrasadas: [], hoy: [], semana: [], mes: [], despues: [] };
  for (const a of PENDIENTES) {
    const f = new Date(a.fecha_programada);
    if (f < hoy) grupos.atrasadas.push(a);
    else if (f < manana) grupos.hoy.push(a);
    else if (f < finSemana) grupos.semana.push(a);
    else if (f < finMes) grupos.mes.push(a);
    else grupos.despues.push(a);
  }
  const nombres = Object.fromEntries(EMPRESAS.map(e => [e.id, nombreMostrar(e)]));
  const seccion = (titulo, items, clase) => !items.length ? '' : `
    <div class="ag-sec ${clase || ''}">${titulo} <span class="ag-n">${items.length}</span></div>
    ${items.map(a => agendaItemHTML(a, nombres)).join('')}`;

  cont.innerHTML =
    seccion('🔴 Atrasadas', grupos.atrasadas, 'roja') +
    seccion('⭐ Hoy', grupos.hoy) +
    seccion('📅 Esta semana', grupos.semana) +
    seccion('🗓 Este mes', grupos.mes) +
    seccion('⏳ Más adelante', grupos.despues);

  cont.querySelectorAll('[data-ag-ficha]').forEach(el => el.onclick = () => abrirFicha(el.dataset.agFicha));
  cont.querySelectorAll('[data-ag-listo]').forEach(b => b.onclick = (ev) => {
    ev.stopPropagation();
    abrirResultado(b.dataset.empresa, b.dataset.agListo);   // completa la tarea al elegir resultado
  });
  cont.querySelectorAll('[data-ag-posponer]').forEach(b => b.onclick = async (ev) => {
    ev.stopPropagation();
    const nueva = new Date(); nueva.setDate(nueva.getDate() + 7);
    const { error } = await sb.from('acciones')
      .update({ fecha_programada: nueva.toISOString(), estado: 'reprogramada' }).eq('id', b.dataset.agPosponer);
    // reprogramada → volver a dejarla pendiente con nueva fecha
    await sb.from('acciones').update({ estado: 'pendiente' }).eq('id', b.dataset.agPosponer);
    if (error) { toast('⚠️ No se pudo posponer'); return; }
    toast('🕐 Pospuesta 1 semana');
    cargar();
  });
}

// ==================== ANÁLISIS DE PRODUCTOS ====================
let VENTAS_DET = null;          // cache de líneas de venta (vista v_ventas_detalle)
let AN_CATEGORIA = null;        // 'COLCHON' | 'BASES' | 'ALMOHADA' | null (todas)
let AN_MEDIDA = null;           // filtro medida activo
let AN_LINEA = null;            // filtro línea activo
let AN_SOLO_DORMIDOS = false;
let AN_CLIENTE = null;          // {id, nombre} cliente seleccionado
let AN_DESDE = null;            // 'YYYY-MM' o null
let AN_HASTA = null;            // 'YYYY-MM' o null

// Nombres legibles para medidas
const MEDIDA_LABEL = {
  '2 PL': '2 Plazas', '1 PL': '1 Plaza', '1,5 PL': '1½ Plaza', 'KING': 'King',
  '2 PL PLUS': '2 Plazas Plus', 'S KING': 'Super King',
};
function medidaLabel(m) { return MEDIDA_LABEL[m] || m; }

async function renderMeta() {
  const panel = $('meta-panel');
  const { data, error } = await sb.from('v_meta_cumplimiento').select('*');
  if (error || !data || !data.length) { panel.innerHTML = ''; return; }

  const hoy = new Date();
  const anioActual = hoy.getFullYear(), mesActual = hoy.getMonth() + 1;
  const actual = data.find(m => m.anio === anioActual && m.mes === mesActual);
  const MESES = ['','ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const MESES_L = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

  let html = '';
  if (actual) {
    const meta = Number(actual.meta), real = Number(actual.real);
    const pct = meta > 0 ? Math.round(100 * real / meta) : 0;
    // Proyección: según días transcurridos del mes
    const diasMes = new Date(anioActual, mesActual, 0).getDate();
    const diaHoy = hoy.getDate();
    const proyeccion = diaHoy > 0 ? Math.round(real / diaHoy * diasMes) : real;
    const pctProy = meta > 0 ? Math.round(100 * proyeccion / meta) : 0;
    const color = pctProy >= 90 ? 'var(--verde)' : pctProy >= 60 ? 'var(--amarillo)' : 'var(--rojo)';
    const enCamino = pctProy >= 90 ? '✅ Vas en camino a la meta'
      : pctProy >= 60 ? '⚠️ Vas algo bajo el ritmo' : '🔴 Vas atrasado para la meta';

    html += `<div class="meta-card">
      <div class="meta-mes">🎯 Meta de ${MESES_L[mesActual]} ${anioActual}</div>
      <div class="meta-nums">
        <div><div class="meta-real">${clp(real)}</div><div class="meta-de">de ${clp(meta)}</div></div>
        <div class="meta-pct" style="color:${color}">${pct}%</div>
      </div>
      <div class="meta-bar-wrap">
        <div class="meta-bar proj" style="width:${Math.min(100,pctProy)}%;background:${color}"></div>
        <div class="meta-bar real" style="width:${Math.min(100,pct)}%;background:${color}"></div>
      </div>
      <div class="meta-proj">${enCamino} · Día ${diaHoy} de ${diasMes} ·
        Proyección: <b>${clp(proyeccion)}</b> (${pctProy}%)</div>
    </div>`;
  }

  // Mini-historial de meses cerrados (con venta real registrada)
  const cerrados = data.filter(m => (m.anio < anioActual || (m.anio === anioActual && m.mes < mesActual)) && Number(m.real) > 0);
  if (cerrados.length) {
    const bars = cerrados.map(m => {
      const pct = Number(m.pct);
      const col = pct >= 90 ? 'var(--verde)' : pct >= 60 ? 'var(--amarillo)' : 'var(--rojo)';
      return `<div class="meta-mini">
        <div class="mm-bar-wrap"><div class="mm-bar" style="height:${Math.max(3, Math.min(100,pct))}%;background:${col}"></div></div>
        <div class="mm-pct" style="color:${col}">${pct}%</div>
        <div class="mm-mes">${MESES[m.mes]}</div>
      </div>`;
    }).join('');
    html += `<div class="meta-card" style="padding:14px 16px">
      <div class="meta-mes" style="font-size:13px;color:var(--teal);text-transform:uppercase;letter-spacing:.5px">Cumplimiento meses anteriores</div>
      <div class="meta-hist">${bars}</div>
    </div>`;
  }
  panel.innerHTML = html;
}

async function renderAnalisis() {
  await renderMeta();
  const cont = $('an-resultado');
  if (!VENTAS_DET) {
    cont.innerHTML = '<div class="loader"><div class="spin"></div>Cargando ventas…</div>';
    const { data, error } = await sb.from('v_ventas_detalle')
      .select('empresa_id,empresa,tipo_cliente,telefono,fecha_ultima_compra,fecha_emision,mes,unidades,monto_neto_clp,producto,clasificacion,medida,linea');
    if (error) { cont.innerHTML = `<div class="empty">⚠️ ${escapeHtml(error.message)}</div>`; return; }
    VENTAS_DET = data;
    construirChips();
  }
  pintarAnalisis();
}

const CAT_LABEL = { COLCHON: 'Colchones', BASES: 'Bases', ALMOHADA: 'Almohadas', COMBO: 'Combos' };

function construirChips() {
  // Categorías con venta, ordenadas por monto
  const catVenta = {}, medVenta = {};
  for (const v of VENTAS_DET) {
    if (v.clasificacion) catVenta[v.clasificacion] = (catVenta[v.clasificacion] || 0) + Number(v.monto_neto_clp);
    if (v.medida && !/SIN MEDIDA|X180/i.test(v.medida))
      medVenta[v.medida] = (medVenta[v.medida] || 0) + Number(v.monto_neto_clp);
  }
  const cats = Object.keys(catVenta).sort((a,b) => catVenta[b] - catVenta[a]);
  const medidas = Object.keys(medVenta).sort((a,b) => medVenta[b] - medVenta[a]);

  $('an-categorias').innerHTML = `<button class="chip on" data-cat="">Todas</button>` +
    cats.map(c => `<button class="chip" data-cat="${c}">${escapeHtml(CAT_LABEL[c] || c)}</button>`).join('');
  $('an-medidas').innerHTML = `<button class="chip on" data-med="">Todas</button>` +
    medidas.map(m => `<button class="chip" data-med="${escapeHtml(m)}">${escapeHtml(medidaLabel(m))}</button>`).join('');
  rebuildLineas();

  $('an-categorias').querySelectorAll('[data-cat]').forEach(c => c.onclick = () => {
    AN_CATEGORIA = c.dataset.cat || null; sincronizarChips('an-categorias', c);
    AN_LINEA = null; rebuildLineas(); pintarAnalisis();
  });
  $('an-medidas').querySelectorAll('[data-med]').forEach(c => c.onclick = () => {
    AN_MEDIDA = c.dataset.med || null; sincronizarChips('an-medidas', c); pintarAnalisis();
  });
  $('an-solo-dormidos').onchange = (e) => { AN_SOLO_DORMIDOS = e.target.checked; pintarAnalisis(); };

  // Selector de rango de fechas
  const desde = $('an-desde'), hasta = $('an-hasta');
  // Límites según la data disponible
  const mesesData = VENTAS_DET.map(v => String(v.fecha_emision).slice(0,7)).sort();
  const minMes = mesesData[0], maxMes = mesesData[mesesData.length-1];
  [desde, hasta].forEach(inp => { inp.min = minMes; inp.max = maxMes; });
  const limpiarAtajos = () => $('an-atajos').querySelectorAll('.chip-mini').forEach(c => c.classList.remove('on'));
  desde.onchange = () => { AN_DESDE = desde.value || null; limpiarAtajos(); pintarAnalisis(); };
  hasta.onchange = () => { AN_HASTA = hasta.value || null; limpiarAtajos(); pintarAnalisis(); };
  $('an-rango-clear').onclick = () => {
    AN_DESDE = AN_HASTA = null; desde.value = ''; hasta.value = ''; limpiarAtajos(); pintarAnalisis();
  };
  // Atajos rápidos → rellenan Desde/Hasta
  $('an-atajos').querySelectorAll('[data-atajo]').forEach(b => b.onclick = () => {
    const a = b.dataset.atajo;
    const hoy = new Date();
    const ym = d => d.toISOString().slice(0,7);
    if (a === '2026') { AN_DESDE = '2026-01'; AN_HASTA = '2026-12'; }
    else if (a === '2025') { AN_DESDE = '2025-01'; AN_HASTA = '2025-12'; }
    else {
      const meses = a === '3m' ? 3 : 6;
      const c = new Date(hoy); c.setMonth(c.getMonth() - meses + 1);
      AN_DESDE = ym(c); AN_HASTA = ym(hoy);
    }
    desde.value = AN_DESDE; hasta.value = AN_HASTA;
    limpiarAtajos(); b.classList.add('on');
    pintarAnalisis();
  });

  // Buscador de cliente
  const inp = $('an-cliente-input');
  const drop = $('an-cliente-drop');
  // Solo clientes que tienen ventas en el detalle
  const idsConVenta = new Set(VENTAS_DET.map(v => v.empresa_id));
  const clientesLista = EMPRESAS.filter(e => idsConVenta.has(e.id))
    .sort((a,b) => a.nombre.localeCompare(b.nombre));

  inp.oninput = () => {
    const q = inp.value.trim().toLowerCase();
    if (!q) { drop.classList.add('hidden'); return; }
    const matches = clientesLista.filter(e => e.nombre.toLowerCase().includes(q)).slice(0, 8);
    if (!matches.length) { drop.innerHTML = `<div class="an-drop-item"><small>Sin resultados</small></div>`; }
    else drop.innerHTML = matches.map(e =>
      `<div class="an-drop-item" data-cli="${e.id}">${escapeHtml(e.nombre)}
        <small> · ${({activo:'al día',dormido:'dormido',perdido:'perdido'}[e.tipo_cliente]||'')}</small></div>`).join('');
    drop.classList.remove('hidden');
    drop.querySelectorAll('[data-cli]').forEach(d => d.onclick = () => {
      const e = clientesLista.find(x => x.id === d.dataset.cli);
      seleccionarCliente(e);
    });
  };
  inp.onblur = () => setTimeout(() => drop.classList.add('hidden'), 200);
}

function seleccionarCliente(e) {
  AN_CLIENTE = e ? { id: e.id, nombre: e.nombre } : null;
  const sel = $('an-cliente-sel'), inp = $('an-cliente-input'), drop = $('an-cliente-drop');
  drop.classList.add('hidden');
  if (AN_CLIENTE) {
    inp.classList.add('hidden');
    sel.classList.remove('hidden');
    sel.innerHTML = `<span>👤 ${escapeHtml(AN_CLIENTE.nombre)}</span><button id="an-cli-clear">✕</button>`;
    $('an-cli-clear').onclick = () => seleccionarCliente(null);
  } else {
    inp.classList.remove('hidden'); inp.value = '';
    sel.classList.add('hidden');
  }
  pintarAnalisis();
}

function rebuildLineas() {
  // Líneas de la categoría seleccionada (o de todas), ordenadas por venta
  const linVenta = {};
  for (const v of VENTAS_DET) {
    if (AN_CATEGORIA && v.clasificacion !== AN_CATEGORIA) continue;
    if (v.linea && !/^FUNDA/i.test(v.linea))
      linVenta[v.linea] = (linVenta[v.linea] || 0) + Number(v.monto_neto_clp);
  }
  const lineas = Object.keys(linVenta).sort((a,b) => linVenta[b] - linVenta[a]);
  $('an-lineas').innerHTML = `<button class="chip on" data-lin="">Todas</button>` +
    lineas.map(l => `<button class="chip" data-lin="${escapeHtml(l)}">${escapeHtml(l)}</button>`).join('');
  $('an-lineas').querySelectorAll('[data-lin]').forEach(c => c.onclick = () => {
    AN_LINEA = c.dataset.lin || null; sincronizarChips('an-lineas', c); pintarAnalisis();
  });
}

function sincronizarChips(grupoId, activo) {
  $(grupoId).querySelectorAll('.chip').forEach(c => c.classList.remove('on'));
  activo.classList.add('on');
}

function enPeriodo(fecha) {
  if (!AN_DESDE && !AN_HASTA) return true;
  const ym = String(fecha).slice(0, 7);   // 'YYYY-MM'
  if (AN_DESDE && ym < AN_DESDE) return false;
  if (AN_HASTA && ym > AN_HASTA) return false;
  return true;
}

function pintarAnalisis() {
  const cont = $('an-resultado');
  // Filtrar líneas de venta
  let filas = VENTAS_DET.filter(v => Number(v.unidades) > 0); // solo compras (no NC)
  if (AN_DESDE || AN_HASTA) filas = filas.filter(v => enPeriodo(v.fecha_emision));
  if (AN_CLIENTE) filas = filas.filter(v => v.empresa_id === AN_CLIENTE.id);
  if (AN_CATEGORIA) filas = filas.filter(v => v.clasificacion === AN_CATEGORIA);
  if (AN_MEDIDA) filas = filas.filter(v => v.medida === AN_MEDIDA);
  if (AN_LINEA) filas = filas.filter(v => v.linea === AN_LINEA);

  // ===== Caso: cliente seleccionado → qué compró él =====
  if (AN_CLIENTE) {
    const totMonto = filas.reduce((s,v) => s + Number(v.monto_neto_clp), 0);
    const totUds = filas.reduce((s,v) => s + Number(v.unidades), 0);
    // Agrupar por producto (con medida)
    const porProd = {};
    for (const v of filas) {
      const nom = v.producto || '(sin nombre)';
      porProd[nom] = porProd[nom] || { uds: 0, monto: 0 };
      porProd[nom].uds += Number(v.unidades);
      porProd[nom].monto += Number(v.monto_neto_clp);
    }
    const prods = Object.entries(porProd).sort((a,b) => b[1].monto - a[1].monto);
    const extra = [AN_LINEA, AN_MEDIDA ? medidaLabel(AN_MEDIDA) : null].filter(Boolean).join(' · ');
    let html = `<div class="an-sum">
      <div class="big">${clp(totMonto)}</div>
      <div class="sub">${escapeHtml(AN_CLIENTE.nombre)}${extra ? ' — ' + extra : ''} · ${totUds} unidades</div>
    </div>`;
    if (!prods.length) {
      html += `<div class="empty"><div class="ico">🔍</div>No compró eso.</div>`;
    } else {
      html += `<div class="an-rank-title">🛏 Qué ha comprado</div>`;
      html += prods.map(([nom, v]) => `
        <div class="an-cli">
          <div class="an-cli-info"><div class="an-cli-nom">${escapeHtml(nom)}</div>
            <div class="an-cli-meta">${v.uds} unidades</div></div>
          <div class="an-cli-r"><div class="an-cli-monto">${clp(v.monto)}</div></div>
        </div>`).join('');
      html += `<div style="text-align:center;margin-top:10px">
        <button class="btn btn-note" style="max-width:200px;margin:0 auto" data-ver-ficha="${AN_CLIENTE.id}">Ver ficha completa ›</button></div>`;
    }
    cont.innerHTML = html;
    const vf = cont.querySelector('[data-ver-ficha]');
    if (vf) vf.onclick = () => abrirFicha(vf.dataset.verFicha);
    return;
  }

  const hayFiltro = AN_MEDIDA || AN_LINEA || AN_CATEGORIA;

  // Agrupar por cliente
  const porCli = {};
  for (const v of filas) {
    const k = v.empresa_id;
    porCli[k] = porCli[k] || { nombre: v.empresa, tipo: v.tipo_cliente, tel: v.telefono,
                               ult: v.fecha_ultima_compra, uds: 0, monto: 0 };
    porCli[k].uds += Number(v.unidades);
    porCli[k].monto += Number(v.monto_neto_clp);
  }
  let clientes = Object.entries(porCli).map(([id, c]) => ({ id, ...c }));
  if (AN_SOLO_DORMIDOS) clientes = clientes.filter(c => c.tipo === 'dormido' || c.tipo === 'perdido');
  clientes.sort((a,b) => b.monto - a.monto);

  const totMonto = clientes.reduce((s,c) => s + c.monto, 0);
  const totUds = clientes.reduce((s,c) => s + c.uds, 0);

  // Resumen
  const etiqueta = [AN_CATEGORIA ? CAT_LABEL[AN_CATEGORIA] : null, AN_LINEA, AN_MEDIDA ? medidaLabel(AN_MEDIDA) : null].filter(Boolean).join(' · ') || 'Todos los productos';
  let html = `<div class="an-sum">
    <div class="big">${clp(totMonto)}</div>
    <div class="sub">${etiqueta} — ${clientes.length} clientes · ${totUds} unidades</div>
  </div>`;

  // Si NO hay filtro: mostrar ranking de qué se vende (tappable) — todas las categorías
  if (!hayFiltro && !AN_SOLO_DORMIDOS) {
    const porLinea = {};
    for (const v of filas.filter(x => x.linea)) {
      porLinea[v.linea] = porLinea[v.linea] || { monto: 0, uds: 0 };
      porLinea[v.linea].monto += Number(v.monto_neto_clp);
      porLinea[v.linea].uds += Number(v.unidades);
    }
    const rank = Object.entries(porLinea).sort((a,b) => b[1].monto - a[1].monto);
    const max = rank.length ? rank[0][1].monto : 1;
    html += `<div class="an-rank-title">🏆 Qué se vende más</div>`;
    html += rank.map(([lin, v]) => `
      <div class="an-rank-row" data-rank-linea="${escapeHtml(lin)}">
        <div style="flex:1">
          <div class="an-rank-nom">${escapeHtml(lin)}</div>
          <div class="an-rank-bar" style="width:${Math.max(8, 100*v.monto/max)}%"></div>
        </div>
        <div class="an-rank-val"><b>${clp(v.monto)}</b>${v.uds} uds</div>
      </div>`).join('');
    cont.innerHTML = html;
    cont.querySelectorAll('[data-rank-linea]').forEach(r => r.onclick = () => {
      AN_LINEA = r.dataset.rankLinea;
      const chip = [...$('an-lineas').querySelectorAll('[data-lin]')].find(c => c.dataset.lin === AN_LINEA);
      if (chip) sincronizarChips('an-lineas', chip);
      pintarAnalisis();
    });
    return;
  }

  // Con filtro: lista de clientes que compraron eso
  if (!clientes.length) {
    html += `<div class="empty"><div class="ico">🔍</div>Nadie compró eso todavía.</div>`;
    cont.innerHTML = html;
    return;
  }
  const BADGE = { activo:'Al día', dormido:'Dormido', perdido:'Perdido' };
  html += `<div class="an-rank-title">Quién lo compró (${clientes.length})</div>`;
  html += clientes.map(c => {
    const tel = (c.tel || '').replace(/[^\d+]/g, '');
    const dias = c.ult ? Math.round((new Date() - new Date(c.ult)) / 86400000) : null;
    return `<div class="an-cli ${c.tipo}" data-an-ficha="${c.id}">
      <div class="an-cli-info">
        <div class="an-cli-nom">${escapeHtml(c.nombre)}</div>
        <div class="an-cli-meta">
          <span class="an-cli-badge ${c.tipo}">${BADGE[c.tipo] || c.tipo}</span>
          ${dias != null ? ` · última compra hace ${dias} días` : ''}
        </div>
      </div>
      <div class="an-cli-r">
        <div class="an-cli-monto">${clp(c.monto)}</div>
        <div class="an-cli-uds">${c.uds} uds</div>
      </div>
    </div>`;
  }).join('');
  cont.innerHTML = html;
  cont.querySelectorAll('[data-an-ficha]').forEach(el => el.onclick = () => abrirFicha(el.dataset.anFicha));
}

function agendaItemHTML(a, nombres) {
  const TIPO_EMOJI = { llamar:'📞', email:'✉️', whatsapp:'💬', reunion:'🤝', cotizar:'📄', visita:'🚗', otro:'📌', enviar_muestra:'📦' };
  return `
  <div class="ag-item" data-ag-ficha="${a.empresa_id}">
    <div class="ag-fecha">${fechaCorta(a.fecha_programada)}</div>
    <div class="ag-body">
      <div class="ag-titulo">${TIPO_EMOJI[a.tipo] || '📌'} ${escapeHtml(a.titulo)}</div>
      <div class="ag-cliente">${escapeHtml(nombres[a.empresa_id] || '')}</div>
    </div>
    <div class="ag-btns">
      <button class="ag-ok" data-ag-listo="${a.id}" data-empresa="${a.empresa_id}">✓</button>
      <button class="ag-pos" data-ag-posponer="${a.id}">🕐</button>
    </div>
  </div>`;
}

// ==================== FICHA CLIENTE ====================
let fichaId = null;

async function abrirFicha(id) {
  fichaId = id;
  const e = EMPRESAS.find(x => x.id === id);
  if (!e) return;
  $('f-nombre').textContent = nombreMostrar(e);
  const razonSoc = e.nombre_fantasia ? (e.razon_social || e.nombre) : null;
  $('f-sub').textContent = (razonSoc ? razonSoc + ' · ' : '') + (e.rut ? 'RUT ' + e.rut : 'Sin RUT') + ' · ' +
    ({ activo: 'Cliente al día ✓', dormido: 'Dejó de comprar 😴', perdido: 'Cliente perdido 💤', prospecto: 'Prospecto' }[e.tipo_cliente] || '');
  $('f-total').textContent = clp(e.monto_total_hist_clp);
  $('f-compras').textContent = e.cantidad_compras;
  $('f-ult').textContent = mesCorto(e.fecha_ultima_compra);

  const telLimpio = (e.telefono || '').replace(/[^\d+]/g, '');
  $('f-contact').innerHTML = (e.telefono
    ? `<a href="tel:${telLimpio}" class="btn-call btn" style="flex:1.2">📞 Llamar</a>`
    : `<button class="btn-tel-add btn" style="flex:1.2" id="f-add-tel">➕ Teléfono</button>`)
    + `<button class="btn" style="flex:1;background:var(--brown);color:#fff" id="f-recordar">⏰ Recordarme</button>`
    + (e.email ? `<a href="mailto:${escapeHtml(e.email)}" class="btn" style="flex:.8;background:var(--teal);color:#fff">✉️</a>` : '');
  const addTelBtn = $('f-add-tel');
  if (addTelBtn) addTelBtn.onclick = () => { cerrarFicha(); abrirTel(id); };
  $('f-recordar').onclick = () => abrirRecordar(id);

  // Datos del cliente (RUT, giro, dirección, camas, habitaciones…)
  const datos = [];
  if (e.razon_social && e.razon_social.toLowerCase() !== (e.nombre || '').toLowerCase()) datos.push(['Razón social', e.razon_social]);
  if (e.rut) datos.push(['RUT', e.rut]);
  if (CANAL_LBL[e.canal]) datos.push(['Rubro', CANAL_LBL[e.canal].replace(/^\S+\s/, '')]);
  if (e.giro) datos.push(['Giro', e.giro]);
  if (e.direccion) datos.push(['Dirección', e.direccion + (e.comuna ? ', ' + e.comuna : '')]);
  else if (e.comuna) datos.push(['Comuna', e.comuna]);
  if (e.habitaciones) datos.push(['Habitaciones', e.habitaciones]);
  if (e.camas) datos.push(['Camas', e.camas]);
  const bloqueDatos = datos.length
    ? `<div class="sec-title">📋 Datos del cliente</div>` +
      datos.map(([k, v]) => `<div class="dato-row"><span class="dato-k">${k}</span><span class="dato-v">${escapeHtml(String(v))}</span></div>`).join('')
    : '';
  const bloqueGrupo = e.grupo_relacionados
    ? `<div class="sec-title" style="margin-top:12px">🏨 Otros locales del mismo dueño</div>` +
      `<div class="grupo-rel">${e.grupo_relacionados.split('·').map(h => `<span class="grupo-chip">${escapeHtml(h.trim())}</span>`).join('')}</div>`
    : '';
  $('f-datos').innerHTML = bloqueDatos + bloqueGrupo;

  // Memoria de Pipedrive
  $('f-memo').innerHTML = e.comentario
    ? `<div class="sec-title">📌 Lo que sabemos del cliente</div><div class="nota-row memo">${escapeHtml(e.comentario)}</div>`
    : '';

  $('f-contactos').innerHTML = '<div class="loader"><div class="spin"></div></div>';
  $('f-hist').innerHTML = '';
  $('f-gestiones').innerHTML = '';
  $('f-notas').innerHTML = '';
  $('f-nueva-nota').value = '';
  $('ficha').classList.remove('hidden');

  const [cont, tx, gest, notas] = await Promise.all([
    sb.from('contactos').select('nombre,apellido,cargo,telefono,email,es_decisor').eq('empresa_id', id).order('es_decisor', { ascending: false }),
    sb.from('transacciones').select('fecha_emision,mes,monto_neto_clp,unidades,producto,sku')
      .eq('empresa_id', id).order('fecha_emision', { ascending: false }).limit(300),
    sb.from('acciones').select('titulo,resultado,fecha_completada,tipo')
      .eq('empresa_id', id).eq('estado', 'completada')
      .order('fecha_completada', { ascending: false }).limit(5),
    sb.from('notas').select('cuerpo,created_at').eq('empresa_id', id)
      .order('created_at', { ascending: false }).limit(5),
  ]);

  // Personas de contacto
  const filasCtc = (cont.data && cont.data.length)
    ? cont.data.map(c => {
        const t = (c.telefono || '').replace(/[^\d+]/g, '');
        const nombreCompleto = [c.nombre, c.apellido].filter(Boolean).join(' ');
        return `<div class="ctc-row">
          <div class="ctc-nombre">${escapeHtml(nombreCompleto)}${c.es_decisor ? ' ⭐' : ''}</div>
          ${c.cargo ? `<div class="ctc-cargo">${escapeHtml(c.cargo)}</div>` : ''}
          <div class="ctc-datos">
            ${c.telefono ? `<a href="tel:${t}">📞 ${escapeHtml(c.telefono)}</a>` : ''}
            ${c.email ? `<a href="mailto:${escapeHtml(c.email)}">✉️ ${escapeHtml(c.email)}</a>` : ''}
          </div>
        </div>`;
      }).join('')
    : `<div class="hint" style="padding:0 0 4px">Aún no hay contactos guardados.</div>`;
  $('f-contactos').innerHTML = `<div class="sec-title">👤 Personas de contacto</div>` + filasCtc +
    `<button class="btn" id="f-add-ctc" style="width:100%;background:var(--cream);color:var(--navy);margin-top:6px">➕ Agregar contacto</button>`;
  $('f-add-ctc').onclick = () => abrirContacto(id);

  // Historial de compras por mes — con desglose de productos al tocar
  if (tx.data && tx.data.length) {
    const porMes = {};
    tx.data.forEach(t => {
      const k = t.mes || t.fecha_emision.slice(0, 7);
      porMes[k] = porMes[k] || { monto: 0, unidades: 0, prods: {} };
      porMes[k].monto += Number(t.monto_neto_clp);
      porMes[k].unidades += Number(t.unidades || 0);
      // Agrupar productos (excluir despachos y líneas sin nombre)
      const nom = (t.producto || '').trim();
      if (nom && !/DESPACHO|ROLL PACKING/i.test(nom)) {
        porMes[k].prods[nom] = porMes[k].prods[nom] || { uds: 0, monto: 0 };
        porMes[k].prods[nom].uds += Number(t.unidades || 0);
        porMes[k].prods[nom].monto += Number(t.monto_neto_clp);
      }
    });
    $('f-hist').innerHTML = `<div class="sec-title">🛒 Historial de compras <span class="hint-inline">(toca un mes para ver qué compró)</span></div>` +
      Object.entries(porMes).map(([mes, v]) => {
        const prods = Object.entries(v.prods).sort((a,b) => b[1].monto - a[1].monto);
        const detalle = prods.length
          ? `<div class="hist-det">` + prods.map(([nom, p]) =>
              `<div class="hist-prod"><span>${p.uds > 0 ? p.uds + '× ' : ''}${escapeHtml(nom)}</span><span>${clp(p.monto)}</span></div>`
            ).join('') + `</div>`
          : '';
        return `
        <div class="hist-mes" data-mes="${mes}">
          <div class="hist-row hist-head">
            <span class="mes">${mesCorto(mes + '-01')} ›</span>
            <span>${v.unidades > 0 ? v.unidades + ' uds' : ''}</span>
            <span class="m ${v.monto < 0 ? 'neg' : ''}">${clp(v.monto)}</span>
          </div>
          ${detalle}
        </div>`;
      }).join('');
    // Toggle desglose al tocar el mes
    $('f-hist').querySelectorAll('.hist-head').forEach(h => {
      h.onclick = () => h.parentElement.classList.toggle('open');
    });
  } else {
    $('f-hist').innerHTML = `<div class="sec-title">🛒 Historial de compras</div><div class="hint">Sin compras registradas aún.</div>`;
  }

  // Gestiones anteriores (de Pipedrive + nuevas)
  if (gest.data && gest.data.length) {
    $('f-gestiones').innerHTML = `<div class="sec-title">📖 Últimas gestiones</div>` +
      gest.data.map(g => `<div class="nota-row">
        <b>${escapeHtml(g.titulo)}</b>${g.resultado ? '<br>' + escapeHtml(g.resultado.slice(0, 160)) + (g.resultado.length > 160 ? '…' : '') : ''}
        <div class="f">${g.fecha_completada ? fechaCorta(g.fecha_completada) + ' ' + new Date(g.fecha_completada).getFullYear() : ''}</div>
      </div>`).join('');
  }

  $('f-notas').innerHTML = `<div class="sec-title">📝 Notas nuevas</div>` + ((notas.data && notas.data.length)
    ? notas.data.map(n => `<div class="nota-row">${escapeHtml(n.cuerpo)}
        <div class="f">${new Date(n.created_at).toLocaleDateString('es-CL')}</div></div>`).join('')
    : '<div class="hint">Todavía no hay notas. Escribe la primera 👇</div>');
}

function cerrarFicha() { $('ficha').classList.add('hidden'); }
$('f-cerrar').onclick = cerrarFicha;
$('ficha').onclick = (e) => { if (e.target === $('ficha')) cerrarFicha(); };

$('f-guardar-nota').onclick = async () => {
  const cuerpo = $('f-nueva-nota').value.trim();
  if (!cuerpo) { cerrarFicha(); return; }
  const { error } = await sb.from('notas').insert({ empresa_id: fichaId, cuerpo, tipo: 'general' });
  if (error) { toast('⚠️ No se pudo guardar'); return; }
  toast('Nota guardada ✓');
  cerrarFicha();
};

// ==================== RESULTADO DE GESTIÓN ====================
let resId = null;
let resAccionPendiente = null;   // si viene de la Agenda, completa esa tarea
const RESULTADOS = {
  hablamos:    { txt: 'Hablamos — quedó interesado', emoji: '😊' },
  despues:     { txt: 'Me pidió llamar más adelante', emoji: '📅' },
  no_contesto: { txt: 'No contestó', emoji: '📵' },
  no_interesa: { txt: 'No le interesa por ahora', emoji: '🙅' },
};

function abrirResultado(empresaId, accionId) {
  resId = empresaId;
  resAccionPendiente = accionId || null;
  const e = EMPRESAS.find(x => x.id === empresaId);
  $('r-sub').textContent = e ? nombreMostrar(e) : '';
  $('resmodal').classList.remove('hidden');
}
$('r-cancel').onclick = () => $('resmodal').classList.add('hidden');
$('resmodal').onclick = (e) => { if (e.target === $('resmodal')) $('resmodal').classList.add('hidden'); };

document.querySelectorAll('.res-opt').forEach(b => {
  b.onclick = async () => {
    const r = RESULTADOS[b.dataset.r];
    const e = EMPRESAS.find(x => x.id === resId);
    $('resmodal').classList.add('hidden');

    if (resAccionPendiente) {
      // Completar la tarea pendiente de la agenda
      await sb.from('acciones').update({
        estado: 'completada', resultado: r.txt, fecha_completada: new Date().toISOString(),
      }).eq('id', resAccionPendiente);
    } else {
      await sb.from('acciones').insert({
        empresa_id: resId, tipo: 'llamar',
        titulo: `Llamada a ${e ? nombreMostrar(e) : 'cliente'}`,
        estado: 'completada', resultado: r.txt,
        fecha_programada: new Date().toISOString(),
        fecha_completada: new Date().toISOString(),
      });
    }
    // Recordatorio automático
    if (b.dataset.r === 'despues' || b.dataset.r === 'no_contesto') {
      const dias = b.dataset.r === 'no_contesto' ? 2 : 7;
      const prox = new Date(); prox.setDate(prox.getDate() + dias);
      await sb.from('acciones').insert({
        empresa_id: resId, tipo: 'llamar',
        titulo: `Volver a llamar a ${e ? e.nombre : 'cliente'}`,
        estado: 'pendiente', prioridad: 'alta',
        fecha_programada: prox.toISOString(),
      });
      toast(`${r.emoji} Anotado ✓ Te lo recordaré`);
    } else {
      toast(`${r.emoji} Anotado ✓`);
    }
    resAccionPendiente = null;
    cargar();
  };
});

// ==================== RECORDARME (manual) ====================
let recId = null;
let recDias = 1;

function abrirRecordar(id) {
  recId = id;
  const e = EMPRESAS.find(x => x.id === id);
  $('rec-sub').textContent = e ? e.nombre : '';
  $('rec-titulo').value = '';
  recDias = 1;
  document.querySelectorAll('.rec-chip').forEach(c => c.classList.toggle('sel', c.dataset.dias === '1'));
  $('rec-fecha').value = '';
  cerrarFicha();
  $('recmodal').classList.remove('hidden');
}
document.querySelectorAll('.rec-chip').forEach(c => {
  c.onclick = () => {
    recDias = Number(c.dataset.dias);
    $('rec-fecha').value = '';
    document.querySelectorAll('.rec-chip').forEach(x => x.classList.remove('sel'));
    c.classList.add('sel');
  };
});
$('rec-fecha').onchange = () => {
  if ($('rec-fecha').value) {
    recDias = null;
    document.querySelectorAll('.rec-chip').forEach(x => x.classList.remove('sel'));
  }
};
$('rec-cancel').onclick = () => $('recmodal').classList.add('hidden');
$('recmodal').onclick = (e) => { if (e.target === $('recmodal')) $('recmodal').classList.add('hidden'); };
$('rec-save').onclick = async () => {
  const e = EMPRESAS.find(x => x.id === recId);
  let fecha;
  if ($('rec-fecha').value) fecha = new Date($('rec-fecha').value + 'T09:00:00');
  else { fecha = new Date(); fecha.setDate(fecha.getDate() + (recDias || 1)); }
  const titulo = $('rec-titulo').value.trim() || `Llamar a ${e ? e.nombre : 'cliente'}`;
  const { error } = await sb.from('acciones').insert({
    empresa_id: recId, tipo: 'llamar', titulo,
    estado: 'pendiente', prioridad: 'media',
    fecha_programada: fecha.toISOString(),
  });
  if (error) { toast('⚠️ No se pudo guardar'); return; }
  $('recmodal').classList.add('hidden');
  toast(`⏰ Listo, te lo recordaré el ${fechaCorta(fecha)}`);
  cargar();
};

// ==================== TELÉFONO ====================
let telId = null;
function abrirTel(id) {
  telId = id;
  const e = EMPRESAS.find(x => x.id === id);
  $('t-sub').textContent = e ? nombreMostrar(e) : '';
  $('t-tel').value = '';
  $('telmodal').classList.remove('hidden');
  setTimeout(() => $('t-tel').focus(), 150);
}
$('t-cancel').onclick = () => $('telmodal').classList.add('hidden');
$('telmodal').onclick = (e) => { if (e.target === $('telmodal')) $('telmodal').classList.add('hidden'); };
$('t-save').onclick = async () => {
  const tel = $('t-tel').value.trim();
  if (!tel) { $('telmodal').classList.add('hidden'); return; }
  const { error } = await sb.from('empresas').update({ telefono: tel }).eq('id', telId);
  if (error) { toast('⚠️ No se pudo guardar'); return; }
  const e = EMPRESAS.find(x => x.id === telId);
  if (e) e.telefono = tel;
  $('telmodal').classList.add('hidden');
  toast('Teléfono guardado ✓');
  render();
};

// ==================== AGREGAR CONTACTO ====================
let ctcEmpId = null;
function abrirContacto(id) {
  ctcEmpId = id;
  const e = EMPRESAS.find(x => x.id === id);
  $('ctc-sub').textContent = e ? nombreMostrar(e) : '';
  $('ctc-nombre').value = ''; $('ctc-cargo').value = ''; $('ctc-tel').value = ''; $('ctc-email').value = '';
  cerrarFicha();
  $('ctcmodal').classList.remove('hidden');
  setTimeout(() => $('ctc-nombre').focus(), 150);
}
$('ctc-cancel').onclick = () => { $('ctcmodal').classList.add('hidden'); if (ctcEmpId) abrirFicha(ctcEmpId); };
$('ctcmodal').onclick = (e) => { if (e.target === $('ctcmodal')) $('ctc-cancel').onclick(); };
$('ctc-save').onclick = async () => {
  const nombre = $('ctc-nombre').value.trim();
  if (!nombre) { toast('Escribe al menos el nombre'); return; }
  const cargo = $('ctc-cargo').value || null;
  const row = {
    empresa_id: ctcEmpId, nombre, cargo,
    telefono: $('ctc-tel').value.trim() || null,
    email: $('ctc-email').value.trim() || null,
    es_decisor: ['Dueño(a)', 'Gerente(a)', 'Administrador(a)', 'Socio'].includes(cargo),
  };
  const { error } = await sb.from('contactos').insert(row);
  if (error) { toast('⚠️ No se pudo guardar'); return; }
  $('ctcmodal').classList.add('hidden');
  toast('Contacto guardado ✓');
  if (ctcEmpId) abrirFicha(ctcEmpId);
};

// ==================== TABS + BUSCADOR ====================
$('tabs').querySelectorAll('.tab').forEach(t => {
  t.onclick = () => {
    $('tabs').querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    FILTRO = t.dataset.f;
    render();
  };
});
$('search').oninput = (e) => { BUSCA = e.target.value.trim(); render(); };

// Chips de canal (Todos / Prospectos)
if ($('canal-chips')) {
  $('canal-chips').querySelectorAll('.rec-chip').forEach(c => {
    c.onclick = () => {
      $('canal-chips').querySelectorAll('.rec-chip').forEach(x => x.classList.remove('sel'));
      c.classList.add('sel');
      CANAL = c.dataset.canal;
      render();
    };
  });
}

// ==================== PWA ====================
// Durante desarrollo: desregistrar cualquier service worker viejo para que
// siempre se sirva el código más nuevo (evita ver versiones cacheadas).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister())).catch(() => {});
  caches?.keys().then(ks => ks.forEach(k => caches.delete(k))).catch(() => {});
}
