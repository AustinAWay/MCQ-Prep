const API_PROXY = '/api/proxy';
const AUTH_API = '/api/auth';

let currentUser = null;

// ── Auth ──

async function checkSession() {
  try {
    const res = await fetch(AUTH_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'me' }),
    });
    if (res.ok) {
      const data = await res.json();
      currentUser = data.user;
      showScreen('home');
      loadStats();
    } else {
      showScreen('auth');
    }
  } catch {
    showScreen('auth');
  }
}

async function handleAuth(e) {
  e.preventDefault();
  const btn = document.getElementById('auth-submit');
  const errEl = document.getElementById('auth-error');
  errEl.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Loading...';
  const email = document.getElementById('auth-email').value.trim();
  try {
    const res = await fetch(AUTH_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'enter', email }),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'Something went wrong';
      errEl.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Continue';
      return;
    }
    currentUser = data.user;
    showScreen('home');
    loadStats();
  } catch {
    errEl.textContent = 'Network error. Please try again.';
    errEl.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Continue';
  }
}

async function logout() {
  await fetch(AUTH_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'logout' }),
  });
  currentUser = null;
  cachedStats = {};
  showScreen('auth');
}

// ── Courses ──

const COURSES = {
  'ap-geo': {
    name: 'AP Human Geography',
    subject: 'ap-human-geography',
    units: ['1','2','3','4','5','6','7'],
  },
  'ap-world': {
    name: 'AP World History',
    subject: 'ap-world-history',
    units: ['1','2','3','4','5','6','7','8','9'],
  },
  'apush': {
    name: 'AP U.S. History',
    subject: 'ap-us-history',
    units: ['1','2','3','4','5','6','7','8','9'],
  },
};

const BATCH_SIZE = 5;
const REFILL_THRESHOLD = 3;

// ── State ──

let courseKey = null;
let questionQueue = [];
let seenIds = new Set();
let stimuliMap = {};
let currentIndex = 0;
let totalAnswered = 0;
let totalCorrect = 0;
let answered = false;
let fetching = false;
let questionStartTime = 0;
let selectedOption = -1;
let selectedUnits = [];
let unitPickerMode = 'mcq';

let highlightMode = false;
let notesMap = {};
let notesOpen = false;

let cachedStats = {};

// ── Utilities ──

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickRandomUnit(units) {
  return units[Math.floor(Math.random() * units.length)];
}

function pickRandomDifficulty() {
  const d = ['easy', 'medium', 'medium', 'hard'];
  return d[Math.floor(Math.random() * d.length)];
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function weightedSample(items, weights, count) {
  const result = [];
  const available = items.map((item, i) => ({ item, weight: weights[i] }));
  for (let n = 0; n < count && available.length > 0; n++) {
    const totalWeight = available.reduce((s, a) => s + a.weight, 0);
    let r = Math.random() * totalWeight;
    let picked = available.length - 1;
    for (let i = 0; i < available.length; i++) {
      r -= available[i].weight;
      if (r <= 0) { picked = i; break; }
    }
    result.push(available[picked].item);
    available.splice(picked, 1);
  }
  return result;
}

// ── Stats ──

async function loadStats() {
  try {
    const res = await fetch('/api/stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const data = await res.json();
      cachedStats = data.stats || {};
      renderHomeStats();
    }
  } catch {}
}

function renderHomeStats() {
  for (const [key, course] of Object.entries(COURSES)) {
    const container = document.getElementById(`stats-${key}`);
    if (!container) continue;

    const subjectStats = cachedStats[course.subject] || {};
    const hasData = Object.keys(subjectStats).length > 0;

    if (!hasData) {
      container.classList.remove('has-data');
      container.innerHTML = '';
      continue;
    }

    container.classList.add('has-data');

    let html = '<div class="stats-grid">';
    for (const unit of course.units) {
      const us = subjectStats[unit];
      if (!us) continue;

      html += `<div class="unit-stat"><span class="unit-stat-label">U${unit}</span>`;

      if (us.mcq && us.mcq.total > 0) {
        const pct = Math.round((us.mcq.correct / us.mcq.total) * 100);
        const color = pct >= 80 ? 'green' : pct >= 50 ? 'yellow' : 'red';
        html += `<div class="stat-bar-wrap">
          <span class="stat-bar-type">M</span>
          <div class="stat-bar"><div class="stat-bar-fill ${color}" style="width:${pct}%"></div></div>
          <span class="stat-pct">${pct}%</span>
        </div>`;
      }

      if (us.frq && us.frq.total > 0) {
        const pct = Math.round((us.frq.correct / us.frq.total) * 100);
        const color = pct >= 80 ? 'green' : pct >= 50 ? 'yellow' : 'red';
        html += `<div class="stat-bar-wrap">
          <span class="stat-bar-type">F</span>
          <div class="stat-bar"><div class="stat-bar-fill ${color}" style="width:${pct}%"></div></div>
          <span class="stat-pct">${pct}%</span>
        </div>`;
      }

      html += '</div>';
    }
    html += '</div>';
    html += `<button class="reset-btn" onclick="resetProgress('${key}')">Reset progress</button>`;
    container.innerHTML = html;
  }
}

async function resetProgress(key) {
  const course = COURSES[key];
  if (!confirm(`Reset all progress for ${course.name}?`)) return;
  try {
    await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: course.subject }),
    });
    await loadStats();
  } catch {}
}

