import { neon } from '@neondatabase/serverless';
import crypto from 'crypto';

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const [key, ...val] = c.trim().split('=');
    cookies[key] = val.join('=');
  });
  return cookies;
}

function sessionCookie(token, maxAge) {
  return `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sql = neon(process.env.DATABASE_URL);
  const { action } = req.body;

  // ── Enter (sign up or sign in by email) ──
  if (action === 'enter') {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const normalized = email.toLowerCase().trim();

    let rows = await sql`SELECT id, email FROM users WHERE email = ${normalized}`;

    if (rows.length === 0) {
      rows = await sql`
        INSERT INTO users (email, password_hash, name)
        VALUES (${normalized}, '', ${normalized.split('@')[0]})
        RETURNING id, email
      `;
    }

    const user = rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const thirtyDays = 30 * 24 * 60 * 60;

    await sql`
      INSERT INTO sessions (user_id, token, expires_at)
      VALUES (${user.id}, ${token}, NOW() + INTERVAL '30 days')
    `;

    res.setHeader('Set-Cookie', sessionCookie(token, thirtyDays));
    return res.status(200).json({ user: { id: user.id, email: user.email } });
  }

  // ── Session Check ──
  if (action === 'me') {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.session;
    if (!token) {
      return res.status(401).json({ error: 'Not logged in' });
    }

    const rows = await sql`
      SELECT u.id, u.email
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ${token} AND s.expires_at > NOW()
    `;

    if (rows.length === 0) {
      res.setHeader('Set-Cookie', sessionCookie('', 0));
      return res.status(401).json({ error: 'Session expired' });
    }

    return res.status(200).json({ user: rows[0] });
  }

  // ── Log Out ──
  if (action === 'logout') {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.session;
    if (token) {
      await sql`DELETE FROM sessions WHERE token = ${token}`;
    }
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
