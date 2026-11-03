// Entry point: `npm start` -> node --env-file-if-exists=.env server/index.mjs (port 8017).
import { createApp } from './app.mjs';

const port = Number(process.env.PORT ?? 8017);
const host = process.env.HOST ?? '127.0.0.1';
const app = createApp();
const server = app.listen(port, host, () => {
  console.log(`SAFI ${app.locals.mode === 'office' ? 'Office' : 'Factory'} is running at http://${host}:${port}`);
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Stop the other program or set PORT in .env.` : `The server could not start: ${e.message}`);
  process.exit(1);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
