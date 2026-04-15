export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const API_BASE = process.env.AP_API_BASE;
  const API_KEY = process.env.AP_API_KEY;

  if (!API_BASE || !API_KEY) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const endpoint = req.body._endpoint || '/v1/items';
  const body = { ...req.body };
  delete body._endpoint;

  try {
    const upstream = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
      },
      body: JSON.stringify(body),
    });

    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: 'Upstream request failed', message: err.message });
  }
}
