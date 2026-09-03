import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { createDb } from './connection';

/** Drizzle 实例的注入令牌 */
export const DB = Symbol('DB');
/** 连接池令牌（仅供本模块关闭时用，不对外导出） */
const POOL = Symbol('POOL');
/** createDb() 的一次性产物（避免 DB 与 POOL 各建一个池） */
const BUNDLE = Symbol('DB_BUNDLE');

type Bundle = ReturnType<typeof createDb>;

/**
 * Drizzle 实例类型（带 schema 泛型）——各服务注入时用此类型标注，
 * 不能写裸 `MySql2Database`（其默认泛型为 `Record<string, never>`，与带 schema 的实例不兼容）。
 */
export type Db = Bundle['db'];

/**
 * 数据库模块（全局单例）：一个连接池 + 一个 Drizzle 实例，供各业务模块注入。
 *
 * 必须在应用关闭时结束连接池——否则 `nest start` 无法优雅停机、Jest 跑完进程不退出
 * （接口测试 F1-11-T1/T2/T3 依赖这一点）。
 */
@Global()
@Module({
  providers: [
    { provide: BUNDLE, useFactory: (): Bundle => createDb() },
    { provide: POOL, inject: [BUNDLE], useFactory: (b: Bundle): Pool => b.pool },
    { provide: DB, inject: [BUNDLE], useFactory: (b: Bundle): Db => b.db },
  ],
  exports: [DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
