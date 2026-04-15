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

  try {
    const rows = await sql`
      SELECT subject, unit_code,
        COALESCE(item_type, 'mcq') as item_type,
        COUNT(*)::int as total,
        SUM(CASE WHEN is_correct THEN 1 ELSE 0 END)::int as correct
      FROM answers
      WHERE user_id = ${userId}
      GROUP BY subject, unit_code, COALESCE(item_type, 'mcq')
    `;

    const stats = {};
    for (const row of rows) {
      if (!stats[row.subject]) stats[row.subject] = {};
      if (!stats[row.subject][row.unit_code]) stats[row.subject][row.unit_code] = {};

      const bucket = row.item_type === 'mcq' ? 'mcq' : 'frq';
      if (!stats[row.subject][row.unit_code][bucket]) {
        stats[row.subject][row.unit_code][bucket] = { total: 0, correct: 0 };
      }
      stats[row.subject][row.unit_code][bucket].total += row.total;
      stats[row.subject][row.unit_code][bucket].correct += row.correct;
    }

    return res.status(200).json({ stats });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
