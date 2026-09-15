'use strict';

/**
 * AG02 — PROSPECCIÓN DE CONTRATACIONES PÚBLICAS DEL PERÚ v0.1 — servidor
 * Sin dependencias externas (Node 18+). Sirve el front-end estático y expone:
 *   GET  /api/status
 *   POST /api/perfil
 *   POST /api/oportunidades
 *   POST /api/aprender
 *
 * Diseño anti-alucinación: OpenAI (cuando hay API key) SOLO extrae hechos crudos
 * (entidad, monto, fechas, url, restricciones, riesgos). El score, la categoría y
 * la prioridad los calcula este servidor de forma determinística comparando esos
 * hechos contra el perfil de la empresa. Ver AGENT_INSTRUCTIONS.md.
 *
 * Si no hay OPENAI_API_KEY configurada, el agente opera en MODO DEMO con
 * oportunidades de ejemplo, claramente marcadas como ilustrativas.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = __dirname;
const SEACE_PUBLIC_URL =
  'https://prod2.seace.gob.pe/seacebus-uiwd-pub/buscadorPublico/buscadorPublico.xhtml';

loadEnvFile(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT) || 3001;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const DEMO_MODE = !OPENAI_API_KEY;
const AGENT_VERSION = '0.1';

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const STATIC_FILES = new Set(['/index.html', '/styles.css', '/app.js']);

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function normalize(str) {
  return String(str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function isUnverified(value) {
  if (value === null || value === undefined || value === '') return true;
  const v = String(value).toUpperCase();
  return v.includes('NO_VERIFICADO') || v.includes('NO VERIFICADO') || v.includes('REQUIERE_VALIDACION') || v.includes('REQUIERE VALIDACIÓN') || v.includes('REQUIERE VALIDACION');
}

function splitList(str) {
  return String(str || '')
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(Boolean);
}


async function probarConexionSEACE() {
  let browser = null;

  try {
    console.log('[SEACE] Iniciando Chromium...');

    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ]
    });

    const context = await browser.newContext({
      locale: 'es-PE',
      viewport: {
        width: 1600,
        height: 1000
      }
    });

    const page = await context.newPage();

    page.setDefaultTimeout(60000);

    console.log('[SEACE] Abriendo portal...');

    const response = await page.goto(SEACE_PUBLIC_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    const title = await page.title();

    const texto = await page.locator('body')
      .innerText()
      .catch(() => '');

    const buscadorVisible =
      texto.includes('Buscador de Procedimientos de Selección');

    console.log('[SEACE] Portal cargado correctamente.');

    return {
      ok: true,
      statusHttp: response ? response.status() : null,
      titulo: title,
      url: page.url(),
      buscadorProcedimientosVisible: buscadorVisible
    };

  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}



// ---------------------------------------------------------------------------
// /api/perfil — estructura el perfil de empresa (equivalente al ICP del AG01)
// ---------------------------------------------------------------------------

async function handlePerfil(body) {
  const perfilEmpresa = (body.perfilEmpresa || '').trim();
  const servicios = splitList(body.servicios);
  const keywords = splitList(body.keywords);
  const negativeKeywords = splitList(body.negativeKeywords);
  const regiones = splitList(body.regiones);
  const montoMinimo = body.montoMinimo !== '' && body.montoMinimo != null ? Number(body.montoMinimo) : null;
  const montoMaximo = body.montoMaximo !== '' && body.montoMaximo != null ? Number(body.montoMaximo) : null;
  const loteMaximo = Math.min(Math.max(Number(body.count) || 10, 1), 20);
  const validador = (body.validator || '').trim();

  const clarifyingQuestions = [];
  if (!perfilEmpresa) clarifyingQuestions.push('¿Cómo describirías en una frase el perfil de tu empresa (rubro, tamaño, experiencia con el Estado)?');
  if (servicios.length === 0) clarifyingQuestions.push('¿Qué servicios o productos concretos ofrece la empresa al Estado?');
  if (keywords.length === 0) clarifyingQuestions.push('¿Qué palabras clave deberían aparecer en el objeto de la contratación para considerarla relevante?');
  if (regiones.length === 0) clarifyingQuestions.push('¿En qué regiones del Perú puede operar la empresa? (o indicar "Nacional")');
  if (montoMinimo == null || montoMaximo == null) clarifyingQuestions.push('¿Cuál es el rango comercial (monto mínimo y máximo en soles) que la empresa puede atender?');

  const basePerfil = {
    perfilEmpresa: perfilEmpresa || 'NO_ESPECIFICADO',
    servicios,
    keywords,
    negativeKeywords,
    regiones: regiones.length ? regiones : ['Nacional'],
    montoMinimo,
    montoMaximo,
    loteMaximo,
    validador: validador || 'NO_ESPECIFICADO',
    version: AGENT_VERSION
  };

  if (!DEMO_MODE) {
    try {
      const prompt = [
        'Actúas como el módulo de estructuración de perfil del agente AG02 (Prospección de Contrataciones Públicas del Perú).',
        'Tu única tarea es redactar un resumen del perfil de empresa a partir de los datos entregados, sin inventar datos nuevos.',
        'Devuelve SOLO un JSON con esta forma exacta:',
        '{"resumen": string, "assumptions": string[], "clarifyingQuestions": string[]}',
        'assumptions debe listar cualquier supuesto razonable que hiciste para redactar el resumen (vacío si no hiciste ninguno).',
        'clarifyingQuestions debe listar preguntas para el humano sobre información ambigua o faltante para prospectar contrataciones públicas.',
        'No agregues campos, texto fuera del JSON, ni marcadores de código.',
        '',
        `Datos del formulario: ${JSON.stringify(basePerfil)}`
      ].join('\n');

      const aiResult = await callOpenAIJson(prompt);
      if (aiResult && typeof aiResult === 'object') {
        return {
          perfil: basePerfil,
          resumen: aiResult.resumen || null,
          assumptions: Array.isArray(aiResult.assumptions) ? aiResult.assumptions : [],
          clarifyingQuestions: Array.isArray(aiResult.clarifyingQuestions) && aiResult.clarifyingQuestions.length
            ? aiResult.clarifyingQuestions
            : clarifyingQuestions,
          fuente: `OpenAI Responses API (${OPENAI_MODEL})`,
          demoMode: false
        };
      }
    } catch (err) {
      return {
        perfil: basePerfil,
        resumen: null,
        assumptions: [],
        clarifyingQuestions,
        fuente: 'Estructurado localmente (la llamada a OpenAI falló, ver /api/status)',
        demoMode: false,
        warning: `No se pudo consultar OpenAI: ${err.message}`
      };
    }
  }

  return {
    perfil: basePerfil,
    resumen: null,
    assumptions: [],
    clarifyingQuestions,
    fuente: 'Estructurado localmente (modo demo, sin OPENAI_API_KEY configurada)',
    demoMode: true
  };
}

// ---------------------------------------------------------------------------
// /api/oportunidades — búsqueda + score determinístico
// ---------------------------------------------------------------------------

function demoOportunidades() {
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const inDays = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d); };

  const pool = [
    {
      fuente: 'SEACE (ejemplo ilustrativo)', url: 'https://prodapp2.seace.gob.pe/ejemplo-1',
      entidad: 'Municipalidad Distrital de Ejemplo Norte', region: 'Lima', proceso: 'Adjudicación Simplificada N.º 012-2026-MDEN',
      objeto: 'Servicio de soporte técnico y mantenimiento de infraestructura tecnológica municipal',
      descripcion: 'La entidad requiere soporte técnico mensual para su red de datos, servidores y mesa de ayuda para usuarios internos.',
      monto: 185000, fecha_publicacion: iso(today), fecha_limite: inDays(9),
      restricciones: ['Experiencia mínima de 2 años en entidades públicas (REQUIERE VALIDACIÓN)'], riesgos: []
    },
    {
      fuente: 'Perú Compras (ejemplo ilustrativo)', url: 'https://www.perucompras.gob.pe/ejemplo-2',
      entidad: 'Gobierno Regional de Ejemplo Sur', region: 'Arequipa', proceso: 'Acuerdo Marco - Bienes TI',
      objeto: 'Adquisición de equipos de cómputo y licencias de software de oficina',
      descripcion: 'Renovación de parque informático para oficinas administrativas regionales.',
      monto: 420000, fecha_publicacion: iso(today), fecha_limite: inDays(21),
      restricciones: [], riesgos: ['Historial de ampliaciones de plazo en procesos anteriores (NO VERIFICADO)']
    },
    {
      fuente: 'OECE (ejemplo ilustrativo)', url: 'https://oece.gob.pe/ejemplo-3',
      entidad: 'Hospital Nacional de Ejemplo', region: 'Lima', proceso: 'Concurso Público N.º 004-2026',
      objeto: 'Consultoría para implementación de sistema de gestión documentaria',
      descripcion: 'Se busca digitalizar el archivo clínico y flujos documentarios del hospital.',
      monto: 950000, fecha_publicacion: iso(today), fecha_limite: inDays(3),
      restricciones: ['Certificación ISO 27001 vigente (REQUIERE VALIDACIÓN)'], riesgos: ['Plazo de presentación muy corto']
    },
    {
      fuente: 'Lima Compras (ejemplo ilustrativo)', url: 'https://limacompras.gob.pe/ejemplo-4',
      entidad: 'Municipalidad Metropolitana de Lima (unidad ejemplo)', region: 'Lima', proceso: 'Comparación de precios N.º 021-2026',
      objeto: 'Servicio de limpieza y mantenimiento de áreas verdes',
      descripcion: 'Mantenimiento de parques y jardines en distritos de la gestión metropolitana.',
      monto: 78000, fecha_publicacion: iso(today), fecha_limite: inDays(15),
      restricciones: [], riesgos: []
    },
    {
      fuente: 'PLADICOP (ejemplo ilustrativo)', url: 'https://pladicop.example/ejemplo-5',
      entidad: 'Municipalidad Provincial de Ejemplo Este', region: 'Cusco', proceso: 'Programación PAC 2026 (futura convocatoria)',
      objeto: 'Futura contratación de servicio de desarrollo de plataforma web municipal',
      descripcion: 'Identificado en la programación anual de contrataciones; aún no convocado formalmente.',
      monto: null, fecha_publicacion: iso(today), fecha_limite: 'NO_VERIFICADO',
      restricciones: ['Aún no convocado: monto y bases definitivas pendientes (REQUIERE VALIDACIÓN)'], riesgos: []
    },
    {
      fuente: 'SEACE (ejemplo ilustrativo)', url: 'https://prodapp2.seace.gob.pe/ejemplo-6',
      entidad: 'Empresa Minera Estatal de Ejemplo', region: 'Ancash', proceso: 'Licitación Pública N.º 002-2026',
      objeto: 'Construcción de vía de acceso a unidad minera',
      descripcion: 'Obra civil de gran envergadura sin relación con servicios tecnológicos o profesionales.',
      monto: 6500000, fecha_publicacion: iso(today), fecha_limite: inDays(30),
      restricciones: ['Requiere registro de ejecutoras de obra (REQUIERE VALIDACIÓN)'], riesgos: []
    }
  ];

  return pool.map((item, i) => ({
    id: `demo-${i + 1}`,
    demo: true,
    avisoDemo: 'Dato de ejemplo ilustrativo, no proviene de una búsqueda real en SEACE/OECE/Perú Compras. No usar para decisiones reales.',
    ...item
  }));
}

async function handleOportunidades(body) {
  const perfil = body.perfil || {};
  const loteMaximo = Math.min(
    Math.max(Number(perfil.loteMaximo) || 10, 1),
    20
  );

  let crudas = [];
  let warning = null;

  // En producción NO se generan oportunidades ficticias
  if (DEMO_MODE) {
    return {
      oportunidades: [],
      descartadas: [],
      demoMode: true,
      warning: 'No hay una OPENAI_API_KEY configurada. No se mostrarán oportunidades ficticias.'
    };
  }

  try {
    const prompt = buildOportunidadesPrompt(perfil, loteMaximo);

    console.log('[AG02] Iniciando búsqueda real de oportunidades...');

    const aiResult = await callOpenAIJson(prompt, {
      webSearch: true
    });

    if (
      aiResult &&
      Array.isArray(aiResult.oportunidades) &&
      aiResult.oportunidades.length > 0
    ) {

      crudas = aiResult.oportunidades
        .slice(0, loteMaximo * 2)
        .map((op, i) => normalizeAiOportunidad(op, i));

      console.log(
        `[AG02] ${crudas.length} oportunidades reales recibidas.`
      );

    } else {

      console.log('[AG02] La búsqueda no devolvió oportunidades.');

      return {
        oportunidades: [],
        descartadas: [],
        demoMode: false,
        warning: 'La búsqueda finalizó correctamente, pero no se encontraron oportunidades reales que coincidan con el perfil.'
      };
    }

  } catch (err) {

    console.error(
      '[AG02] Error realizando búsqueda real:',
      err
    );

    return {
      oportunidades: [],
      descartadas: [],
      demoMode: false,
      warning: `No se pudo realizar la búsqueda real: ${err.message}`
    };
  }

  // Eliminar oportunidades duplicadas
  crudas = dedupeOportunidades(crudas);

  // Calcular score
  const scored = crudas.map(op =>
    scoreOportunidad(perfil, op)
  );

  scored.sort((a, b) => b.score - a.score);

  // Separar oportunidades relevantes y descartables
  const enviables = scored
    .filter(op => op.prioridad !== 'DESCARTABLE')
    .slice(0, loteMaximo);

  const descartadas = scored.filter(
    op => op.prioridad === 'DESCARTABLE'
  );

  console.log(
    `[AG02] Resultado final: ${enviables.length} oportunidades, ${descartadas.length} descartadas.`
  );

  return {
    oportunidades: enviables,
    descartadas,
    demoMode: false,
    warning
  };
}

function buildOportunidadesPrompt(perfil, loteMaximo) {
  return [
    'Actúas como el módulo de extracción del agente AG02 (Prospección de Contrataciones Públicas del Perú).',
    'Tu única tarea es usar búsqueda web para encontrar oportunidades REALES de contratación pública peruana (convocadas o en programación) relevantes para el perfil entregado.',
    'Fuentes prioritarias: SEACE, PAC/programación pública, OECE, PLADICOP, Perú Compras, Lima Compras, portales institucionales.',
    'NO calcules score, categoría ni prioridad: eso lo hace otro módulo. SOLO extrae hechos.',
    'REGLAS ANTI-ALUCINACIÓN (obligatorias):',
    '- Nunca inventes entidades, montos, fechas, procesos ni URLs.',
    '- Si un dato no puede confirmarse con la búsqueda, usa exactamente el string "NO_VERIFICADO".',
    '- Si una condición requiere revisión humana (legal, técnica, financiera, documental), inclúyela en "restricciones" con el sufijo "(REQUIERE VALIDACIÓN)".',
    '- No confundas posibilidad comercial con elegibilidad legal: no afirmes que la empresa cumple un requisito.',
    '- Conserva siempre la URL de origen y el nombre de la fuente.',
    `- Devuelve como máximo ${loteMaximo * 2} oportunidades.`,
    'Devuelve SOLO un JSON con esta forma exacta (sin texto adicional ni markdown):',
    '{"oportunidades": [{"fuente": string, "url": string, "entidad": string, "region": string, "proceso": string, "objeto": string, "descripcion": string, "monto": number|null, "fecha_publicacion": string, "fecha_limite": string, "restricciones": string[], "riesgos": string[]}]}',
    '',
    `Perfil de empresa: ${JSON.stringify(perfil)}`
  ].join('\n');
}

function normalizeAiOportunidad(op, i) {
  return {
    id: `ai-${Date.now()}-${i}`,
    demo: false,
    fuente: op.fuente || 'NO_VERIFICADO',
    url: op.url || 'NO_VERIFICADO',
    entidad: op.entidad || 'NO_VERIFICADO',
    region: op.region || 'NO_VERIFICADO',
    proceso: op.proceso || 'NO_VERIFICADO',
    objeto: op.objeto || 'NO_VERIFICADO',
    descripcion: op.descripcion || 'NO_VERIFICADO',
    monto: op.monto ?? null,
    fecha_publicacion: op.fecha_publicacion || 'NO_VERIFICADO',
    fecha_limite: op.fecha_limite || 'NO_VERIFICADO',
    restricciones: Array.isArray(op.restricciones) ? op.restricciones : [],
    riesgos: Array.isArray(op.riesgos) ? op.riesgos : []
  };
}

function dedupeOportunidades(oportunidades) {
  const seen = new Set();
  const result = [];
  for (const op of oportunidades) {
    const key = `${normalize(op.entidad)}|${normalize(op.proceso)}|${normalize(op.objeto)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(op);
  }
  return result;
}

function diasRestantes(fechaLimite) {
  if (isUnverified(fechaLimite)) return null;
  const fecha = new Date(fechaLimite);
  if (Number.isNaN(fecha.getTime())) return null;
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  fecha.setHours(0, 0, 0, 0);
  return Math.round((fecha - hoy) / (1000 * 60 * 60 * 24));
}

function scoreOportunidad(perfil, op) {
  const texto = normalize(`${op.objeto} ${op.descripcion} ${op.entidad}`);
  const keywordsPerfil = (perfil.keywords || []).map(normalize).filter(Boolean);
  const negativas = (perfil.negativeKeywords || []).map(normalize).filter(Boolean);
  const regiones = (perfil.regiones && perfil.regiones.length ? perfil.regiones : ['Nacional']).map(normalize);
  const nacional = regiones.includes('nacional');

  const keywordsDetectadas = keywordsPerfil.filter(k => texto.includes(k));
  const negativaDetectada = negativas.find(k => texto.includes(k));

  const dias = diasRestantes(op.fecha_limite);
  const riesgos = [...(op.riesgos || [])];
  const restricciones = [...(op.restricciones || [])];

  if (negativaDetectada) {
    return {
      ...op,
      dias_restantes: dias,
      categoria_detectada: 'EXCLUIDO_POR_PALABRA_CLAVE',
      keywords_detectadas: [],
      compatibilidad: 'No compatible: contiene una palabra excluida del perfil.',
      restricciones,
      riesgos,
      score: 0,
      prioridad: 'DESCARTABLE',
      razon_prioridad: `Descartado automáticamente por contener la palabra excluida "${negativaDetectada}".`,
      estado_validacion: 'PENDIENTE_HUMANO'
    };
  }

  const breakdown = {};

  // Coincidencia de keywords/servicios: 40
  breakdown.keywords = keywordsPerfil.length === 0
    ? 0
    : Math.min(40, keywordsDetectadas.length === 0 ? 0 : 15 + (keywordsDetectadas.length - 1) * 10);

  // Rango comercial: 20
  const min = perfil.montoMinimo;
  const max = perfil.montoMaximo;
  if (op.monto == null || isUnverified(op.monto)) {
    breakdown.monto = 0;
  } else if (min == null && max == null) {
    breakdown.monto = 12;
  } else if ((min == null || op.monto >= min) && (max == null || op.monto <= max)) {
    breakdown.monto = 20;
  } else {
    breakdown.monto = 0;
  }

  // Cobertura geográfica: 15
  const regionOp = normalize(op.region);
  if (nacional) breakdown.region = 15;
  else if (isUnverified(op.region)) breakdown.region = 5;
  else if (regiones.some(r => regionOp.includes(r))) breakdown.region = 15;
  else breakdown.region = 0;

  // Vigencia del plazo: 10
  if (dias == null) {
    breakdown.vigencia = 3;
  } else if (dias < 0) {
    breakdown.vigencia = 0;
    riesgos.push('Plazo de presentación vencido o fecha límite no verificable.');
  } else if (dias <= 2) {
    breakdown.vigencia = 4;
    riesgos.push('Plazo de presentación muy corto (2 días o menos).');
  } else {
    breakdown.vigencia = 10;
  }

  // Ausencia de restricciones/riesgos: 15
  const totalFlags = restricciones.length + riesgos.length;
  breakdown.riesgo = Math.max(0, 15 - totalFlags * 5);

  const total = Math.max(0, Math.min(100, Object.values(breakdown).reduce((a, b) => a + b, 0)));

  let prioridad;
  if (total >= 75) prioridad = 'A';
  else if (total >= 55) prioridad = 'B';
  else if (total >= 35) prioridad = 'C';
  else prioridad = 'DESCARTABLE';

  const categoria_detectada = keywordsDetectadas.length
    ? keywordsDetectadas[0]
    : ((perfil.servicios && perfil.servicios[0]) || 'NO_CLASIFICADO');

  const compatibilidad = keywordsDetectadas.length
    ? `Coincide con ${keywordsDetectadas.length} palabra(s) clave del perfil: ${keywordsDetectadas.join(', ')}.`
    : 'No se detectaron coincidencias claras con las palabras clave del perfil; revisar manualmente.';

  const razon_prioridad = explainPriority(breakdown, dias, totalFlags);

  return {
    ...op,
    dias_restantes: dias,
    categoria_detectada,
    keywords_detectadas: keywordsDetectadas,
    compatibilidad,
    restricciones,
    riesgos,
    score: total,
    prioridad,
    razon_prioridad,
    estado_validacion: 'PENDIENTE_HUMANO',
    scoreBreakdown: breakdown
  };
}

function explainPriority(breakdown, dias, totalFlags) {
  const parts = [];
  if (breakdown.keywords >= 30) parts.push('alta coincidencia con palabras clave/servicios del perfil');
  else if (breakdown.keywords > 0) parts.push('coincidencia parcial con el perfil');
  else parts.push('sin coincidencia clara con las palabras clave del perfil');

  if (breakdown.monto === 20) parts.push('monto dentro del rango comercial');
  else if (breakdown.monto === 0) parts.push('monto fuera de rango o no verificado');
  else parts.push('rango comercial no definido en el perfil');

  if (breakdown.region === 15) parts.push('región cubierta');
  else if (breakdown.region === 0) parts.push('región fuera de la cobertura declarada');

  if (dias == null) parts.push('plazo no verificado');
  else if (dias < 0) parts.push('plazo vencido');
  else parts.push(`${dias} día(s) restantes`);

  if (totalFlags > 0) parts.push(`${totalFlags} restricción(es)/riesgo(s) detectados — requieren validación humana`);

  return parts.join('; ') + '.';
}

// ---------------------------------------------------------------------------
// /api/aprender
// ---------------------------------------------------------------------------

const REASON_RULE_MAP = {
  'Fuera de cobertura geográfica': { type: 'EXCLUDE_REGION', field: 'region' },
  'Monto fuera de rango comercial': { type: 'ADJUST_MONTO_RANGE', field: 'monto' },
  'Servicio no compatible con la empresa': { type: 'ADJUST_KEYWORDS', field: 'keywords' },
  'Restricción legal o técnica no cumplida': { type: 'TIGHTEN_RESTRICCIONES', field: 'restricciones' },
  'Entidad con riesgo/observaciones': { type: 'EXCLUDE_ENTIDAD_TIPO', field: 'entidad' },
  'Información desactualizada o insuficiente': { type: 'REQUIRE_MORE_VERIFICATION', field: 'calidad' }
};

function heuristicRules(feedback) {
  const counts = {};
  for (const entry of feedback) {
    if (entry.decision !== 'RECHAZADO' && entry.decision !== 'REQUIERE_CORRECCION') continue;
    if (!entry.reason) continue;
    counts[entry.reason] = counts[entry.reason] || [];
    counts[entry.reason].push(entry);
  }

  const rules = [];
  for (const [reason, entries] of Object.entries(counts)) {
    if (entries.length < 2) continue;
    const mapping = REASON_RULE_MAP[reason];
    rules.push({
      type: mapping ? mapping.type : 'REVIEW_PATTERN',
      motivoOrigen: reason,
      ocurrencias: entries.length,
      confianza: entries.length >= 3 ? 'alta' : 'media',
      explicacion: `Se detectaron ${entries.length} casos con motivo "${reason}". Se propone ajustar la regla de prospección correspondiente.`
    });
  }
  return rules;
}

async function handleAprender(body) {
  const feedback = Array.isArray(body.feedback) ? body.feedback : [];
  const reviewed = feedback.length;
  const withCriteria = feedback.filter(f => f.criteria);
  const pct = (key) => {
    const withKey = withCriteria.filter(f => f.criteria[key] !== undefined);
    if (withKey.length === 0) return null;
    const yes = withKey.filter(f => f.criteria[key] === true || f.criteria[key] === 'true').length;
    return Math.round((yes / withKey.length) * 100);
  };

  const metrics = {
    reviewed,
    relevanciaOkPct: pct('relevancia_ok'),
    montoOkPct: pct('monto_ok'),
    seguimientoPct: pct('haria_seguimiento')
  };

  if (!DEMO_MODE && feedback.length > 0) {
    try {
      const prompt = [
        'Actúas como el módulo de aprendizaje supervisado del agente AG02 (Prospección de Contrataciones Públicas del Perú).',
        'Analiza el feedback humano y PROPÓN reglas (nunca las apliques automáticamente).',
        'Solo propone una regla si detectas un patrón repetido (2 o más casos similares), no por un caso aislado.',
        'Devuelve SOLO un JSON: {"rules": [{"type": string, "motivoOrigen": string, "ocurrencias": number, "confianza": "alta"|"media"|"baja", "explicacion": string}]}',
        '',
        `Feedback: ${JSON.stringify(feedback)}`
      ].join('\n');

      const aiResult = await callOpenAIJson(prompt);
      if (aiResult && Array.isArray(aiResult.rules)) {
        return { rules: aiResult.rules, metrics, demoMode: false };
      }
    } catch (err) {
      return { rules: heuristicRules(feedback), metrics, demoMode: false, warning: `No se pudo consultar OpenAI (${err.message}); se usó el análisis heurístico local.` };
    }
  }

  return { rules: heuristicRules(feedback), metrics, demoMode: DEMO_MODE };
}

// ---------------------------------------------------------------------------
// OpenAI (Responses API) — best-effort, con fallback controlado por el caller
// ---------------------------------------------------------------------------

async function callOpenAIJson(prompt, opts = {}) {
  const payload = {
    model: OPENAI_MODEL,
    input: prompt
  };
  if (opts.webSearch) {
    payload.tools = [{ type: 'web_search' }];
  }

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI respondió ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = extractOutputText(data);
  if (!text) throw new Error('Respuesta de OpenAI sin texto utilizable');

  const jsonText = extractJson(text);
  return JSON.parse(jsonText);
}

function extractOutputText(data) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text;
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (typeof c.text === 'string' && c.text.trim()) return c.text;
        }
      }
    }
  }
  return null;
}

function extractJson(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 2_000_000) {
        reject(new Error('payload demasiado grande'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? '/index.html' : pathname;
  if (!STATIC_FILES.has(relative)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No encontrado');
    return;
  }
  const filePath = path.join(ROOT, relative);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No encontrado');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {

    // ---------------------------------------------------------
    // STATUS GENERAL
    // ---------------------------------------------------------

    if (
      req.method === 'GET' &&
      pathname === '/api/status'
    ) {
      return sendJson(res, 200, {
        version: AGENT_VERSION,
        demoMode: DEMO_MODE,
        model: DEMO_MODE ? null : OPENAI_MODEL
      });
    }


    // ---------------------------------------------------------
    // TEST DE CONEXIÓN SEACE
    // ---------------------------------------------------------

    if (
      req.method === 'GET' &&
      pathname === '/api/seace/ping'
    ) {
      try {

        const resultado =
          await probarConexionSEACE();

        return sendJson(
          res,
          200,
          resultado
        );

      } catch (err) {

        console.error(
          '[SEACE] Error de prueba:',
          err
        );

        return sendJson(res, 500, {
          ok: false,
          error: err.message
        });
      }
    }


    // ---------------------------------------------------------
    // PERFIL
    // ---------------------------------------------------------

    if (
      req.method === 'POST' &&
      pathname === '/api/perfil'
    ) {
      const body = await readJsonBody(req);
      const result = await handlePerfil(body);
      return sendJson(res, 200, result);
    }


    // ---------------------------------------------------------
    // OPORTUNIDADES
    // ---------------------------------------------------------

    if (
      req.method === 'POST' &&
      pathname === '/api/oportunidades'
    ) {
      const body = await readJsonBody(req);
      const result =
        await handleOportunidades(body);

      return sendJson(res, 200, result);
    }


    // ---------------------------------------------------------
    // APRENDIZAJE
    // ---------------------------------------------------------

    if (
      req.method === 'POST' &&
      pathname === '/api/aprender'
    ) {
      const body = await readJsonBody(req);
      const result =
        await handleAprender(body);

      return sendJson(res, 200, result);
    }


    // ---------------------------------------------------------
    // ARCHIVOS ESTÁTICOS
    // ---------------------------------------------------------

    if (req.method === 'GET') {
      return serveStatic(
        req,
        res,
        pathname
      );
    }


    res.writeHead(
      405,
      {
        'Content-Type':
          'text/plain; charset=utf-8'
      }
    );

    res.end('Método no permitido');


  } catch (err) {

    console.error(
      '[SERVER] Error:',
      err
    );

    sendJson(res, 500, {
      error:
        err.message ||
        'Error interno'
    });

  }
});



server.listen(PORT, () => {
  console.log(`AG02 — Contrataciones Públicas v${AGENT_VERSION} escuchando en http://localhost:${PORT}`);
  console.log(DEMO_MODE
    ? 'Modo DEMO activo (sin OPENAI_API_KEY). Configura .env para búsqueda real en SEACE/OECE/Perú Compras.'
    : `Modo LIVE activo con modelo "${OPENAI_MODEL}".`);
});
