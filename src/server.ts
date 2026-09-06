import express from 'express';
import path from 'path';
import { search, close } from './db';

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);

// --- HTTP Basic Auth (optional; enabled when AUTH_USER + AUTH_PASS are set) ---
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';
const authEnabled = AUTH_USER !== '' && AUTH_PASS !== '';

function sendChallenge(res: express.Response): void {
  res.setHeader('WWW-Authenticate', 'Basic realm="Product Lookup"');
  res.status(401).send('Authentication required');
}

app.use((req, res, next) => {
  // Keep the health check open (it reveals nothing).
  if (req.path === '/api/health') return next();

  if (!authEnabled) return next();

  const header = req.headers.authorization || '';
  const match = /^Basic (.+)$/.exec(header);
  if (!match) return sendChallenge(res);

  const decoded = Buffer.from(match[1], 'base64').toString('utf-8');
  const sep = decoded.indexOf(':');
  const user = sep === -1 ? decoded : decoded.slice(0, sep);
  const pass = sep === -1 ? '' : decoded.slice(sep + 1);

  if (user === AUTH_USER && pass === AUTH_PASS) return next();
  return sendChallenge(res);
});

// Static front-end
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  try {
    const results = await search(q);
    res.json({ query: q, results });
  } catch (error) {
    console.error('search failed', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

const server = app.listen(port, () => {
  console.log(`Product lookup UI listening on http://localhost:${port}`);
});

async function shutdown(): Promise<void> {
  await close();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
