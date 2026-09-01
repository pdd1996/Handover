import 'dotenv/config';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './schema';

/** 数据库连接配置（.env；.env.example 为模板，.env 不入库） */
export const dbConfig = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME ?? 'handover',
};

/** 建一个带库名的连接池并返回 Drizzle 实例（供业务与 seed 使用） */
export function createDb() {
  const pool = mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    connectionLimit: 5,
    timezone: 'Z',
  });
  return { db: drizzle(pool, { schema, mode: 'default' }), pool };
}

/** 建一个不带库名的裸连接（用于 migrate 前的 CREATE DATABASE） */
export function createBareConnection() {
  return mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    multipleStatements: false,
  });
}
