import { neon } from '@neondatabase/serverless';

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const [key, ...val] = c.trim().split('=');
    cookies[key] = val.join('=');
  });
  return cookies;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sql = neon(process.env.DATABASE_URL);

  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.session;
  if (!token) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const sessions = await sql`
    SELECT user_id FROM sessions
    WHERE token = ${token} AND expires_at > NOW()
  `;
  if (sessions.length === 0) {
    return res.status(401).json({ error: 'Session expired' });
  }

  const userId = sessions[0].user_id;
  const {
    question_id,
    subject,
    unit_code,
    topic_code,
    difficulty,
    stem,
    options,
    correct_index,
    selected_index,
    is_correct,
    time_ms,
    stimulus,
    explanation,
  } = req.body;

  if (!question_id || !stem || selected_index === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    await sql`
      INSERT INTO answers (
        user_id, question_id, subject, unit_code, topic_code, difficulty,
        stem, options, correct_index, selected_index, is_correct, time_ms,
        stimulus, explanation
      ) VALUES (
        ${userId}, ${question_id}, ${subject || ''}, ${unit_code || null},
        ${topic_code || null}, ${difficulty || null}, ${stem},
        ${JSON.stringify(options || [])}, ${correct_index}, ${selected_index},
        ${is_correct}, ${time_ms || 0},
        ${stimulus ? JSON.stringify(stimulus) : null}, ${explanation || null}
      )
    `;

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
