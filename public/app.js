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
  showScreen('auth');
}

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

let currentCourse = null;
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

// ── Tools state ──
let highlightMode = false;
let notesMap = {};
let notesOpen = false;

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
  showScreen('home');
}

// ── API ──

async function fetchBatch(subject, units) {
  const unit = pickRandomUnit(units);
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
    const result = await fetchBatch(course.subject, course.units);

    if (result.stimuli) {
      result.stimuli.forEach(s => { stimuliMap[s.id] = s; });
    }

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

// ── Quiz lifecycle ──

function selectCourse(key) {
  courseKey = key;
  currentCourse = key;
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
    const units = shuffle(course.units).slice(0, 3);
    const results = await Promise.all(
      units.map(u => fetchBatch(course.subject, [u]))
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

    const courseLabel = document.getElementById('course-label');
    if (courseLabel) courseLabel.textContent = course.name;
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

  let typeLabel = 'Source';
  const t = stimulus.type || stimulus.stimulus_type || '';
  if (t === 'primary_source') typeLabel = 'Primary Source';
  else if (t === 'secondary_source') typeLabel = 'Secondary Source';
  else if (t === 'data_table') typeLabel = 'Data';
  else if (t === 'graph') typeLabel = 'Graph';
  else if (t === 'map') typeLabel = 'Map';
  else if (t === 'scenario') typeLabel = 'Scenario';
  else if (t) typeLabel = t.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

  const attribution = stimulus.source_attribution || stimulus.source_ref || '';
  const content = stimulus.content || '';

  const chartData = tryParseChartJson(content);
  if (chartData) {
    const chartId = 'stimulus-chart-' + Date.now();
    setTimeout(() => renderChart(chartId, chartData), 50);
    return `
      <div class="stimulus-box">
        ${chartData.title ? `<div class="stimulus-chart-title">${escapeHtml(chartData.title)}</div>` : ''}
        <canvas id="${chartId}" class="stimulus-chart-canvas"></canvas>
        ${attribution ? `<div class="stimulus-attribution">${escapeHtml(attribution)}</div>` : ''}
      </div>
    `;
  }

  let rendered;
  if (content.includes('<table') || content.includes('<tr') || content.includes('<div')) {
    rendered = content;
  } else if (content.includes('|') && content.includes('\n')) {
    rendered = renderMarkdownTable(content);
  } else {
    rendered = escapeHtml(content);
  }

  return `
    <div class="stimulus-box">
      <div class="stimulus-content">${rendered}</div>
      ${attribution ? `<div class="stimulus-attribution">${escapeHtml(attribution)}</div>` : ''}
    </div>
  `;
}

function tryParseChartJson(content) {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') || !trimmed.includes('chart_type')) return null;
  try {
    const data = JSON.parse(trimmed);
    if (data.chart_type && data.data) return data;
  } catch {}
  return null;
}

const CHART_COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b',
  '#8b5cf6', '#ec4899', '#06b6d4', '#f97316',
];

function renderChart(canvasId, chartData) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const type = chartData.chart_type === 'scatter' ? 'scatter'
    : chartData.chart_type === 'bar' ? 'bar' : 'line';

  const xLabels = chartData.data[0]?.values?.map((_, i) => {
    if (chartData.x_label === 'Year' && chartData.data[0].values.length === 13) {
      return 2010 + i;
    }
    return i;
  });

  let datasets;

  if (type === 'scatter') {
    datasets = chartData.data.map((series, idx) => ({
      label: series.label,
      data: [{ x: series.values[0], y: series.values[1] }],
      backgroundColor: CHART_COLORS[idx % CHART_COLORS.length],
      pointRadius: 8,
      pointHoverRadius: 10,
    }));
  } else {
    datasets = chartData.data.map((series, idx) => ({
      label: series.label,
      data: series.values,
      borderColor: CHART_COLORS[idx % CHART_COLORS.length],
      backgroundColor: CHART_COLORS[idx % CHART_COLORS.length] + '20',
      fill: false,
      tension: 0.3,
      pointRadius: 3,
      yAxisID: idx === chartData.data.length - 1 && chartData.y_label_right ? 'y1' : 'y',
    }));
  }

  const scales = {};
  if (type !== 'scatter') {
    scales.x = { title: { display: !!chartData.x_label, text: chartData.x_label || '' } };
    scales.y = {
      title: { display: !!chartData.y_label_left || !!chartData.y_label, text: chartData.y_label_left || chartData.y_label || '' },
      position: 'left',
    };
    if (chartData.y_label_right) {
      scales.y1 = {
        title: { display: true, text: chartData.y_label_right },
        position: 'right',
        grid: { drawOnChartArea: false },
      };
    }
  } else {
    scales.x = { title: { display: !!chartData.x_label, text: chartData.x_label || '' } };
    scales.y = { title: { display: !!chartData.y_label, text: chartData.y_label || '' } };
  }

  new Chart(canvas, {
    type,
    data: {
      labels: type !== 'scatter' ? xLabels : undefined,
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 16, font: { size: 11 } } },
      },
      scales,
    },
  });
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

