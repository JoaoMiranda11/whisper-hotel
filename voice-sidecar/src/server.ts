import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig(process.env);
const app = await buildApp(config);

const shutdown = async (signal: string): Promise<void> =>
{
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

try
{
    await app.listen({ port: config.port, host: config.host });
}
catch(error)
{
    app.log.fatal(error, 'failed to start');
    process.exit(1);
}
