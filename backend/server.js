// Per-app backend for homepage.romaine.life. Serves the static frontend —
// no server-side logic. All dynamic data (bookmarks, auth) is handled by
// fzt-frontend.romaine.life via Bearer-authenticated fetches.
//
// Kept as a Node/Express pod (not nginx) to match the house pattern across
// house-hunt, investing, kill-me, plant-agent, llm-explorer, diagrams,
// fzt-frontend — uniform Dockerfile base, port, probes, and log shape.
import express from 'express';
import morgan from 'morgan';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(morgan('combined'));

app.get('/health', (_req, res) => res.json({ status: 'healthy' }));

app.use(express.static(FRONTEND_DIR));

// SPA fallback. The app uses history.replaceState rather than client routing,
// but the fallback keeps deep URLs safe. Express 5 dropped the bare `*` route
// pattern, so use a regex.
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

app.listen(PORT, () => console.log(`[my-homepage] ready on port ${PORT}`));
