import { migrate } from 'drizzle-orm/mysql2/migrator';
import { createBareConnection, createDb, dbConfig } from './connection';

/**
 * db:migrate —— 一键建库 + 执行全部迁移（TK-02 交付判据：全新实例从零建库）。
 * 库名取 .env DB_NAME，默认 handover；字符集与 §4.2 一致（utf8mb4）。
 */
async function main(): Promise<void> {
  const bare = await createBareConnection();
  await bare.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` DEFAULT CHARACTER SET utf8mb4`,
  );
  await bare.end();
  console.log(`[db:migrate] database "${dbConfig.database}" ready`);

  const { db, pool } = createDb();
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('[db:migrate] migrations applied');
  await pool.end();
}

main().catch((err) => {
  console.error('[db:migrate] failed:', err);
  process.exit(1);
});