// ── Adaptive Algorithm ──

function getAdaptiveUnits(key, mode) {
  const course = COURSES[key];
  const subjectStats = cachedStats[course.subject] || {};
  const bucket = mode === 'mcq' ? 'mcq' : 'frq';

  const weights = course.units.map(u => {
    const s = subjectStats[u]?.[bucket];
    if (!s || s.total < 3) return 0.5;
    return 1 - (s.correct / s.total);
  });

  return weightedSample(course.units, weights, 3);
}

function getUnitPool(key, mode) {
  if (selectedUnits.length > 0) return selectedUnits;
  return getAdaptiveUnits(key, mode);
}

// ── Unit Picker ──

function showUnitPicker(key, mode) {
  courseKey = key;
  unitPickerMode = mode;
  selectedUnits = [];

  const course = COURSES[key];
  document.getElementById('units-title').textContent = course.name + ' — ' + mode.toUpperCase();

  const grid = document.getElementById('unit-grid');
  let html = `<button class="unit-chip adaptive selected" onclick="toggleAdaptive(this)">All Units (Adaptive)</button>`;
  for (const unit of course.units) {
    html += `<button class="unit-chip" data-unit="${unit}" onclick="toggleUnit(this, '${unit}')">Unit ${unit}</button>`;
  }
  grid.innerHTML = html;

  showScreen('units');
}

function toggleUnit(el, unit) {
  el.classList.toggle('selected');

  const adaptiveBtn = document.querySelector('.unit-chip.adaptive');
  if (adaptiveBtn) adaptiveBtn.classList.remove('selected');

  selectedUnits = [];
  document.querySelectorAll('.unit-chip[data-unit].selected').forEach(c => {
    selectedUnits.push(c.dataset.unit);
  });

  if (selectedUnits.length === 0 && adaptiveBtn) {
    adaptiveBtn.classList.add('selected');
  }
}

function toggleAdaptive(el) {
  document.querySelectorAll('.unit-chip').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  selectedUnits = [];
}

function startFromUnitPicker() {
  if (unitPickerMode === 'mcq') {
    selectCourse(courseKey);
  } else {
    selectFRQ(courseKey);
  }
}

// ── Init ──

function init() {
  initDivider();
  initHighlighter();
  initNotes();
  initCrossOut();
  checkSession();
}

function initCrossOut() {
  document.addEventListener('contextmenu', (e) => {
    const btn = e.target.closest('.option-btn');
    if (!btn || answered) return;
    e.preventDefault();
    toggleCrossOut(btn);
  });
}

function toggleCrossOut(btn) {
  if (answered) return;
  btn.classList.toggle('crossed-out');
  if (btn.classList.contains('crossed-out')) {
    btn.classList.remove('selected');
    if (selectedOption === parseInt(btn.dataset.index)) {
      selectedOption = -1;
      document.getElementById('btn-check-answer').classList.add('hidden');
    }
  }
}

