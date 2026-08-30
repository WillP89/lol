import { buildApp } from './app';
import { config } from './lib/config';

const app = buildApp();

app
  .listen({ port: config.PORT, host: '0.0.0.0' })
  .then((address) => {
    app.log.info(`Plot API listening on ${address}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    process.exit(0);
  });
}
