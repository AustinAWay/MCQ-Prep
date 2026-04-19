import fs from 'fs';
import path from 'path';

// On Vercel, `process.cwd()` is the function root ("/var/task") which contains the
// bundled `api/` directory thanks to vercel.json's `includeFiles`. Locally it is the
// repo root. We probe a few candidates so both environments work, and avoid
// `import.meta.url` which breaks when the bundler targets CommonJS.
const DATA_ROOT = (() => {
  const candidates = [
    path.join(process.cwd(), 'api', 'grading-data'),
    path.join(process.cwd(), 'grading-data'),
    path.join('/var/task', 'api', 'grading-data'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return candidates[0];
})();

// subject slug (from upstream) -> data directory key
const SUBJECT_DIRS = {
  'ap-human-geography': 'aphg',
  'ap-us-history': 'apush',
  'ap-world-history': 'apwh',
};

// Map our frq_type values to the question_type enums used in sample_index.json
const FRQ_TYPE_TO_SAMPLE_TYPES = {
  frq_short: ['saq_stimulus', 'saq_no_stimulus', 'no_stimulus', 'one_stimulus', 'two_stimuli'],
  frq_long: ['leq'],
  frq_dbq: ['dbq'],
};

const _systemPromptCache = {};
const _sampleIndexCache = {};
const _sampleFileCache = {};

export function resolveSubjectDir(subject) {
  const dir = SUBJECT_DIRS[subject];
  if (!dir) throw new Error(`Unsupported subject: ${subject}`);
  return path.join(DATA_ROOT, dir);
}

export function loadSystemPrompt(subject) {
  if (_systemPromptCache[subject]) return _systemPromptCache[subject];
  const p = path.join(resolveSubjectDir(subject), 'system_prompt.txt');
  const text = fs.readFileSync(p, 'utf8');
  _systemPromptCache[subject] = text;
  return text;
}

function loadSampleIndex(subject) {
  if (_sampleIndexCache[subject]) return _sampleIndexCache[subject];
  const p = path.join(resolveSubjectDir(subject), 'sample_index.json');
  const idx = JSON.parse(fs.readFileSync(p, 'utf8'));
  _sampleIndexCache[subject] = idx;
  return idx;
}

function loadSampleFile(subject, filename) {
  const key = `${subject}::${filename}`;
  if (_sampleFileCache[key]) return _sampleFileCache[key];
  const p = path.join(resolveSubjectDir(subject), 'scored_sample_responses', filename);
  const text = fs.readFileSync(p, 'utf8');
  _sampleFileCache[key] = text;
  return text;
}

// Pick up to `max` scored samples for calibration. Prefer those that match the
// frq_type and overlap with the units provided. Returns an xml-ish block.
export function pickSamples({ subject, frqType, units = [], max = 3, perSampleCharCap = 12000 }) {
  let index;
  try {
    index = loadSampleIndex(subject);
  } catch {
    return '';
  }

  const acceptedTypes = new Set(FRQ_TYPE_TO_SAMPLE_TYPES[frqType] || []);
  const unitSet = new Set((units || []).map(u => parseInt(u, 10)).filter(n => !Number.isNaN(n)));

  const scored = index.map(entry => {
    let score = 0;
    if (acceptedTypes.size === 0 || acceptedTypes.has(entry.question_type)) score += 10;
    else score -= 100;
    if (entry.units && Array.isArray(entry.units)) {
      for (const u of entry.units) {
        if (unitSet.has(u)) score += 2;
      }
    }
    score += (entry.year || 0) / 10000; // slight preference for recent samples
    return { entry, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const picked = [];
  for (const { entry, score } of scored) {
    if (score < 0) break;
    picked.push(entry);
    if (picked.length >= max) break;
  }

  if (picked.length === 0) return '';

  let body = '';
  for (const entry of picked) {
    let contents;
    try {
      contents = loadSampleFile(subject, entry.filename);
    } catch {
      continue;
    }
    if (contents.length > perSampleCharCap) {
      contents = contents.slice(0, perSampleCharCap) + '\n\n...[truncated]';
    }
    const attrs = [
      entry.year ? `year="${entry.year}"` : '',
      entry.set ? `set="${entry.set}"` : '',
      entry.question ? `question="${entry.question}"` : '',
      entry.question_type ? `question_type="${entry.question_type}"` : '',
    ].filter(Boolean).join(' ');
    body += `<sample ${attrs}>\n${contents}\n</sample>\n`;
  }

  return `<scored_sample_references>\n${body}</scored_sample_references>`;
}

// Strip ```json ... ``` fences and parse the first JSON object out of a string.
export function parseJsonFromText(text) {
  if (!text) throw new Error('Empty LLM response');
  let s = text.trim();

  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) s = fenceMatch[1].trim();

  try {
    return JSON.parse(s);
  } catch {
    // Scope to the first { ... } we can find.
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1) throw new Error('Could not parse JSON from LLM response');
    let slice = s.slice(first, last > first ? last + 1 : undefined);

    try {
      return JSON.parse(slice);
    } catch {
      // Try to repair truncated JSON by closing open structures.
      const repaired = repairTruncatedJson(slice);
      if (repaired) {
        try { return JSON.parse(repaired); } catch {}
      }
      throw new Error(
        'LLM returned invalid JSON (likely truncated mid-response). Try again; if it keeps happening the response is too long for the token budget.'
      );
    }
  }
}

// Best-effort repair of JSON truncated mid-token. Walks the string tracking
// string/object/array nesting and appends whatever closers are needed.
function repairTruncatedJson(s) {
  if (!s) return null;
  let inStr = false;
  let escape = false;
  const stack = [];
  let lastCompleteValueEnd = -1; // byte after a comma/key-value where reopening is safe

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inStr = false; }
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') { stack.push(c); continue; }
    if (c === '}' || c === ']') { stack.pop(); continue; }
    if (c === ',' && stack.length > 0) lastCompleteValueEnd = i;
  }

  let out = s;
  // Close a dangling string by dropping the trailing content back to the last
  // comma/structure boundary, which is safer than inventing content.
  if (inStr) {
    if (lastCompleteValueEnd >= 0) {
      out = s.slice(0, lastCompleteValueEnd);
    } else {
      return null;
    }
  } else if (stack.length > 0) {
    // If we ended right after a comma with nothing following, strip it.
    out = out.replace(/,\s*$/, '');
  }

  // Re-walk stack for the possibly-trimmed output and append closers.
  const open = [];
  let inStr2 = false, esc2 = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (inStr2) {
      if (esc2) { esc2 = false; continue; }
      if (c === '\\') { esc2 = true; continue; }
      if (c === '"') inStr2 = false;
      continue;
    }
    if (c === '"') { inStr2 = true; continue; }
    if (c === '{' || c === '[') open.push(c);
    else if (c === '}' || c === ']') open.pop();
  }
  if (inStr2) return null; // still unbalanced strings, give up
  for (let i = open.length - 1; i >= 0; i--) {
    out += open[i] === '{' ? '}' : ']';
  }
  return out;
}

