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

async function resolveRubric({ sql, question_id, subject, frq_type, unit_code, units, prompt_text, stimulus, documents, upstream_rubric, upstream_model_answer }) {
  const cached = await sql`
    SELECT rubric_json, model_answer, source FROM frq_rubrics WHERE question_id = ${question_id}
  `;
  if (cached.length > 0) {
    return { rubric: cached[0].rubric_json, model_answer: cached[0].model_answer, source: cached[0].source };
  }

  if (Array.isArray(upstream_rubric) && upstream_rubric.length > 0) {
    await sql`
      INSERT INTO frq_rubrics (question_id, subject, frq_type, unit_code, rubric_json, model_answer, source)
      VALUES (${question_id}, ${subject}, ${frq_type}, ${unit_code || null},
              ${JSON.stringify(upstream_rubric)}, ${upstream_model_answer || null}, 'upstream')
      ON CONFLICT (question_id) DO NOTHING
    `;
    return { rubric: upstream_rubric, model_answer: upstream_model_answer || null, source: 'upstream' };
  }

  // Fallback inline rubric generation (mirrors api/rubric.js logic without cross-import).
  const systemPrompt = loadSystemPrompt(subject) +
    '\n\n---\n\nFOR THIS REQUEST you are NOT grading a student response. You are generating a RUBRIC only. ' +
    'Return a JSON object with "rubric" (array of rows/parts matching the rubric structure for this FRQ type) and "model_answer" (a full-credit example). Output only JSON.';
  const samples = pickSamples({ subject, frqType: frq_type, units: units || (unit_code ? [unit_code] : []), max: 2, perSampleCharCap: 10000 });
  const qctx = buildQuestionContext({ promptText: prompt_text, stimulus, documents });
  const userMessage = `${samples}\n\n${qctx}\n\nGenerate the rubric JSON now. Output only the JSON object.`;
  const generated = await callClaudeJson({ systemPrompt, userMessage, maxTokens: 2500 });

  const rubric = generated.rubric || generated;
  const modelAnswer = generated.model_answer || null;

  await sql`
    INSERT INTO frq_rubrics (question_id, subject, frq_type, unit_code, rubric_json, model_answer, source)
    VALUES (${question_id}, ${subject}, ${frq_type}, ${unit_code || null},
            ${JSON.stringify(rubric)}, ${modelAnswer}, 'generated')
    ON CONFLICT (question_id) DO NOTHING
  `;
  return { rubric, model_answer: modelAnswer, source: 'generated' };
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
    topic_code,
    units,
    difficulty,
    prompt_text,
    stem,
    stimulus,
    documents,
    student_response,
    upstream_rubric,
    upstream_model_answer,
  } = req.body || {};

  if (!question_id || !subject || !frq_type || !student_response) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const { rubric, model_answer, source } = await resolveRubric({
      sql,
      question_id,
      subject,
      frq_type,
      unit_code,
      units,
      prompt_text: prompt_text || stem,
      stimulus,
      documents,
      upstream_rubric,
      upstream_model_answer,
    });

    const systemPrompt = loadSystemPrompt(subject);
    const samples = pickSamples({
      subject,
      frqType: frq_type,
      units: units || (unit_code ? [unit_code] : []),
      max: 3,
      perSampleCharCap: 12000,
    });
    const qctx = buildQuestionContext({ promptText: prompt_text || stem, stimulus, documents });

    const userMessage =
      `${samples}\n\n` +
      `<rubric>\n${JSON.stringify(rubric, null, 2)}\n</rubric>\n\n` +
      `${qctx}\n` +
      `<student_response>\n${student_response}\n</student_response>\n\n` +
      `Grade this student's response according to the rubric and scored sample reference calibration. ` +
      `Return ONLY the JSON object specified in the system prompt's OUTPUT FORMAT — no prose, no markdown fences.`;

    const grade = await callClaudeJson({ systemPrompt, userMessage, maxTokens: 4000 });

    const totalScore = typeof grade.total_score === 'number' ? grade.total_score : null;
    const maxScore = typeof grade.max_score === 'number' ? grade.max_score : null;

    await sql`
      INSERT INTO frq_gradings (
        user_id, question_id, subject, frq_type, student_response,
        rubric_snapshot, grade_json, total_score, max_score
      ) VALUES (
        ${userId}, ${question_id}, ${subject}, ${frq_type}, ${student_response},
        ${JSON.stringify(rubric)}, ${JSON.stringify(grade)},
        ${totalScore}, ${maxScore}
      )
    `;

    // Also log to `answers` so home stats keep tracking FRQ progress.
    if (totalScore !== null && maxScore !== null && maxScore > 0) {
      const isCorrect = totalScore / maxScore >= 0.7;
      try {
        await sql`
          INSERT INTO answers (
            user_id, question_id, subject, unit_code, topic_code, difficulty,
            item_type, stem, options, correct_index, selected_index, is_correct,
            time_ms, stimulus, explanation
          ) VALUES (
            ${userId}, ${question_id}, ${subject}, ${unit_code || null}, ${topic_code || null},
            ${difficulty || null}, ${frq_type},
            ${prompt_text || stem || ''}, ${JSON.stringify([])},
            ${Math.round(maxScore)}, ${Math.round(totalScore)},
            ${isCorrect}, ${0},
            ${stimulus ? JSON.stringify(stimulus) : null}, ${null}
          )
        `;
      } catch (e) {
        console.error('answers insert failed:', e.message);
      }
    }

    return res.status(200).json({ grade, rubric, model_answer, rubric_source: source });
  } catch (err) {
    console.error('grade error:', err);
    return res.status(500).json({ error: err.message });
  }
}
