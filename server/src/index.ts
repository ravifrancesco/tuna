import { buildApp } from './app';
import { config } from './config';
import { SETUP_CODE, has } from './connections';
import { log, setLogTimeZone } from './lib/log';
import { storageFix, storageWritable } from './lib/storage';
import { startNightWaves } from './services/nightWaves';

async function main() {
  setLogTimeZone(config.timeZone);
  const app = await buildApp();
  const services = Object.entries(has)
    .map(([name, check]) => `${name}: ${check() ? 'on' : 'off'}`)
    .join(', ');
  log.info('server', `Tuna ${config.version} — ${services}`);
  if (!has.navidrome()) {
    log.warn('server', 'No Navidrome address yet: open Tuna in a browser to set it up.');
    log.info('server', `Setup code: ${SETUP_CODE}`);
  }
  if (!storageWritable()) log.error('server', storageFix());
  if (!config.publicDir) log.info('server', 'No web build found; serving the API only (use the Vite dev server for the interface).');

  await app.listen({ port: config.port, host: config.host });
  startNightWaves();

  const shutdown = async (signal: string) => {
    log.info('server', `${signal} received, shutting down`);
    await app.close();
    process.exit(0);
  };
  // A forgotten promise somewhere shouldn't take the household's music down with it.
  process.on('unhandledRejection', (err) => log.error('server', 'Something failed in the background', err));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('server', "Tuna couldn't start", err);
  process.exit(1);
});
