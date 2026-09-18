import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

loadEnv();
loadEnv({ path: resolve(__dirname, '../../.env') });
loadEnv({ path: resolve(__dirname, '../../../.env') });
loadEnv({ path: resolve(process.cwd(), '../../.env') });
