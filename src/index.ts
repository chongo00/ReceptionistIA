import 'dotenv/config';
import { startServer } from './server.js';

startServer().catch((err) => {
  console.error('Failed to start receptionist server:', err);
  process.exit(1);
});
