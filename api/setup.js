import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  const sql = neon(process.env.DATABASE_URL);

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS answers (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        unit_code TEXT,
        topic_code TEXT,
        difficulty TEXT,
        item_type TEXT DEFAULT 'mcq',
        stem TEXT NOT NULL,
        options JSONB NOT NULL,
        correct_index INTEGER NOT NULL,
        selected_index INTEGER NOT NULL,
        is_correct BOOLEAN NOT NULL,
        time_ms INTEGER NOT NULL,
        stimulus JSONB,
        explanation TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    await sql`
      DO $$ BEGIN
        ALTER TABLE answers ADD COLUMN IF NOT EXISTS item_type TEXT DEFAULT 'mcq';
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS frq_rubrics (
        question_id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        frq_type TEXT NOT NULL,
        unit_code TEXT,
        rubric_json JSONB NOT NULL,
        model_answer TEXT,
        source TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS frq_gradings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        frq_type TEXT,
        student_response TEXT NOT NULL,
        rubric_snapshot JSONB,
        grade_json JSONB NOT NULL,
        total_score NUMERIC,
        max_score NUMERIC,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    return res.status(200).json({ ok: true, message: 'Tables created' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
