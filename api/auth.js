import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
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

  // ── Sign Up ──
  if (action === 'signup') {
    const { email, password, name } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const existing = await sql`SELECT id FROM users WHERE email = ${email.toLowerCase().trim()}`;
    if (existing.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const hash = await bcrypt.hash(password, 10);
    const rows = await sql`
      INSERT INTO users (email, password_hash, name)
      VALUES (${email.toLowerCase().trim()}, ${hash}, ${name || ''})
      RETURNING id, email, name
    `;
    const user = rows[0];

    const token = crypto.randomBytes(32).toString('hex');
    const thirtyDays = 30 * 24 * 60 * 60;
    await sql`
      INSERT INTO sessions (user_id, token, expires_at)
      VALUES (${user.id}, ${token}, NOW() + INTERVAL '30 days')
    `;

    res.setHeader('Set-Cookie', sessionCookie(token, thirtyDays));
    return res.status(200).json({ user: { id: user.id, email: user.email, name: user.name } });
  }

  // ── Log In ──
  if (action === 'login') {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const rows = await sql`SELECT id, email, name, password_hash FROM users WHERE email = ${email.toLowerCase().trim()}`;
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const thirtyDays = 30 * 24 * 60 * 60;
    await sql`
      INSERT INTO sessions (user_id, token, expires_at)
      VALUES (${user.id}, ${token}, NOW() + INTERVAL '30 days')
    `;

    res.setHeader('Set-Cookie', sessionCookie(token, thirtyDays));
    return res.status(200).json({ user: { id: user.id, email: user.email, name: user.name } });
  }

  // ── Session Check ──
  if (action === 'me') {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.session;
    if (!token) {
      return res.status(401).json({ error: 'Not logged in' });
    }

    const rows = await sql`
      SELECT u.id, u.email, u.name
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
