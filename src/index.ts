import express from 'express';
import routes from './api/routes';
import { migrate } from './db/migrate';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());
app.use('/api', routes);

async function start() {
  // Run migrations on startup
  try {
    console.log('Running migrations...');
    await migrate();
  } catch (err) {
    console.error('Migration error (continuing):', err);
  }

  app.listen(PORT, () => {
    console.log(`Task orchestration engine listening on :${PORT}`);
  });
}

start();

export default app;