// ── Screen management ──

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${id}`).classList.add('active');
}

function showLoading(message) {
  document.getElementById('loading-message').textContent = message;
  showScreen('loading');
}

function showError(message) {
  document.getElementById('error-message').textContent = message;
  showScreen('error');
}

function goHome() {
  loadStats();
  showScreen('home');
}

// ── MCQ API ──

async function fetchBatch(subject, unitPool) {
  const unit = pickRandomUnit(unitPool);
  const res = await fetch(API_PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subject,
      scope: { unit_code: unit },
      count: BATCH_SIZE,
      difficulty: pickRandomDifficulty(),
      item_type: 'mcq',
    }),
  });
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}

function normalizeItem(item, stimuli) {
  const stim = item.stimulus || (item.stimulus_id && stimuli[item.stimulus_id]) || null;
  const options = item.options.map(o => o.text);
  const letters = item.options.map(o => o.label);
  const correctIndex = letters.indexOf(item.correct_answer);
  return {
    id: item.id,
    stem: item.stem,
    options,
    correct: correctIndex,
    explanation: item.explanation || '',
    stimulus: stim,
    difficulty: item.difficulty,
    unitCode: item.unit_code,
    topicCode: item.topic_code,
  };
}

async function refillQueue() {
  if (fetching) return;
  fetching = true;
  try {
    const course = COURSES[courseKey];
    const unitPool = getUnitPool(courseKey, 'mcq');
    const result = await fetchBatch(course.subject, unitPool);
    if (result.stimuli) result.stimuli.forEach(s => { stimuliMap[s.id] = s; });
    if (result.items) {
      const newItems = result.items
        .filter(item => !seenIds.has(item.id))
        .map(item => normalizeItem(item, stimuliMap));
      newItems.forEach(q => seenIds.add(q.id));
      questionQueue.push(...newItems);
    }
  } catch (err) {
    console.error('Background fetch failed:', err);
  }
  fetching = false;
}

// ── MCQ Quiz lifecycle ──

function selectCourse(key) {
  courseKey = key;
  startQuiz(key);
}

async function startQuiz(key) {
  const course = COURSES[key];
  showLoading(`Loading ${course.name} questions...`);

  questionQueue = [];
  seenIds = new Set();
  stimuliMap = {};
  currentIndex = 0;
  totalAnswered = 0;
  totalCorrect = 0;
  notesMap = {};

  try {
    const unitPool = getUnitPool(key, 'mcq');
    const fetchUnits = unitPool.length >= 3 ? unitPool.slice(0, 3) : unitPool;
    const results = await Promise.all(
      fetchUnits.map(u => fetchBatch(course.subject, [u]))
    );

    for (const r of results) {
      if (r.stimuli) r.stimuli.forEach(s => { stimuliMap[s.id] = s; });
      if (r.items) {
        const normalized = r.items
          .filter(item => !seenIds.has(item.id))
          .map(item => normalizeItem(item, stimuliMap));
        normalized.forEach(q => seenIds.add(q.id));
        questionQueue.push(...normalized);
      }
    }

    questionQueue = shuffle(questionQueue);
    if (questionQueue.length === 0) throw new Error('No questions returned from the API.');

    showScreen('quiz');
    renderQuestion();
  } catch (err) {
    console.error('Failed to load questions:', err);
    showError(err.message);
  }
}

// ── Stimulus rendering ──

function renderStimulus(stimulus) {
  if (!stimulus) return '';
  const attribution = stimulus.source_attribution || stimulus.source_ref || '';
  const content = stimulus.content || '';

  const chartData = tryParseChartJson(content);
  if (chartData) {
    const chartId = 'stimulus-chart-' + Date.now();
    setTimeout(() => renderChart(chartId, chartData), 50);
    return `<div class="stimulus-box">
      ${chartData.title ? `<div class="stimulus-chart-title">${escapeHtml(chartData.title)}</div>` : ''}
      <canvas id="${chartId}" class="stimulus-chart-canvas"></canvas>
      ${attribution ? `<div class="stimulus-attribution">${escapeHtml(attribution)}</div>` : ''}
    </div>`;
  }

  let rendered;
  if (content.includes('<table') || content.includes('<tr') || content.includes('<div')) {
    rendered = content;
  } else if (content.includes('|') && content.includes('\n')) {
    rendered = renderMarkdownTable(content);
  } else {
    rendered = escapeHtml(content);
  }

  return `<div class="stimulus-box">
    <div class="stimulus-content">${rendered}</div>
    ${attribution ? `<div class="stimulus-attribution">${escapeHtml(attribution)}</div>` : ''}
  </div>`;
}

function tryParseChartJson(content) {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') || !trimmed.includes('chart_type')) return null;
  try { const d = JSON.parse(trimmed); if (d.chart_type && d.data) return d; } catch {}
  return null;
}

const CHART_COLORS = ['#3b82f6','#ef4444','#22c55e','#f59e0b','#8b5cf6','#ec4899','#06b6d4','#f97316'];

function renderChart(canvasId, chartData) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const type = chartData.chart_type === 'scatter' ? 'scatter' : chartData.chart_type === 'bar' ? 'bar' : 'line';
  const xLabels = chartData.data[0]?.values?.map((_, i) => chartData.x_label === 'Year' && chartData.data[0].values.length === 13 ? 2010 + i : i);
  let datasets;
  if (type === 'scatter') {
    datasets = chartData.data.map((s, i) => ({ label: s.label, data: [{ x: s.values[0], y: s.values[1] }], backgroundColor: CHART_COLORS[i % CHART_COLORS.length], pointRadius: 8 }));
  } else {
    datasets = chartData.data.map((s, i) => ({ label: s.label, data: s.values, borderColor: CHART_COLORS[i % CHART_COLORS.length], backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + '20', fill: false, tension: 0.3, pointRadius: 3, yAxisID: i === chartData.data.length - 1 && chartData.y_label_right ? 'y1' : 'y' }));
  }
  const scales = {};
  if (type !== 'scatter') {
    scales.x = { title: { display: !!chartData.x_label, text: chartData.x_label || '' } };
    scales.y = { title: { display: !!chartData.y_label_left || !!chartData.y_label, text: chartData.y_label_left || chartData.y_label || '' }, position: 'left' };
    if (chartData.y_label_right) scales.y1 = { title: { display: true, text: chartData.y_label_right }, position: 'right', grid: { drawOnChartArea: false } };
  } else {
    scales.x = { title: { display: !!chartData.x_label, text: chartData.x_label || '' } };
    scales.y = { title: { display: !!chartData.y_label, text: chartData.y_label || '' } };
  }
  new Chart(canvas, { type, data: { labels: type !== 'scatter' ? xLabels : undefined, datasets }, options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 16, font: { size: 11 } } } }, scales } });
}

function renderMarkdownTable(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return escapeHtml(text);
  const parseRow = line => line.split('|').map(c => c.trim()).filter(c => c);
  const isSep = line => /^[\s|:-]+$/.test(line);
  let html = '<table class="stimulus-table">';
  let inHeader = true;
  for (const line of lines) {
    if (isSep(line)) { inHeader = false; continue; }
    const cells = parseRow(line);
    const tag = inHeader ? 'th' : 'td';
    html += '<tr>' + cells.map(c => `<${tag}>${escapeHtml(c)}</${tag}>`).join('') + '</tr>';
    if (inHeader) inHeader = false;
  }
  return html + '</table>';
}

// ── MCQ Question rendering ──

function renderQuestion() {
  if (questionQueue.length === 0) {
    showLoading('Loading more questions...');
    refillQueue().then(() => {
      if (questionQueue.length > 0) { showScreen('quiz'); renderQuestion(); }
      else { showError('Could not load more questions. Please try again.'); }
    });
    return;
  }
  answered = false;
  questionStartTime = Date.now();
  const q = questionQueue[0];

  const examLeft = document.getElementById('exam-left');
  const examDivider = document.getElementById('exam-divider');
  const examRight = document.getElementById('exam-right');
  if (q.stimulus && q.stimulus.content) {
    examLeft.classList.remove('hidden-panel');
    examDivider.classList.remove('hidden-panel');
    examRight.classList.remove('full-width');
    document.getElementById('stimulus-container').innerHTML = renderStimulus(q.stimulus);
  } else {
    examLeft.classList.add('hidden-panel');
    examDivider.classList.add('hidden-panel');
    examRight.classList.add('full-width');
    document.getElementById('stimulus-container').innerHTML = '';
  }

  document.getElementById('question-text').textContent = q.stem;
  selectedOption = -1;
  const letters = ['A','B','C','D','E'];
  document.getElementById('options-list').innerHTML = q.options
    .map((opt, i) => `<button class="option-btn" data-index="${i}" onclick="selectAnswer(${i})">
      <span class="option-letter">${letters[i]}</span>
      <span class="option-text">${escapeHtml(opt)}</span>
      <span class="option-cross" onclick="event.stopPropagation(); toggleCrossOut(this.parentElement);" title="Cross out">&times;</span>
    </button>`).join('');

  document.getElementById('explanation-box').classList.add('hidden');
  document.getElementById('btn-next-inline').classList.add('hidden');
  document.getElementById('btn-check-answer').classList.add('hidden');

  const ta = document.getElementById('notes-textarea');
  if (ta) ta.value = notesMap[currentIndex] || '';

  const scrollEl = document.querySelector('.exam-question-scroll');
  if (scrollEl) scrollEl.scrollTop = 0;
  const stimScroll = document.querySelector('.exam-stimulus-scroll');
  if (stimScroll) stimScroll.scrollTop = 0;

  if (questionQueue.length <= REFILL_THRESHOLD) refillQueue();
}

// ── MCQ Answer selection ──

function selectAnswer(index) {
  if (answered) return;
  const btn = document.querySelectorAll('.option-btn')[index];
  if (btn && btn.classList.contains('crossed-out')) return;
  selectedOption = index;
  document.querySelectorAll('.option-btn').forEach((b, i) => b.classList.toggle('selected', i === index));
  document.getElementById('btn-check-answer').classList.remove('hidden');
}

function checkAnswer() {
  if (answered || selectedOption < 0) return;
  answered = true;
  const q = questionQueue[0];
  const index = selectedOption;
  const isCorrect = index === q.correct;
  const timeMs = Date.now() - questionStartTime;
  totalAnswered++;
  if (isCorrect) totalCorrect++;

  document.querySelectorAll('.option-btn').forEach((btn, i) => {
    btn.classList.remove('selected');
    btn.classList.add('disabled');
    if (i === q.correct) btn.classList.add('correct');
    else if (i === index && !isCorrect) btn.classList.add('incorrect');
  });
  document.getElementById('btn-check-answer').classList.add('hidden');

  const explBox = document.getElementById('explanation-box');
  document.getElementById('explanation-icon').textContent = isCorrect ? '✓' : '✗';
  document.getElementById('explanation-icon').style.color = isCorrect ? 'var(--correct)' : 'var(--incorrect)';
  document.getElementById('explanation-text').textContent = q.explanation;
  explBox.classList.remove('hidden');
  document.getElementById('btn-next-inline').classList.remove('hidden');

  saveAnswer(q, index, isCorrect, timeMs, 'mcq');
}

function saveAnswer(q, selectedIndex, isCorrect, timeMs, itemType) {
  fetch('/api/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question_id: q.id,
      subject: COURSES[courseKey]?.subject || COURSES[frqCourseKey]?.subject || '',
      unit_code: q.unitCode || q.unit_code,
      topic_code: q.topicCode || q.topic_code,
      difficulty: q.difficulty,
      item_type: itemType || 'mcq',
      stem: q.stem,
      options: q.options || [],
      correct_index: q.correct ?? 0,
      selected_index: selectedIndex,
      is_correct: isCorrect,
      time_ms: timeMs,
      stimulus: q.stimulus || null,
      explanation: q.explanation,
    }),
  }).catch(err => console.error('Failed to save answer:', err));
}

function nextQuestion() {
  if (!answered) return;
  questionQueue.shift();
  currentIndex++;
  renderQuestion();
}

// ── Highlight Tool ──

function toggleHighlightMode() {
  highlightMode = !highlightMode;
  const quiz = document.getElementById('screen-quiz');
  const btn = document.getElementById('btn-highlight');
  if (highlightMode) { quiz.classList.add('highlight-active'); btn.classList.add('active'); }
  else { quiz.classList.remove('highlight-active'); btn.classList.remove('active'); }
}

function initHighlighter() {
  document.addEventListener('mouseup', (e) => {
    if (!highlightMode) return;
    const examBody = document.querySelector('.exam-body-wrapper');
    if (!examBody) return;
    const clickedMark = e.target.closest('mark');
    if (clickedMark && examBody.contains(clickedMark)) {
      const parent = clickedMark.parentNode;
      while (clickedMark.firstChild) parent.insertBefore(clickedMark.firstChild, clickedMark);
      parent.removeChild(clickedMark);
      parent.normalize();
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!examBody.contains(range.commonAncestorContainer)) return;
    try { const mark = document.createElement('mark'); range.surroundContents(mark); }
    catch { document.execCommand('hiliteColor', false, '#fef08a'); }
    sel.removeAllRanges();
  });
}

// ── Notes Tool ──

function toggleNotesPanel() {
  const panel = document.getElementById('notes-panel');
  const btn = document.getElementById('btn-notes');
  notesOpen = !notesOpen;
  if (notesOpen) { panel.classList.remove('hidden'); btn.classList.add('active'); document.getElementById('notes-textarea')?.focus(); }
  else { panel.classList.add('hidden'); btn.classList.remove('active'); }
}

function initNotes() {
  const ta = document.getElementById('notes-textarea');
  if (!ta) return;
  ta.addEventListener('input', () => { notesMap[currentIndex] = ta.value; });
}

// ── Draggable divider ──

function initDivider() {
  const divider = document.getElementById('exam-divider');
  if (!divider) return;
  let dragging = false, startX = 0, leftStartWidth = 0;
  divider.addEventListener('mousedown', e => {
    e.preventDefault(); dragging = true; startX = e.clientX;
    leftStartWidth = document.getElementById('exam-left').getBoundingClientRect().width;
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const left = document.getElementById('exam-left');
    const body = document.querySelector('.exam-body');
    if (!left || !body) return;
    const maxLeft = body.getBoundingClientRect().width - 5 - 280;
    let newWidth = Math.max(200, Math.min(maxLeft, leftStartWidth + (e.clientX - startX)));
    left.style.flex = 'none'; left.style.width = newWidth + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; document.body.style.cursor = ''; document.body.style.userSelect = '';
  });
}

// ── FRQ Mode ──

let frqItems = [];
let frqStimuli = {};
let frqIndex = 0;
let frqCourseKey = null;
let frqSeenIds = new Set();
let frqChosenType = null;
let lastGradeRubric = null;
let lastGradeModelAnswer = null;

const FRQ_TYPE_INFO = {
  frq_short: { name: 'Short Answer (SAQ)', desc: 'Brief responses to 2-3 part questions using historical evidence.' },
  frq_long: { name: 'Long Essay (LEQ)', desc: 'Full essay with thesis, evidence, and analysis.' },
  frq_dbq: { name: 'Document-Based (DBQ)', desc: 'Essay using a set of primary source documents.' },
};

const COURSE_FRQ_TYPES = {
  'ap-geo': ['frq_short'],
  'ap-world': ['frq_short', 'frq_long', 'frq_dbq'],
  'apush': ['frq_short', 'frq_long', 'frq_dbq'],
};

async function fetchFRQBatch(subject, unitPool, frqType) {
  const unit = pickRandomUnit(unitPool);
  const res = await fetch(API_PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject, scope: { unit_code: unit }, count: 3, difficulty: pickRandomDifficulty(), item_type: frqType }),
  });
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}

function selectFRQ(key) {
  frqCourseKey = key;
  courseKey = key;
  frqItems = [];
  frqStimuli = {};
  frqSeenIds = new Set();
  frqIndex = 0;
  frqChosenType = null;
  showScreen('frq');
  showFRQPicker();
}

function showFRQPicker() {
  document.getElementById('frq-picker').classList.remove('hidden');
  document.getElementById('frq-body').classList.add('hidden');
  const course = COURSES[frqCourseKey];
  const types = COURSE_FRQ_TYPES[frqCourseKey] || ['frq_short'];
  document.getElementById('frq-picker-sub').textContent = course.name;
  document.getElementById('frq-picker-options').innerHTML = types.map(t => {
    const info = FRQ_TYPE_INFO[t] || { name: t, desc: '' };
    return `<button class="frq-picker-btn" onclick="pickFRQType('${t}')"><h3>${info.name}</h3><p>${info.desc}</p></button>`;
  }).join('');
}

async function pickFRQType(frqType) {
  frqChosenType = frqType;
  const course = COURSES[frqCourseKey];
  showLoading(`Loading ${FRQ_TYPE_INFO[frqType]?.name || 'FRQ'}...`);

  try {
    const unitPool = getUnitPool(frqCourseKey, 'frq');
    const fetchUnits = unitPool.length >= 3 ? unitPool.slice(0, 3) : unitPool;
    const results = await Promise.all(fetchUnits.map(u => fetchFRQBatch(course.subject, [u], frqType)));

    for (const r of results) {
      if (r.stimuli) r.stimuli.forEach(s => { frqStimuli[s.id] = s; });
      if (r.items) {
        for (const item of r.items) {
          if (!frqSeenIds.has(item.id)) { frqSeenIds.add(item.id); frqItems.push(item); }
        }
      }
    }
    frqItems = shuffle(frqItems);
    if (frqItems.length === 0) { showError('No questions available for this type right now. Try a different type.'); return; }

    showScreen('frq');
    document.getElementById('frq-picker').classList.add('hidden');
    document.getElementById('frq-body').classList.remove('hidden');
    renderFRQ();
  } catch (err) {
    console.error('Failed to load FRQs:', err);
    showError('Could not load FRQs. Please try again.');
  }
}

function renderFRQ() {
  if (frqIndex >= frqItems.length) { showFRQPicker(); return; }

  const item = frqItems[frqIndex];
  const stim = item.stimulus || (item.stimulus_id && frqStimuli[item.stimulus_id]) || null;
  const docs = item.documents || [];

  // Warm up the rubric so it's cached by the time the student submits.
  warmRubric(item, stim, docs);

  const stimEl = document.getElementById('frq-stimulus');

  const hasDocs = docs.length > 0;
  const hasStim = !!(stim && stim.content);

  if (hasDocs || hasStim) {
    stimEl.style.display = '';
    let html = '';
    if (hasDocs) {
      for (const doc of docs) {
        html += `<div class="frq-document">`;
        html += `<div class="frq-doc-header">Document ${doc.doc_number || ''}</div>`;
        if (doc.title || doc.author || doc.date) {
          let meta = '';
          if (doc.title) meta += `<strong>${escapeHtml(doc.title)}</strong>`;
          if (doc.author) meta += (meta ? ' — ' : '') + escapeHtml(doc.author);
          if (doc.date) meta += (meta ? ', ' : '') + escapeHtml(doc.date);
          html += `<div class="frq-doc-meta">${meta}</div>`;
        }
        if (doc.content) {
          const chartData = tryParseChartJson(doc.content);
          if (chartData) {
            const chartId = 'frq-doc-chart-' + frqIndex + '-' + (doc.doc_number || Math.random().toString(36).slice(2, 7));
            setTimeout(() => renderChart(chartId, chartData), 50);
            html += chartData.title ? `<div class="stimulus-chart-title">${escapeHtml(chartData.title)}</div>` : '';
            html += `<canvas id="${chartId}" class="stimulus-chart-canvas"></canvas>`;
          } else if (/<table|<tr|<div/i.test(doc.content)) {
            html += `<div class="frq-doc-content">${doc.content}</div>`;
          } else if (doc.content.includes('|') && doc.content.includes('\n')) {
            html += `<div class="frq-doc-content">${renderMarkdownTable(doc.content)}</div>`;
          } else {
            html += `<div class="frq-doc-content">${escapeHtml(doc.content)}</div>`;
          }
        }
        if (doc.source_ref || doc.attribution) {
          html += `<div class="stimulus-attribution">${escapeHtml(doc.source_ref || doc.attribution)}</div>`;
        }
        html += `</div>`;
      }
    } else if (hasStim) {
      html += renderStimulus(stim);
    }
    stimEl.innerHTML = html;
  } else {
    stimEl.innerHTML = '';
    stimEl.style.display = 'none';
  }

  const stemText = item.stem || '';
  const stemHtml = escapeHtml(stemText).replace(/\n/g, '<br>').replace(/•/g, '<br>•');
  document.getElementById('frq-prompt').innerHTML = stemHtml;

  lastGradeRubric = null;
  lastGradeModelAnswer = null;
  const respEl = document.getElementById('frq-response');
  respEl.value = '';
  respEl.disabled = false;
  const submitBtn = document.getElementById('frq-submit');
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit for Grading';
    submitBtn.classList.remove('hidden');
  }
  document.getElementById('frq-show-answer').classList.remove('hidden');
  document.getElementById('frq-model-answer').classList.add('hidden');
  const grading = document.getElementById('frq-grading');
  if (grading) {
    grading.classList.add('hidden');
    document.getElementById('frq-grading-result').innerHTML = '';
    document.getElementById('frq-grading-loading').classList.add('hidden');
  }
  document.getElementById('frq-next').classList.add('hidden');
}

function buildRubricPayload(item, stim, docs) {
  const course = COURSES[frqCourseKey];
  return {
    question_id: item.id,
    subject: course ? course.subject : '',
    frq_type: frqChosenType || item.item_type || 'frq_short',
    unit_code: item.unit_code || null,
    units: item.unit_code ? [item.unit_code] : [],
    prompt_text: item.stem || '',
    stem: item.stem || '',
    stimulus: stim || null,
    documents: docs || [],
    upstream_rubric: Array.isArray(item.rubric) ? item.rubric : null,
    upstream_model_answer: item.model_answer || null,
  };
}

function warmRubric(item, stim, docs) {
  if (!item || !item.id) return;
  const payload = buildRubricPayload(item, stim, docs);
  fetch('/api/rubric', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

async function submitFRQForGrading() {
  const item = frqItems[frqIndex];
  if (!item) return;
  const respEl = document.getElementById('frq-response');
  const response = (respEl.value || '').trim();
  if (!response) {
    alert('Please write a response before submitting.');
    return;
  }

  const stim = item.stimulus || (item.stimulus_id && frqStimuli[item.stimulus_id]) || null;
  const docs = item.documents || [];

  respEl.disabled = true;
  const submitBtn = document.getElementById('frq-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Grading...';

  const gradingEl = document.getElementById('frq-grading');
  const loadingEl = document.getElementById('frq-grading-loading');
  const resultEl = document.getElementById('frq-grading-result');
  gradingEl.classList.remove('hidden');
  loadingEl.classList.remove('hidden');
  resultEl.innerHTML = '';

  const payload = {
    ...buildRubricPayload(item, stim, docs),
    topic_code: item.topic_code || null,
    difficulty: item.difficulty || null,
    student_response: response,
  };

  try {
    const res = await fetch('/api/grade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    let payloadBody = null;
    let rawText = '';
    try { payloadBody = await res.clone().json(); }
    catch { try { rawText = await res.text(); } catch {} }

    if (!res.ok) {
      const err = new Error(
        (payloadBody && payloadBody.error) ||
        (rawText && rawText.slice(0, 400)) ||
        `Grading failed (HTTP ${res.status})`
      );
      err.code = payloadBody && payloadBody.code;
      err.status = res.status;
      throw err;
    }

    const data = payloadBody || {};
    lastGradeRubric = data.rubric || null;
    lastGradeModelAnswer = data.model_answer || null;
    loadingEl.classList.add('hidden');
    resultEl.innerHTML = renderGrading(data.grade);
    document.getElementById('frq-next').classList.remove('hidden');
    submitBtn.classList.add('hidden');
  } catch (err) {
    loadingEl.classList.add('hidden');
    resultEl.innerHTML = renderGradingError(err);
    submitBtn.disabled = false;
    submitBtn.textContent = 'Retry Grading';
    respEl.disabled = false;
    document.getElementById('frq-next').classList.remove('hidden');
  }
}

function renderGradingError(err) {
  const code = err && err.code;
  const msg = (err && err.message) || 'Unknown error';

  if (code === 'missing_api_key') {
    return `<div class="frq-grade-error">
      <div class="frq-grade-error-title">Grading not configured</div>
      <p>The server is missing the <code>ANTHROPIC_API_KEY</code> environment variable. An admin needs to add it:</p>
      <ol>
        <li>Open the project in Vercel &rarr; <strong>Settings</strong> &rarr; <strong>Environment Variables</strong>.</li>
        <li>Add a new variable with name <code>ANTHROPIC_API_KEY</code> and value from console.anthropic.com.</li>
        <li>Apply to Production (and Preview), then redeploy.</li>
      </ol>
      <p class="frq-grade-error-detail">${escapeHtml(msg)}</p>
    </div>`;
  }
  if (code === 'missing_db' || code === 'missing_tables') {
    return `<div class="frq-grade-error">
      <div class="frq-grade-error-title">Database not set up</div>
      <p>The grading tables do not exist yet. An admin should hit <code>/api/setup</code> once to create them.</p>
      <p class="frq-grade-error-detail">${escapeHtml(msg)}</p>
    </div>`;
  }
  if (code === 'anthropic_error') {
    return `<div class="frq-grade-error">
      <div class="frq-grade-error-title">Claude API error</div>
      <p>The grading model returned an error. This is usually rate limiting, a bad API key, or an invalid model name.</p>
      <p class="frq-grade-error-detail">${escapeHtml(msg)}</p>
      <p class="frq-grade-error-hint">You can retry, or view the model answer below.</p>
    </div>`;
  }
  if (code === 'parse_error') {
    return `<div class="frq-grade-error">
      <div class="frq-grade-error-title">Grader returned malformed output</div>
      <p>The grading model returned text we could not parse as JSON. Try again.</p>
      <p class="frq-grade-error-detail">${escapeHtml(msg)}</p>
    </div>`;
  }
  return `<div class="frq-grade-error">
    <div class="frq-grade-error-title">Grading failed</div>
    <p class="frq-grade-error-detail">${escapeHtml(msg)}</p>
    <p class="frq-grade-error-hint">You can retry, or view the model answer below.</p>
  </div>`;
}

function colorForPct(pct) {
  if (pct >= 80) return 'green';
  if (pct >= 50) return 'yellow';
  return 'red';
}

function renderGrading(grade) {
  if (!grade) return '<div class="frq-grade-error">No grading returned.</div>';

  if (grade.context_sufficient === false) {
    return `<div class="frq-grade-error">Grading incomplete: ${escapeHtml(grade.missing_context || 'insufficient context')}.</div>`;
  }

  const total = typeof grade.total_score === 'number' ? grade.total_score : null;
  const max = typeof grade.max_score === 'number' ? grade.max_score : null;
  const pct = (total !== null && max) ? Math.round((total / max) * 100) : null;
  const color = pct !== null ? colorForPct(pct) : 'yellow';

  let html = '<div class="frq-grade">';
  html += `<div class="frq-grade-header">
    <div class="frq-grade-score ${color}">
      <span class="frq-grade-num">${total !== null ? total : '?'}</span>
      <span class="frq-grade-slash">/</span>
      <span class="frq-grade-max">${max !== null ? max : '?'}</span>
    </div>
    <div class="frq-grade-meta">
      <div class="frq-grade-type">${grade.question_type ? escapeHtml(grade.question_type.toUpperCase()) : 'FRQ'}</div>
      ${pct !== null ? `<div class="frq-grade-pct">${pct}%</div>` : ''}
    </div>
  </div>`;

  const items = Array.isArray(grade.parts) ? grade.parts : (Array.isArray(grade.rows) ? grade.rows : []);
  const isParts = Array.isArray(grade.parts);

  if (items.length > 0) {
    html += '<div class="frq-grade-items">';
    for (const it of items) {
      const label = isParts
        ? `Part (${it.part || ''})`
        : (it.label || it.row_id || 'Row');
      const score = typeof it.score === 'number' ? it.score : (it.earned ? 1 : 0);
      const rowMax = typeof it.max_score === 'number' ? it.max_score : 1;
      const earned = score > 0;
      const full = rowMax > 0 && score >= rowMax;
      const badgeClass = full ? 'full' : (earned ? 'partial' : 'none');
      html += `<div class="frq-grade-item">
        <div class="frq-grade-item-head">
          <span class="frq-grade-item-label">${escapeHtml(label)}</span>
          <span class="frq-grade-badge ${badgeClass}">${score} / ${rowMax}</span>
        </div>`;
      if (it.task_verb) {
        html += `<div class="frq-grade-verb">Task verb: <em>${escapeHtml(it.task_verb)}</em></div>`;
      }
      if (it.rubric_requirement) {
        html += `<div class="frq-grade-sect"><span class="frq-grade-sect-label">Rubric requires:</span> ${escapeHtml(it.rubric_requirement)}</div>`;
      }
      if (it.student_quote) {
        const quote = Array.isArray(it.student_quote) ? it.student_quote.join(' / ') : it.student_quote;
        html += `<details class="frq-grade-details"><summary>Student quote</summary><div class="frq-grade-quote">${escapeHtml(quote)}</div></details>`;
      }
      if (it.reasoning) {
        html += `<div class="frq-grade-sect"><span class="frq-grade-sect-label">Reasoning:</span> ${escapeHtml(it.reasoning)}</div>`;
      }
      if (it.college_board_justification) {
        html += `<details class="frq-grade-details"><summary>College Board alignment</summary><div class="frq-grade-para">${escapeHtml(it.college_board_justification)}</div></details>`;
      }
      if (it.precedent) {
        html += `<details class="frq-grade-details"><summary>Scored-sample precedent</summary><div class="frq-grade-para">${escapeHtml(it.precedent)}</div></details>`;
      }
      if (it.remediation) {
        html += `<div class="frq-grade-remed"><span class="frq-grade-sect-label">To earn this point:</span> ${escapeHtml(it.remediation)}</div>`;
      }
      html += '</div>';
    }
    html += '</div>';
  }

  const oa = grade.overall_analysis;
  if (oa && typeof oa === 'object') {
    html += '<div class="frq-grade-overall"><h3>Overall analysis</h3>';
    if (oa.strengths) html += `<div class="frq-grade-sect"><span class="frq-grade-sect-label">Strengths:</span> ${escapeHtml(oa.strengths)}</div>`;
    if (oa.critical_gaps) html += `<div class="frq-grade-sect"><span class="frq-grade-sect-label">Critical gaps:</span> ${escapeHtml(oa.critical_gaps)}</div>`;
    if (oa.performance_level) html += `<div class="frq-grade-sect"><span class="frq-grade-sect-label">Performance level:</span> ${escapeHtml(oa.performance_level)}</div>`;
    if (oa.skill_recommendations) html += `<div class="frq-grade-sect"><span class="frq-grade-sect-label">Recommendations:</span> ${escapeHtml(oa.skill_recommendations)}</div>`;
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function showFRQAnswer() {
  const item = frqItems[frqIndex];
  const modelAnswer = item.model_answer || lastGradeModelAnswer || '';
  const rubric = (Array.isArray(item.rubric) && item.rubric.length > 0) ? item.rubric
               : (Array.isArray(lastGradeRubric) ? lastGradeRubric : null);

  let modelHtml = '';
  if (modelAnswer) modelHtml += `<div class="frq-model-text">${escapeHtml(modelAnswer)}</div>`;
  if (rubric) {
    modelHtml += '<div class="frq-rubric">';
    for (const r of rubric) {
      const header = r.point
        ? `Point ${escapeHtml(String(r.point))}`
        : (r.label ? escapeHtml(r.label) : (r.row_id ? escapeHtml(r.row_id) : 'Rubric'));
      const scoreSuffix = typeof r.max_score === 'number' ? ` (${r.max_score} pt${r.max_score === 1 ? '' : 's'})` : '';
      modelHtml += `<div class="frq-rubric-point"><strong>${header}${scoreSuffix}:</strong> ${escapeHtml(r.criteria || '')}</div>`;
      if (r.exemplar) modelHtml += `<div class="frq-rubric-exemplar">${escapeHtml(r.exemplar)}</div>`;
    }
    modelHtml += '</div>';
  }
  if (!modelHtml) modelHtml = '<div class="frq-model-text">No model answer available.</div>';

  document.getElementById('frq-model-text').innerHTML = modelHtml;
  document.getElementById('frq-model-answer').classList.remove('hidden');
  document.getElementById('frq-show-answer').classList.add('hidden');
  document.getElementById('frq-next').classList.remove('hidden');
}

function nextFRQ() {
  frqIndex++;
  if (frqIndex < frqItems.length) renderFRQ();
  else showFRQPicker();
}

init();
