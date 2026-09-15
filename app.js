'use strict';

const STORAGE_KEY = 'ag02Contrataciones:v1';

const state = loadState();

document.addEventListener('DOMContentLoaded', () => {
  const countInput =
    document.querySelector(
      '[name="count"]'
    );

  if (countInput) {
    countInput.setAttribute(
      'min',
      '1'
    );

    countInput.setAttribute(
      'max',
      '200'
    );

    countInput.setAttribute(
      'step',
      '1'
    );

    // Conserva el valor existente; solo corrige valores inválidos.
    const current =
      Number(countInput.value);

    if (
      !Number.isFinite(current) ||
      current < 1
    ) {
      countInput.value = '50';
    }
  }
});


function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (err) { /* estado corrupto, se reinicia */ }
  return {
    perfil: null,
    leads: [],
    feedback: [],
    proposedRules: [],
    approvedRules: [],
    version: '0.1',
    currentLeadId: null
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function isUnverified(value) {
  if (value === null || value === undefined || value === '') return true;
  const v = String(value).toUpperCase();
  return v.includes('NO_VERIFICADO') || v.includes('NO VERIFICADO') || v.includes('REQUIERE_VALIDACION') || v.includes('REQUIERE VALIDACIÓN') || v.includes('REQUIERE VALIDACION');
}
function formatMonto(monto) {
  if (monto == null || isUnverified(monto)) return 'NO_VERIFICADO';
  return `S/ ${Number(monto).toLocaleString('es-PE')}`;
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`${url} respondió ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Navegación
// ---------------------------------------------------------------------------

function goToView(view) {
  $all('.nav-item').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
  $all('.view').forEach(sec => sec.classList.toggle('active', sec.id === `view-${view}`));
  const titles = {
    dashboard: 'Prospección de Contrataciones Públicas',
    sprint: 'Nuevo perfil de empresa',
    leads: 'Oportunidades detectadas',
    validation: 'Validación humana',
    learning: 'Aprendizaje supervisado',
    integrations: 'Fuentes oficiales'
  };
  $('#pageTitle').textContent = titles[view] || 'Prospección de Contrataciones Públicas';
  if (view === 'validation') renderValidation();
  if (view === 'learning') renderLearning();
  if (view === 'leads') renderLeadsTable();
}

$all('.nav-item').forEach(btn => btn.addEventListener('click', () => goToView(btn.dataset.view)));
$all('[data-go]').forEach(btn => btn.addEventListener('click', () => goToView(btn.dataset.go)));

// ---------------------------------------------------------------------------
// Estado del API (demo / live)
// ---------------------------------------------------------------------------

async function refreshStatus() {
  const pill = $('#apiStatus');
  const openaiState = $('#openaiState');
  try {
    const status = await fetch('/api/status').then(r => r.json());
    $('#versionLabel').textContent = state.version;
    if (status.demoMode) {
      pill.className = 'status-pill demo';
      pill.innerHTML = '<i></i>Modo demo (sin API key)';
      if (openaiState) { openaiState.textContent = 'Modo demo'; openaiState.className = 'integration-state off'; }
    } else {
      pill.className = 'status-pill live';
      pill.innerHTML = `<i></i>Conectado · ${esc(status.model)}`;
      if (openaiState) { openaiState.textContent = 'Conectada'; openaiState.className = 'integration-state on'; }
    }
  } catch (err) {
    pill.className = 'status-pill error';
    pill.innerHTML = '<i></i>Servidor no disponible';
  }
}

// ---------------------------------------------------------------------------
// Perfil de empresa
// ---------------------------------------------------------------------------

$('#icpForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#buildIcpBtn');
  const formData = new FormData(e.target);
  const body = Object.fromEntries(formData.entries());

  btn.disabled = true;
  btn.textContent = 'Estructurando…';
  try {
    const result = await postJson('/api/perfil', body);
    state.perfil = result.perfil;
    state.perfil.resumen = result.resumen;
    state.perfil.fuente = result.fuente;
    state.feedback = [];
    state.leads = [];
    saveState();
    renderIcpResult(result);
    updateSidebarValidator(body.validator);
    toast('Perfil estructurado. Ya puedes buscar oportunidades.');
  } catch (err) {
    toast(`Error estructurando el perfil: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Estructurar perfil';
  }
});

