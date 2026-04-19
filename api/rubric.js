import { neon } from '@neondatabase/serverless';
import {
  loadSystemPrompt,
  pickSamples,
  buildQuestionContext,
  callClaudeJson,
} from './_grading-utils.js';

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const [key, ...val] = c.trim().split('=');
    cookies[key] = val.join('=');
  });
  return cookies;
}

async function requireUser(req, sql) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.session;
  if (!token) return null;
  const sessions = await sql`
    SELECT user_id FROM sessions
    WHERE token = ${token} AND expires_at > NOW()
  `;
  if (sessions.length === 0) return null;
  return sessions[0].user_id;
}

function buildRubricGenerationInstructions(frqType) {
  if (frqType === 'frq_short') {
    return `You are generating an official-style rubric for an AP SAQ (Short Answer Question).
Output ONLY a single JSON object with this exact shape (no prose, no markdown fences):

{
  "rubric": [
    { "point": "a", "criteria": "What the student must accomplish for part (a) to earn the point.", "exemplar": "A concise acceptable-response exemplar showing the caliber needed.", "task_verb": "describe" | "explain" | "identify" | "compare" | "define" },
    { "point": "b", "criteria": "...", "exemplar": "...", "task_verb": "..." },
    { "point": "c", "criteria": "...", "exemplar": "...", "task_verb": "..." }
  ],
  "model_answer": "A tight model response that would earn full credit across all parts."
}

- Use exactly the number of parts the question asks for (typically a, b, c).
- Match the College Board standards demonstrated in the scored sample references.
- Criteria must make clear what earns the single binary point (0 or 1) for that part.`;
  }
  if (frqType === 'frq_long') {
    return `You are generating an official-style rubric for an AP LEQ (Long Essay Question).
Output ONLY a single JSON object with this exact shape (no prose, no markdown fences):

{
  "rubric": [
    { "row_id": "thesis_claim", "label": "Thesis / claim", "max_score": 1, "criteria": "What earns this point.", "exemplar": "Brief example of a response that would earn the point." },
    { "row_id": "contextualization", "label": "Contextualization", "max_score": 1, "criteria": "...", "exemplar": "..." },
    { "row_id": "evidence", "label": "Evidence", "max_score": 2, "criteria": "Bands for 0, 1, 2 points.", "exemplar": "..." },
    { "row_id": "analysis_and_reasoning", "label": "Analysis and reasoning", "max_score": 2, "criteria": "Bands for 0, 1, 2 including complexity expectations.", "exemplar": "..." }
  ],
  "model_answer": "A full-credit model essay (can be outlined; 150-300 words is fine)."
}

- Total max_score must sum to 6.
- Mirror the College Board LEQ rubric language shown in the scored sample references.`;
  }
  if (frqType === 'frq_dbq') {
    return `You are generating an official-style rubric for an AP DBQ (Document-Based Question).
Output ONLY a single JSON object with this exact shape (no prose, no markdown fences):

{
  "rubric": [
    { "row_id": "thesis_claim", "label": "Thesis / claim", "max_score": 1, "criteria": "...", "exemplar": "..." },
    { "row_id": "contextualization", "label": "Contextualization", "max_score": 1, "criteria": "...", "exemplar": "..." },
    { "row_id": "evidence_from_documents", "label": "Evidence from documents", "max_score": 2, "criteria": "Bands for 0, 1, 2 including document-count thresholds.", "exemplar": "..." },
    { "row_id": "evidence_beyond_documents", "label": "Evidence beyond the documents", "max_score": 1, "criteria": "...", "exemplar": "..." },
    { "row_id": "sourcing", "label": "Sourcing (HIPP)", "max_score": 1, "criteria": "How many documents must be sourced and how HIPP must serve the argument.", "exemplar": "..." },
    { "row_id": "complexity", "label": "Complexity", "max_score": 1, "criteria": "Sustained nuance expectations.", "exemplar": "..." }
  ],
  "model_answer": "A full-credit model essay (can be outlined; 200-400 words)."
}

- Total max_score must sum to 7.
- Mirror the College Board DBQ rubric language shown in the scored sample references.`;
  }
  return `Generate a rubric as a JSON object with a "rubric" array and a "model_answer" string.`;
}

async function generateRubric({ subject, frqType, units, promptText, stimulus, documents }) {
  const systemPrompt = loadSystemPrompt(subject) +
    '\n\n---\n\nFOR THIS REQUEST you are NOT grading a student response. You are generating a RUBRIC only.\n' +
    buildRubricGenerationInstructions(frqType);

  const samples = pickSamples({ subject, frqType, units, max: 2, perSampleCharCap: 10000 });
  const qctx = buildQuestionContext({ promptText, stimulus, documents });

  const userMessage = `${samples}\n\n${qctx}\n\nGenerate the rubric JSON now. Output only the JSON object, no other text.`;
  return callClaudeJson({ systemPrompt, userMessage, maxTokens: 2500 });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sql = neon(process.env.DATABASE_URL);
  const userId = await requireUser(req, sql);
  if (!userId) return res.status(401).json({ error: 'Not logged in' });

  const {
    question_id,
    subject,
    frq_type,
    unit_code,
    units,
    prompt_text,
    stimulus,
    documents,
    upstream_rubric,
    upstream_model_answer,
  } = req.body || {};

  if (!question_id || !subject || !frq_type) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const cached = await sql`
      SELECT rubric_json, model_answer, source FROM frq_rubrics WHERE question_id = ${question_id}
    `;
    if (cached.length > 0) {
      return res.status(200).json({
        rubric: cached[0].rubric_json,
        model_answer: cached[0].model_answer,
        source: cached[0].source,
      });
    }

    if (Array.isArray(upstream_rubric) && upstream_rubric.length > 0) {
      await sql`
        INSERT INTO frq_rubrics (question_id, subject, frq_type, unit_code, rubric_json, model_answer, source)
        VALUES (${question_id}, ${subject}, ${frq_type}, ${unit_code || null},
                ${JSON.stringify(upstream_rubric)}, ${upstream_model_answer || null}, 'upstream')
        ON CONFLICT (question_id) DO NOTHING
      `;
      return res.status(200).json({
        rubric: upstream_rubric,
        model_answer: upstream_model_answer || null,
        source: 'upstream',
      });
    }

    const generated = await generateRubric({
      subject,
      frqType: frq_type,
      units: units || (unit_code ? [unit_code] : []),
      promptText: prompt_text,
      stimulus,
      documents,
    });

    const rubric = generated.rubric || generated;
    const modelAnswer = generated.model_answer || null;

    await sql`
      INSERT INTO frq_rubrics (question_id, subject, frq_type, unit_code, rubric_json, model_answer, source)
      VALUES (${question_id}, ${subject}, ${frq_type}, ${unit_code || null},
              ${JSON.stringify(rubric)}, ${modelAnswer}, 'generated')
      ON CONFLICT (question_id) DO NOTHING
    `;

    return res.status(200).json({ rubric, model_answer: modelAnswer, source: 'generated' });
  } catch (err) {
    console.error('rubric error:', err);
    return res.status(500).json({ error: err.message });
  }
}
