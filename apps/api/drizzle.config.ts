import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit 配置（TK-02）。schema 为唯一出处，migrations 输出到 drizzle/。
 * 凭据从 .env 读取，仅 db:generate / db:push 需要（迁移执行走 src/db/migrate.ts）。
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'mysql',
  dbCredentials: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'handover',
  },
  verbose: true,
  strict: true,
});
