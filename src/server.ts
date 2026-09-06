import express from 'express';
import path from 'path';
import { search, close } from './db';

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);

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
