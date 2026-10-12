import { app } from './app.js';
import { config } from 'dotenv';
config({ path: new URL('../.env', import.meta.url), quiet: true });
const port = Number(process.env.PORT || 3001);
app.listen(port, '127.0.0.1', (error?: Error) => {
  if (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(code === 'EADDRINUSE'
      ? `API port ${port} is already in use. Stop the previous dev server before running npm run dev again.`
      : `API failed to start: ${code || 'listen_failed'}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Statement API: http://localhost:${port}`);
});
