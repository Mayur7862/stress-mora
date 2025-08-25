import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import { z } from 'zod';

// ---------------- Env & constants ----------------
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL && process.env.OPENAI_BASE_URL.startsWith('http')
    ? process.env.OPENAI_BASE_URL
    : 'https://openrouter.ai/api/v1';

const MODEL_LIST = (process.env.MODEL_PREFERENCE ||
  process.env.MODEL ||
  'openai/gpt-oss-20b:free'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!OPENROUTER_API_KEY) {
  console.warn('[WARN] OPENROUTER_API_KEY is missing — set it in .env');
}
console.log('[LLM] Using base URL:', OPENAI_BASE_URL);
console.log('[LLM] Model preference:', MODEL_LIST.join('  →  '));

// ---------------- Helpers ----------------
function normalizeDbUrl(s?: string): string {
  if (!s) return '';
  let v = s.trim();

  // If someone pasted "psql 'URI'" we extract the quoted URI
  const m1 = v.match(/psql\s+'([^']+)'/i);
  const m2 = v.match(/psql\s+"([^"]+)"/i);
  if (m1?.[1]) v = m1[1];
  else if (m2?.[1]) v = m2[1];

  // Strip any surrounding quotes
  v = v.replace(/^['"]+|['"]+$/g, '');
  return v;
}

const RAW_DB_URL = normalizeDbUrl(process.env.DATABASE_URL);
if (!RAW_DB_URL) {
  console.error('[DB] DATABASE_URL is missing. Set it in .env');
  process.exit(1);
}
try {
  console.log('[DB] Host:', new URL(RAW_DB_URL).host);
} catch {
  console.error('[DB] DATABASE_URL is not a valid URL. Got:', RAW_DB_URL);
  process.exit(1);
}

// Zod schema for the model’s structured output
const LLMResponse = z.object({
  sql: z.string(),
  explanation: z.string().optional().default(''),
  confidence: z.number().min(0).max(1).optional().default(0.5)
});


function isSafeSelect(sql: string) {
  const s = sql.trim().toUpperCase();
  if (!s.startsWith('SELECT')) return false;
  const banned = [
    ' INSERT ',
    ' UPDATE ',
    ' DELETE ',
    ' DROP ',
    ' ALTER ',
    ' CREATE ',
    ' TRUNCATE ',
    ' GRANT ',
    ' REVOKE ',
    ' COPY ',
    ' CALL ',
    ' DO '
  ];
  // strip trailing semicolons before checking
  const sanitized = s.replace(/;+$/, '');
  return !banned.some((k) => sanitized.includes(k));
}

function injectLimit(sql: string, max = 200) {
  const s = sql.replace(/;+\s*$/g, '');
  return /\bLIMIT\s+\d+/i.test(s) ? s : `${s} LIMIT ${max}`;
}

async function getSchemaSnapshot(pool: Pool) {
  const c = await pool.connect();
  try {
    const { rows } = await c.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `);
    const schema: Record<string, { columns: string[] }> = {};
    for (const r of rows) {
      schema[r.table_name] ??= { columns: [] };
      schema[r.table_name].columns.push(`${r.column_name}:${r.data_type}`);
    }
    return schema;
  } finally {
    c.release();
  }
}

// Simple model caller with retries & fallback on 429
type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string };

async function callLLMWithRetries(
  baseUrl: string,
  apiKey: string,
  messages: ChatMsg[],
  opts?: { temperature?: number; max_tokens?: number; maxAttempts?: number }
): Promise<{ content: string; usedModel: string }> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const temperature = opts?.temperature ?? 0.1;
  const max_tokens = opts?.max_tokens ?? 400;

  let lastErrText = '';

  for (const model of MODEL_LIST) {
    for (let retry = 0; retry < maxAttempts; retry++) {
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost',
          'X-Title': 'ai-db-chat'
        },
        body: JSON.stringify({ model, messages, temperature, max_tokens })
      });

      if (resp.ok) {
        const data = await resp.json();
        const content = data?.choices?.[0]?.message?.content?.trim() ?? '';
        if (content) return { content, usedModel: model };
        lastErrText = 'Empty LLM response';
      } else {
        const status = resp.status;
        const errText = await resp.text().catch(() => resp.statusText);
        lastErrText = `HTTP ${status}: ${errText}`;

        if (status === 429) {
          const backoffMs = Math.min(2000 * (retry + 1), 8000) + Math.random() * 300;
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        } else {
          break;
        }
      }
    }
  }

  throw new Error(lastErrText || 'LLM failed after retries');
}

// ---------------- App & DB ----------------
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const pool = new Pool({
  connectionString: RAW_DB_URL,
  ssl: { rejectUnauthorized: false }
});

// Serve the tiny test page
app.use(express.static('public'));

// Schema endpoint (optional)
app.get('/api/schema', async (_req, res) => {
  try {
    const schema = await getSchemaSnapshot(pool);
    res.json({ schema });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'schema_error' });
  }
});

// Main: NL -> SQL -> Execute
app.post('/api/ask', async (req, res) => {
  const question: string = (req.body?.question || '').toString();
  if (!question) return res.status(400).json({ error: 'question_required' });

  try {
    const schema = await getSchemaSnapshot(pool);

    const system = [
      'You are a Text-to-SQL assistant for PostgreSQL.',
      'Return ONLY a JSON object: {"sql":"...","explanation":"...","confidence":0.7}.',
      'Rules: Only SELECT queries. No writes or DDL. Use exact table/column names.',
      'Keep SQL concise. If ambiguous, pick the most likely using available columns.',
      'Do NOT wrap the JSON in markdown fences.'
    ].join(' ');

    const schemaStr = Object.entries(schema)
      .map(([t, v]) => `${t}(${v.columns.join(', ')})`)
      .join('\n');

    const user = [
      `Question: ${question}`,
      'Relevant schema (public):',
      schemaStr,
      'Output JSON strictly as: {"sql":"...","explanation":"...","confidence":0.7}'
    ].join('\n');

    const messages: ChatMsg[] = [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ];

    let llmRaw = '';
    let usedModel = '';
    try {
      const out = await callLLMWithRetries(OPENAI_BASE_URL, OPENROUTER_API_KEY, messages, {
        temperature: 0.1,
        max_tokens: 400,
        maxAttempts: 3
      });
      llmRaw = out.content;
      usedModel = out.usedModel;
    } catch (e: any) {
      return res.status(502).json({
        error: 'llm_error',
        detail: e?.message || 'provider_unavailable',
        hint:
          'Model may be rate-limited. Try again in a moment or set MODEL_PREFERENCE with alternatives.'
      });
    }

    
    const rawContent = llmRaw.trim();
    const jsonMatch = rawContent.match(/\{[\s\S]*\}$/);
    const jsonText = jsonMatch ? jsonMatch[0] : rawContent;

    const parsed = LLMResponse.safeParse(JSON.parse(jsonText));
    if (!parsed.success) {
      return res
        .status(502)
        .json({ error: 'llm_invalid_json', raw: rawContent, model: usedModel });
    }

    let { sql, explanation, confidence } = parsed.data;

    if (!isSafeSelect(sql)) {
      return res.status(400).json({ error: 'unsafe_or_nonselect_sql', sql, model: usedModel });
    }
    sql = injectLimit(sql);

    const c = await pool.connect();
    try {
      const t0 = Date.now();
      const result = await c.query(sql);
      const t1 = Date.now();
      res.json({
        ok: true,
        question,
        sql,
        explanation,
        confidence,
        usedModel,
        columns: result.fields.map((f: any) => f.name),
        rows: result.rows,
        rowCount: result.rowCount,
        latencyMs: t1 - t0
      });
    } finally {
      c.release();
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'ask_failed' });
  }
});

// ---------------- Boot ----------------
const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
