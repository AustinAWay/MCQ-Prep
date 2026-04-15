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
  const { subject } = req.body;

  try {
    if (subject) {
      await sql`DELETE FROM answers WHERE user_id = ${userId} AND subject = ${subject}`;
    } else {
      await sql`DELETE FROM answers WHERE user_id = ${userId}`;
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
