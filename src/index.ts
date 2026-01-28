import { startServer } from './server.js';

startServer().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Error al iniciar el servidor IA recepcionista:', err);
  process.exit(1);
});