// ── Question rendering ──

function renderQuestion() {
  if (questionQueue.length === 0) {
    showLoading('Loading more questions...');
    refillQueue().then(() => {
      if (questionQueue.length > 0) {
        showScreen('quiz');
        renderQuestion();
      } else {
        showError('Could not load more questions. Please try again.');
      }
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

  const letters = ['A', 'B', 'C', 'D', 'E'];
  document.getElementById('options-list').innerHTML = q.options
    .map((opt, i) =>
      `<button class="option-btn" data-index="${i}" onclick="selectAnswer(${i})">
        <span class="option-letter">${letters[i]}</span>
        <span class="option-text">${escapeHtml(opt)}</span>
        <span class="option-cross" onclick="event.stopPropagation(); toggleCrossOut(this.parentElement);" title="Cross out">&times;</span>
      </button>`
    )
    .join('');

  document.getElementById('explanation-box').classList.add('hidden');
  document.getElementById('btn-next-inline').classList.add('hidden');
  document.getElementById('btn-check-answer').classList.add('hidden');

  // Notes: restore for this question
  const ta = document.getElementById('notes-textarea');
  if (ta) ta.value = notesMap[currentIndex] || '';

  const scrollEl = document.querySelector('.exam-question-scroll');
  if (scrollEl) scrollEl.scrollTop = 0;
  const stimScroll = document.querySelector('.exam-stimulus-scroll');
  if (stimScroll) stimScroll.scrollTop = 0;

  if (questionQueue.length <= REFILL_THRESHOLD) {
    refillQueue();
  }
}

// ── Answer selection ──

function selectAnswer(index) {
  if (answered) return;
  const btn = document.querySelectorAll('.option-btn')[index];
  if (btn && btn.classList.contains('crossed-out')) return;

  selectedOption = index;

  const buttons = document.querySelectorAll('.option-btn');
  buttons.forEach((btn, i) => {
    btn.classList.toggle('selected', i === index);
  });

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

  const buttons = document.querySelectorAll('.option-btn');
  buttons.forEach((btn, i) => {
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

  saveAnswer(q, index, isCorrect, timeMs);
}

function saveAnswer(q, selectedIndex, isCorrect, timeMs) {
  fetch('/api/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question_id: q.id,
      subject: COURSES[courseKey]?.subject || '',
      unit_code: q.unitCode,
      topic_code: q.topicCode,
      difficulty: q.difficulty,
      stem: q.stem,
      options: q.options,
      correct_index: q.correct,
      selected_index: selectedIndex,
      is_correct: isCorrect,
      time_ms: timeMs,
      stimulus: q.stimulus || null,
      explanation: q.explanation,
    }),
  }).catch(err => console.error('Failed to save answer:', err));
}

// ── Navigation ──

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

  if (highlightMode) {
    quiz.classList.add('highlight-active');
    btn.classList.add('active');
  } else {
    quiz.classList.remove('highlight-active');
    btn.classList.remove('active');
  }
}

function initHighlighter() {
  document.addEventListener('mouseup', (e) => {
    if (!highlightMode) return;

    const examBody = document.querySelector('.exam-body-wrapper');
    if (!examBody) return;

    // If clicking directly on an existing highlight, remove it
    const clickedMark = e.target.closest('mark');
    if (clickedMark && examBody.contains(clickedMark)) {
      const parent = clickedMark.parentNode;
      while (clickedMark.firstChild) {
        parent.insertBefore(clickedMark.firstChild, clickedMark);
      }
      parent.removeChild(clickedMark);
      parent.normalize();
      return;
    }

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;

    const range = sel.getRangeAt(0);
    const container = range.commonAncestorContainer;
    if (!examBody.contains(container)) return;

    try {
      const mark = document.createElement('mark');
      range.surroundContents(mark);
    } catch {
      document.execCommand('hiliteColor', false, '#fef08a');
    }

    sel.removeAllRanges();
  });
}

// ── Notes Tool ──

function toggleNotesPanel() {
  const panel = document.getElementById('notes-panel');
  const btn = document.getElementById('btn-notes');
  notesOpen = !notesOpen;

  if (notesOpen) {
    panel.classList.remove('hidden');
    btn.classList.add('active');
    const ta = document.getElementById('notes-textarea');
    if (ta) ta.focus();
  } else {
    panel.classList.add('hidden');
    btn.classList.remove('active');
  }
}

function initNotes() {
  const ta = document.getElementById('notes-textarea');
  if (!ta) return;
  ta.addEventListener('input', () => {
    notesMap[currentIndex] = ta.value;
  });
}

// ── Draggable divider ──

function initDivider() {
  const divider = document.getElementById('exam-divider');
  if (!divider) return;

  let dragging = false;
  let startX = 0;
  let leftStartWidth = 0;

  divider.addEventListener('mousedown', e => {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    const left = document.getElementById('exam-left');
    leftStartWidth = left.getBoundingClientRect().width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const left = document.getElementById('exam-left');
    const body = document.querySelector('.exam-body');
    if (!left || !body) return;

    const bodyWidth = body.getBoundingClientRect().width;
    const dividerWidth = 5;
    const minLeft = 200;
    const minRight = 280;
    const maxLeft = bodyWidth - dividerWidth - minRight;

    let newWidth = leftStartWidth + (e.clientX - startX);
    newWidth = Math.max(minLeft, Math.min(maxLeft, newWidth));

    left.style.flex = 'none';
    left.style.width = newWidth + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

// ── FRQ Mode ──

let frqItems = [];
let frqStimuli = {};
let frqIndex = 0;
let frqCourseKey = null;
let frqSeenIds = new Set();
let frqChosenType = null;

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

async function fetchFRQBatch(subject, units, frqType) {
  const unit = pickRandomUnit(units);
  const res = await fetch(API_PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subject,
      scope: { unit_code: unit },
      count: 3,
      difficulty: pickRandomDifficulty(),
      item_type: frqType,
    }),
  });
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  return res.json();
}

function selectFRQ(key) {
  frqCourseKey = key;
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

  const container = document.getElementById('frq-picker-options');
  container.innerHTML = types.map(t => {
    const info = FRQ_TYPE_INFO[t] || { name: t, desc: '' };
    return `
      <button class="frq-picker-btn" onclick="pickFRQType('${t}')">
        <h3>${info.name}</h3>
        <p>${info.desc}</p>
      </button>
    `;
  }).join('');
}

async function pickFRQType(frqType) {
  frqChosenType = frqType;
  const course = COURSES[frqCourseKey];
  showLoading(`Loading ${FRQ_TYPE_INFO[frqType]?.name || 'FRQ'}...`);

  try {
    const units = shuffle(course.units).slice(0, 3);
    const results = await Promise.all(
      units.map(u => fetchFRQBatch(course.subject, [u], frqType))
    );

    for (const r of results) {
      if (r.stimuli) r.stimuli.forEach(s => { frqStimuli[s.id] = s; });
      if (r.items) {
        for (const item of r.items) {
          if (!frqSeenIds.has(item.id)) {
            frqSeenIds.add(item.id);
            frqItems.push(item);
          }
        }
      }
    }

    frqItems = shuffle(frqItems);

    if (frqItems.length === 0) {
      showError('No questions available for this type right now. Try a different type.');
      return;
    }

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
  if (frqIndex >= frqItems.length) {
    showFRQPicker();
    return;
  }

  const item = frqItems[frqIndex];

  const stim = item.stimulus
    || (item.stimulus_id && frqStimuli[item.stimulus_id])
    || null;

  const stimEl = document.getElementById('frq-stimulus');
  if (stim && stim.content) {
    stimEl.style.display = '';
    const content = stim.content || '';
    const attribution = stim.source_attribution || stim.source_ref || '';
    let rendered;
    if (content.includes('<table') || content.includes('<tr') || content.includes('<div')) {
      rendered = content;
    } else {
      rendered = escapeHtml(content);
    }
    stimEl.innerHTML = `
      <div class="stimulus-content">${rendered}</div>
      ${attribution ? `<div class="stimulus-attribution">${escapeHtml(attribution)}</div>` : ''}
    `;
  } else {
    stimEl.innerHTML = '';
    stimEl.style.display = 'none';
  }

  document.getElementById('frq-prompt').innerHTML = escapeHtml(item.stem || '');
  document.getElementById('frq-response').value = '';

  document.getElementById('frq-show-answer').classList.remove('hidden');
  document.getElementById('frq-model-answer').classList.add('hidden');
  document.getElementById('frq-next').classList.add('hidden');
}

function showFRQAnswer() {
  const item = frqItems[frqIndex];

  let modelHtml = '';

  if (item.model_answer) {
    modelHtml += `<div class="frq-model-text">${escapeHtml(item.model_answer)}</div>`;
  }

  if (item.rubric && Array.isArray(item.rubric)) {
    modelHtml += '<div class="frq-rubric">';
    for (const r of item.rubric) {
      modelHtml += `
        <div class="frq-rubric-point">
          <strong>Point ${r.point}:</strong> ${escapeHtml(r.criteria || '')}
        </div>
      `;
      if (r.exemplar) {
        modelHtml += `<div class="frq-rubric-exemplar">${escapeHtml(r.exemplar)}</div>`;
      }
    }
    modelHtml += '</div>';
  }

  if (!modelHtml) {
    modelHtml = '<div class="frq-model-text">No model answer available.</div>';
  }

  document.getElementById('frq-model-text').innerHTML = modelHtml;
  document.getElementById('frq-model-answer').classList.remove('hidden');
  document.getElementById('frq-show-answer').classList.add('hidden');
  document.getElementById('frq-next').classList.remove('hidden');
}

function nextFRQ() {
  frqIndex++;
  if (frqIndex < frqItems.length) {
    renderFRQ();
  } else {
    showFRQPicker();
  }
}

init();