function updateSidebarValidator(name) {
  if (name) {
    $('#validatorNameSide').value = name;
    $('#validatorName').value = name;
  }
}

function renderIcpResult(result) {
  const { perfil, resumen, assumptions, clarifyingQuestions, fuente, warning } = result;
  $('#icpEmpty').classList.add('hidden');
  const box = $('#icpResult');
  box.classList.remove('hidden');

  const rows = [
    ['Perfil', perfil.perfilEmpresa],
    ['Cobertura', perfil.regiones.join(', ')],
    ['Monto mínimo', perfil.montoMinimo != null ? formatMonto(perfil.montoMinimo) : 'NO_ESPECIFICADO'],
    ['Monto máximo', perfil.montoMaximo != null ? formatMonto(perfil.montoMaximo) : 'NO_ESPECIFICADO'],
    ['Lote máximo', `${perfil.loteMaximo} oportunidades`],
    ['Validador', perfil.validador]
  ];

  box.innerHTML = `
    ${warning ? `<div class="notice warn">${esc(warning)}</div>` : ''}
    ${resumen ? `<div class="notice">${esc(resumen)}</div>` : ''}
    <div class="icp-block">
      <h4>Perfil</h4>
      ${rows.map(([k, v]) => `<div class="icp-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}
    </div>
    <div class="icp-block">
      <h4>Servicios prioritarios</h4>
      <div class="chip-list">${perfil.servicios.length ? perfil.servicios.map(c => `<span class="chip">${esc(c)}</span>`).join('') : '<span class="chip">NO_ESPECIFICADO</span>'}</div>
    </div>
    <div class="icp-block">
      <h4>Palabras clave</h4>
      <div class="chip-list">${perfil.keywords.length ? perfil.keywords.map(c => `<span class="chip">${esc(c)}</span>`).join('') : '<span class="chip">Ninguna</span>'}</div>
    </div>
    <div class="icp-block">
      <h4>Palabras excluidas</h4>
      <div class="chip-list">${perfil.negativeKeywords.length ? perfil.negativeKeywords.map(c => `<span class="chip">${esc(c)}</span>`).join('') : '<span class="chip">Ninguna</span>'}</div>
    </div>
    ${assumptions && assumptions.length ? `
      <div class="icp-block">
        <h4>Supuestos del agente</h4>
        <div class="notice">Estos supuestos deben validarse con el equipo comercial:<ul>${assumptions.map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>
      </div>` : ''}
    ${clarifyingQuestions && clarifyingQuestions.length ? `
      <div class="icp-block">
        <h4>Preguntas para afinar el perfil</h4>
        <div class="notice">${clarifyingQuestions.map(q => `<div>• ${esc(q)}</div>`).join('')}</div>
      </div>` : ''}
    <div class="icp-block">
      <h4>Fuente</h4>
      <div class="notice">${esc(fuente)}</div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Prospección de oportunidades
// ---------------------------------------------------------------------------

$('#prospectBtn').addEventListener('click', async () => {
  if (!state.perfil) {
    toast('Primero define un perfil en "Nuevo perfil".');
    goToView('sprint');
    return;
  }
  const btn = $('#prospectBtn');
  btn.disabled = true;
  btn.textContent = 'Buscando…';
  try {
    const result = await postJson('/api/oportunidades', { perfil: state.perfil });
    state.leads = result.oportunidades;
    state.descartadas = result.descartadas || [];
    state.feedback = [];
    state.currentLeadId = result.oportunidades.length ? result.oportunidades[0].id : null;
    saveState();
    renderLeadsTable();
    renderDashboardStats();
    const iaText =
      Number(result.perfiladasPorIA || 0) > 0
        ? ` · ${result.perfiladasPorIA} perfiladas con IA`
        : '';

    if (result.warning) {
      toast(
        `${result.oportunidades.length} oportunidades listas${iaText}. ${result.warning}`
      );
    } else {
      toast(
        `${result.oportunidades.length} oportunidades listas para revisión${iaText} (${state.descartadas.length} descartadas automáticamente).`
      );
    }
    goToView('leads');
  } catch (err) {
    toast(`Error buscando oportunidades: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Buscar oportunidades';
  }
});

function priorityClassInfo(prioridad) {
  if (prioridad === 'A') return { cls: 'a', label: 'A' };
  if (prioridad === 'B') return { cls: 'b', label: 'B' };
  if (prioridad === 'C') return { cls: 'c', label: 'C' };
  return { cls: 'd', label: 'Descartable' };
}

function leadFeedback(leadId) {
  return state.feedback.filter(f => f.leadId === leadId).slice(-1)[0] || null;
}

function renderLeadsTable() {
  $('#leadCountBadge').textContent = state.leads.length;
  const tbody = $('#leadsTable');
  const empty = $('#leadsEmpty');

  if (state.leads.length === 0) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  tbody.innerHTML = state.leads.map(op => {
    const { cls, label } = priorityClassInfo(op.prioridad);
    const fb = leadFeedback(op.id);
    const estado = fb ? fb.decision : 'PENDIENTE_HUMANO';
    const dias = op.dias_restantes;
    const plazo = dias == null ? 'NO_VERIFICADO' : (dias < 0 ? 'Vencido' : `${dias} día(s)`);
    return `
      <tr>
        <td><div class="lead-name">${esc(op.entidad)}${op.demo ? '<span class="demo-flag">DEMO</span>' : ''}</div><div class="lead-sub">${esc(op.region)} · ${esc(op.fuente)}</div></td>
        <td>${esc(op.objeto)}<div class="lead-sub">${esc(op.proceso)}</div></td>
        <td>${esc(formatMonto(op.monto))}</td>
        <td>${esc(plazo)}</td>
        <td>
          <span class="score-pill score-${cls}">${op.score}</span>
          ${op.ia_perfilado ? `
            <div class="lead-sub">
              IA ${esc(op.ia_score)} · ${esc(op.ia_relevancia)}
            </div>
          ` : ''}
        </td>
        <td><span class="score-pill score-${cls}">${esc(label)}</span></td>
        <td><span class="status-tag status-${estado}">${esc(estado)}</span></td>
        <td><button class="ghost" data-review="${esc(op.id)}">Revisar</button></td>
      </tr>
    `;
  }).join('');

  $all('[data-review]').forEach(btn => btn.addEventListener('click', () => {
    state.currentLeadId = btn.dataset.review;
    saveState();
    goToView('validation');
  }));

  renderDashboardStats();
}

$('#exportBtn').addEventListener('click', () => {
  const rows = state.leads
    .map(op => ({ op, fb: leadFeedback(op.id) }))
    .filter(({ fb }) => fb && (fb.decision === 'APROBADO' || fb.decision === 'REQUIERE_CORRECCION'));

  if (rows.length === 0) {
    toast('No hay oportunidades aprobadas o corregidas para exportar todavía.');
    return;
  }

  const header = ['entidad', 'region', 'proceso', 'objeto', 'monto', 'fecha_publicacion', 'fecha_limite', 'dias_restantes', 'score', 'prioridad', 'estado_validacion', 'fuente', 'url'];
  const csvRows = [header.join(',')];
  for (const { op, fb } of rows) {
    csvRows.push([
      op.entidad, op.region, op.proceso, op.objeto, op.monto ?? '',
      op.fecha_publicacion, op.fecha_limite, op.dias_restantes ?? '',
      op.score, op.prioridad, fb.decision, op.fuente, op.url
    ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
  }

  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ag02-oportunidades-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast(`Exportadas ${rows.length} oportunidades.`);
});

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

function pendingLeads() {
  return state.leads.filter(op => !leadFeedback(op.id));
}

function renderValidation() {
  const empty = $('#validationEmpty');
  const content = $('#validationContent');
  const pending = pendingLeads();

  $('#pendingBadge').textContent = pending.length;

  let op = state.leads.find(l => l.id === state.currentLeadId && !leadFeedback(l.id));
  if (!op) op = pending[0];

  if (!op) {
    empty.classList.remove('hidden');
    content.classList.add('hidden');
    updateProgress();
    return;
  }
  empty.classList.add('hidden');
  content.classList.remove('hidden');
  state.currentLeadId = op.id;

  const { cls } = priorityClassInfo(op.prioridad);
  const dias = op.dias_restantes;
  const plazoTexto = dias == null ? 'NO_VERIFICADO' : (dias < 0 ? `Vencido (${op.fecha_limite})` : `${dias} día(s) restantes (${op.fecha_limite})`);

  content.innerHTML = `
    <div class="lead-detail-head">
      <div>
        <h3>${esc(op.entidad)}${op.demo ? '<span class="demo-flag">DEMO</span>' : ''}</h3>
        <p>${esc(op.proceso)} · ${esc(op.region)}</p>
        <div class="lead-meta">Publicado: ${esc(op.fecha_publicacion)} · Plazo: ${esc(plazoTexto)} · Fuente: ${esc(op.fuente)}${op.avisoDemo ? ` · ${esc(op.avisoDemo)}` : ''}</div>
      </div>
      <div class="score-box">
        <strong class="score-pill score-${cls}">${op.score}</strong>
        <small>Prioridad ${esc(op.prioridad)}</small>
      </div>
    </div>

    <div class="detail-block">
      <h4>Objeto de la contratación</h4>
      <div class="detail-card">
        <div class="contact-name">${esc(op.objeto)}</div>
        <div class="contact-title">${esc(op.descripcion)}</div>
        <div class="contact-fields">
          <div>Monto: <span class="${isUnverified(op.monto) ? 'unverified' : 'verified'}">${esc(formatMonto(op.monto))}</span></div>
          <div>URL: <span class="${isUnverified(op.url) ? 'unverified' : 'verified'}">${esc(op.url)}</span></div>
          <div>Categoría detectada: ${esc(op.categoria_detectada)}</div>
        </div>
      </div>
    </div>

    <div class="detail-block">
      <h4>Compatibilidad con el perfil</h4>
      <div class="detail-card">${esc(op.compatibilidad)}</div>
    </div>

    ${op.ia_perfilado ? `
      <div class="detail-block">
        <h4>Perfilado con ChatGPT</h4>
        <div class="detail-card">
          <div><b>Afinidad IA:</b> ${esc(op.ia_score)}/100 · ${esc(op.ia_relevancia)}</div>
          <div style="margin-top:8px"><b>Resumen:</b> ${esc(op.ia_resumen)}</div>
          <div style="margin-top:8px"><b>Servicio detectado:</b> ${esc(op.ia_servicio_detectado)}</div>
          <div style="margin-top:8px"><b>Acción sugerida:</b> ${esc(op.ia_accion_sugerida)}</div>
          ${op.ia_motivos && op.ia_motivos.length ? `
            <div style="margin-top:8px"><b>Motivos:</b></div>
            ${op.ia_motivos.map(m => `<div>• ${esc(m)}</div>`).join('')}
          ` : ''}
          ${op.ia_alertas && op.ia_alertas.length ? `
            <div style="margin-top:8px"><b>Alertas:</b></div>
            ${op.ia_alertas.map(a => `<div>⚠ ${esc(a)}</div>`).join('')}
          ` : ''}
          <div class="lead-sub" style="margin-top:8px">
            Análisis orientativo. La decisión final corresponde a la validación humana.
          </div>
        </div>
      </div>
    ` : ''}

    <div class="detail-block">
      <h4>Palabras clave detectadas</h4>
      <div class="chip-list">${op.keywords_detectadas && op.keywords_detectadas.length ? op.keywords_detectadas.map(k => `<span class="chip">${esc(k)}</span>`).join('') : '<span class="chip">Ninguna</span>'}</div>
    </div>

    <div class="detail-block">
      <h4>Restricciones</h4>
      <div class="detail-card">${op.restricciones && op.restricciones.length ? op.restricciones.map(r => `<div>⚠ ${esc(r)}</div>`).join('') : 'Ninguna detectada'}</div>
    </div>

    <div class="detail-block">
      <h4>Riesgos</h4>
      <div class="detail-card">${op.riesgos && op.riesgos.length ? op.riesgos.map(r => `<div>⚠ ${esc(r)}</div>`).join('') : 'Ninguno detectado'}</div>
    </div>

    <div class="detail-block">
      <h4>Razón de la prioridad</h4>
      <div class="detail-card">${esc(op.razon_prioridad || '')}</div>
    </div>

    <div class="decision-buttons">
      <button class="btn-approve" data-decision="APROBADO">✓ Aprobar</button>
      <button class="btn-reject" data-decision="RECHAZADO">✕ Rechazar</button>
      <button class="btn-fix" data-decision="REQUIERE_CORRECCION">⟳ Corregir</button>
    </div>
  `;

  $all('[data-decision]').forEach(btn => btn.addEventListener('click', () => {
    const decision = btn.dataset.decision;
    if (decision === 'APROBADO') {
      recordFeedback(op.id, 'APROBADO', null, null, { relevancia_ok: true, monto_ok: true, haria_seguimiento: true });
      advanceValidation();
    } else {
      openReviewModal(decision, op.id);
    }
  }));

  updateProgress();
}

function updateProgress() {
  const total = state.leads.length;
  const done = state.leads.filter(l => leadFeedback(l.id)).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('#validationProgress').style.width = `${pct}%`;
  $('#progressText').textContent = `${done} / ${total}`;
}

function advanceValidation() {
  const pending = pendingLeads();
  state.currentLeadId = pending.length ? pending[0].id : null;
  saveState();
  renderValidation();
  renderLeadsTable();
  if (pending.length === 0) toast('Lote validado por completo.');
}

function recordFeedback(leadId, decision, reason, comment, criteria) {
  state.feedback.push({
    leadId,
    decision,
    reason: reason || null,
    comment: comment || null,
    criteria: criteria || null,
    timestamp: new Date().toISOString()
  });
  saveState();
}

// Modal de corrección / rechazo

const modal = $('#reviewModal');
let modalLeadId = null;

function openReviewModal(decision, leadId) {
  modalLeadId = leadId;
  $('#reviewModalTitle').textContent = decision === 'RECHAZADO' ? 'Rechazar oportunidad' : 'Corregir oportunidad';
  $('#reviewForm').decision.value = decision;
  $('#reviewForm').reset();
  $('#reviewForm').decision.value = decision;
  modal.classList.remove('hidden');
}

function closeModal() { modal.classList.add('hidden'); modalLeadId = null; }

$all('[data-close-modal]').forEach(btn => btn.addEventListener('click', closeModal));
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

$('#reviewForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const decision = fd.get('decision');
  const reason = fd.get('reason');
  const comment = fd.get('comment');
  const criteria = {
    relevancia_ok: fd.get('relevancia_ok') === 'true',
    monto_ok: fd.get('monto_ok') === 'true',
    haria_seguimiento: fd.get('haria_seguimiento') === 'true'
  };
  recordFeedback(modalLeadId, decision, reason, comment, criteria);
  closeModal();
  advanceValidation();
});

// ---------------------------------------------------------------------------
// Aprendizaje
// ---------------------------------------------------------------------------

$('#learnBtn').addEventListener('click', async () => {
  if (state.feedback.length === 0) {
    toast('Todavía no hay feedback humano registrado.');
    return;
  }
  const btn = $('#learnBtn');
  btn.disabled = true;
  btn.textContent = 'Analizando…';
  try {
    const result = await postJson('/api/aprender', { feedback: state.feedback });
    const existingTypes = new Set(state.proposedRules.map(r => r.type));
    for (const rule of result.rules) {
      if (!existingTypes.has(rule.type)) {
        state.proposedRules.push(rule);
        existingTypes.add(rule.type);
      }
    }
    state.metrics = result.metrics;
    saveState();
    renderLearning();
    toast(result.rules.length ? `${result.rules.length} regla(s) propuestas.` : 'No se detectaron patrones repetidos todavía.');
  } catch (err) {
    toast(`Error analizando feedback: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Analizar feedback';
  }
});

function renderLearning() {
  const proposed = $('#proposedRules');
  const proposedEmpty = $('#rulesEmpty');
  const approved = $('#approvedRules');
  const approvedEmpty = $('#approvedEmpty');

  if (state.proposedRules.length === 0) {
    proposed.innerHTML = '';
    proposedEmpty.classList.remove('hidden');
  } else {
    proposedEmpty.classList.add('hidden');
    proposed.innerHTML = state.proposedRules.map((rule, i) => `
      <div class="rule-card">
        <div class="rule-title">${esc(rule.explicacion)}</div>
        <div class="rule-meta">Origen: ${esc(rule.motivoOrigen)} · ${esc(rule.ocurrencias)} casos · confianza ${esc(rule.confianza)}</div>
        <div class="rule-actions">
          <button class="approve" data-approve-rule="${i}">Aprobar regla</button>
          <button data-reject-rule="${i}">Descartar</button>
        </div>
      </div>
    `).join('');
    $all('[data-approve-rule]').forEach(btn => btn.addEventListener('click', () => approveRule(Number(btn.dataset.approveRule))));
    $all('[data-reject-rule]').forEach(btn => btn.addEventListener('click', () => rejectRule(Number(btn.dataset.rejectRule))));
  }

  if (state.approvedRules.length === 0) {
    approved.innerHTML = '';
    approvedEmpty.classList.remove('hidden');
  } else {
    approvedEmpty.classList.add('hidden');
    approved.innerHTML = state.approvedRules.map(rule => `
      <div class="rule-card approved-rule">
        <div class="rule-title">${esc(rule.explicacion)}</div>
        <div class="rule-meta">Aprobada en v${esc(rule.approvedAtVersion)} · ${esc(new Date(rule.approvedAt).toLocaleDateString())}</div>
      </div>
    `).join('');
  }

  $('#versionLearning').textContent = state.version;
  $('#versionLabel').textContent = state.version;

  const m = state.metrics || {};
  $('#metricReviewed').textContent = m.reviewed ?? state.feedback.length;
  $('#metricCompany').textContent = m.relevanciaOkPct != null ? `${m.relevanciaOkPct}%` : '—';
  $('#metricTitle').textContent = m.montoOkPct != null ? `${m.montoOkPct}%` : '—';
  $('#metricContact').textContent = m.seguimientoPct != null ? `${m.seguimientoPct}%` : '—';
}

function approveRule(index) {
  const rule = state.proposedRules[index];
  if (!rule) return;
  state.version = bumpMinorVersion(state.version);
  state.approvedRules.push({ ...rule, approvedAtVersion: state.version, approvedAt: new Date().toISOString() });
  state.proposedRules.splice(index, 1);
  saveState();
  renderLearning();
  toast(`Regla aprobada. Agente actualizado a v${state.version}.`);
}

function rejectRule(index) {
  state.proposedRules.splice(index, 1);
  saveState();
  renderLearning();
}

function bumpMinorVersion(version) {
  const parts = version.split('.').map(Number);
  parts[1] = (parts[1] || 0) + 1;
  return parts.join('.');
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function renderDashboardStats() {
  const total = state.leads.length;
  const approved = state.feedback.filter(f => f.decision === 'APROBADO').length;
  const pending = pendingLeads().length;
  $('#statLeads').textContent = total;
  $('#statPending').textContent = pending;
  $('#statApproved').textContent = approved;
  $('#statAcceptance').textContent = total ? `${Math.round((approved / total) * 100)}%` : '—';
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

$('#resetBtn').addEventListener('click', () => {
  if (!confirm('Esto borra el perfil, las oportunidades y el feedback guardados en este navegador. ¿Continuar?')) return;
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

refreshStatus();
renderDashboardStats();
renderLeadsTable();
if (state.perfil) {
  renderIcpResult({
    perfil: state.perfil,
    resumen: state.perfil.resumen,
    assumptions: [],
    clarifyingQuestions: [],
    fuente: state.perfil.fuente
  });
}