// Default grading model. Haiku 4.5 is ~3x faster than Sonnet at structured,
// rubric-driven scoring and comfortably finishes inside Vercel's 60s Hobby
// limit. Override with ANTHROPIC_MODEL env var (e.g. `claude-sonnet-4-5`).
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';

// Call the Anthropic Messages API and return the raw text of the first content block.
export async function callClaude({ systemPrompt, userMessage, maxTokens = 3500, model = DEFAULT_MODEL, timeoutMs = 58000 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`Anthropic API timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new Error(`Anthropic request failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${errText.slice(0, 400)}`);
  }
  const data = await res.json();
  const block = (data.content || []).find(c => c.type === 'text');
  if (!block || !block.text) throw new Error('Anthropic response missing text content');
  if (data.stop_reason === 'max_tokens') {
    // Attach a marker so the caller can differentiate truncation from malformed output.
    const err = new Error(`Anthropic response truncated at max_tokens (${maxTokens}). Raise max_tokens or shorten the prompt.`);
    err.truncated = true;
    err.partialText = block.text;
    throw err;
  }
  return block.text;
}

export async function callClaudeJson(args) {
  const text = await callClaude(args);
  return parseJsonFromText(text);
}

// Build the user message that carries the question and (for grading) the student response.
export function buildQuestionContext({ promptText, stimulus, documents }) {
  let ctx = '';
  if (promptText) ctx += `<question_prompt>\n${promptText}\n</question_prompt>\n`;
  if (stimulus) {
    const stimText = typeof stimulus === 'string'
      ? stimulus
      : (stimulus.content || JSON.stringify(stimulus));
    if (stimText) ctx += `<stimulus>\n${stimText}\n</stimulus>\n`;
  }
  if (Array.isArray(documents) && documents.length > 0) {
    ctx += '<documents>\n';
    for (const d of documents) {
      const head = `Document ${d.doc_number || ''}${d.title ? `: ${d.title}` : ''}${d.author ? ` — ${d.author}` : ''}${d.date ? ` (${d.date})` : ''}`.trim();
      ctx += `<document number="${d.doc_number || ''}">\n${head}\n${d.content || ''}\n${d.source_ref || d.attribution || ''}\n</document>\n`;
    }
    ctx += '</documents>\n';
  }
  return ctx;
}
