/**
 * TK-23 管理后台框架与权限测试 —— 挂钩任务分解 TK-23 完成判据「权限用例：master 调 admin
 * 路由全部 403」与台账 C-05（实名制/角色）、F6-06（应提交未提交后台视图半边）。
 *
 * C-05 的台账验收方式为「手工走查 + 审计抽查」、无独立 -T 接口用例（与 DATA-07 白名单
 * 端点的「附加口径」同模式）：本文件即 TK-23 判据的自动化载体——
 * 1. **路由完备性哨兵**：枚举 Nest 实际注册的全部 /admin 路由，与「契约 §3.6 当前已落地
 *    清单」逐字对账——后续 TK-24~29 新挂后台路由而未扩入权限矩阵时在此显式红，
 *    「一律 403」的结构性承诺随路由表增长自动执法；
 * 2. **权限矩阵**：对每一条 /admin 路由断言 master → 403 FORBIDDEN（C-05 师傅无后台）、
 *    未登录 → 401 UNAUTHENTICATED（先鉴权后鉴角色，守卫串联顺序）、chief → 非鉴权类
 *    失败（矩阵只验守卫，业务判据归各规格 -T 用例）；断言串入路由 URL，矩阵失败可定位；
 * 3. **GET /admin/missing-submits（F6-06 后台半边）**：漏交判定与 missing_submit 通知
 *    同源（NotificationsService.missingSubmitShifts 单一实现）——时间注入 now = 当前班次
 *    + 8 天正午，黄金值 = 种子排班 D+1~D+7（无记录）按 duty_date 倒序；records 行存在
 *    即不算漏交（台账增补 #27 在视图上同样成立）；补交窗口外班次不展示（D-T21 L3）。
 *
 * **需真实 MySQL 与种子数据**：本地先 `pnpm --filter @handover/api db:setup`；
 * --runInBand 串行（与其余 spec 共用同一库）。不触碰任何种子行（D+3 直插 draft 记录行
 * try/finally 即时删除），afterAll 还原会话与登录审计。
 */
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { eq, gt } from 'drizzle-orm';
import request from 'supertest';
import type { MissingSubmitListDto } from '@handover/shared';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { DB, type Db } from '../db/db.module';
import { auditLogs, records, schedules, sessions, users } from '../db/schema';
import { RecordsService } from '../records/records.service';
import { AdminService } from './admin.service';

const PASSWORD = 'Handover@2026';
const MISSING_SUBMITS_API = '/api/v1/admin/missing-submits';

/** supertest 动词表（键 = RequestMethod 枚举值，0=GET 1=POST 2=PUT 3=DELETE 4=PATCH） */
const HTTP_VERBS: Record<number, 'get' | 'post' | 'put' | 'delete' | 'patch'> = {
  0: 'get',
  1: 'post',
  2: 'put',
  3: 'delete',
  4: 'patch',
};

interface AdminRoute {
  /** 含全局前缀的完整路径（如 /api/v1/admin/missing-submits） */
  url: string;
  verb: 'get' | 'post' | 'put' | 'delete' | 'patch';
}

/** Nest 模块注册表的最小结构面（TestingModule 的 container 成员满足）：模块 → 控制器注册表 */
interface NestContainer {
  container: {
    getModules: () => Map<
      unknown,
      { controllers: Map<unknown, { metatype?: abstract new (...args: never[]) => unknown }> }
    >;
  };
}

/**
 * 从 Nest 容器枚举实际注册的 /admin 路由（PATH/METHOD 为公开元数据常量；模块注册表经
 * container.getModules() 公开访问——逐模块取 controllers）。
 * 只认以 /admin 开头的控制器路径——师傅端 /records、/configs 等路由不属本矩阵。
 */
function discoverAdminRoutes(ref: NestContainer): AdminRoute[] {
  const routes: AdminRoute[] = [];
  for (const module of ref.container.getModules().values()) {
    for (const wrapper of module.controllers.values()) {
      const ctor = wrapper.metatype;
      if (!ctor?.prototype) continue;
      const classPath = (Reflect.getMetadata(PATH_METADATA, ctor) as string | undefined) ?? '';
      for (const name of Object.getOwnPropertyNames(ctor.prototype)) {
        if (name === 'constructor') continue;
        const handler = (ctor.prototype as Record<string, object>)[name]!;
        const methodPath = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        if (methodPath === undefined) continue; // 非路由方法（生命周期钩子等）
        const joined = `/${classPath}/${methodPath}`.replace(/\/{2,}/g, '/');
        if (!joined.startsWith('/admin')) continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as number;
        const verb = HTTP_VERBS[method];
        if (!verb) throw new Error(`未知 HTTP 方法元数据：${method}`);
        routes.push({ url: `/api/v1${joined}`, verb });
      }
    }
  }
  return routes.sort((a, b) => a.url.localeCompare(b.url));
}

/** 日历日加 N 天（UTC 算法，与 duty-date.ts plusOneDay 同式，勿改口径） */
function plusDays(dutyDate: string, days: number): string {
  const d = new Date(`${dutyDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 注入时刻：上海墙钟 dateStr 当日 12:00（Asia/Shanghai = UTC+8 恒定，04:00Z 即正午） */
function shanghaiNoon(dateStr: string): Date {
  return new Date(`${dateStr}T04:00:00Z`);
}

describe('TK-23 管理后台框架与权限（接口）', () => {
  let app: INestApplication;
  /** TestingModule 的 container 为 protected：测试内单点转型取控制器注册表（只读枚举） */
  let containerRef: NestContainer;
  let db: Db;
  let server: Server;
  let admin: AdminService;
  let auditHighWater = 0;
  let masterCookie = '';
  let chiefCookie = '';
  let dutyDate = '';

  async function login(username: string): Promise<string> {
    const res = await request(server)
      .post('/api/v1/auth/login')
      .send({ username, password: PASSWORD })
      .expect(200);
    return String(res.headers['set-cookie']?.[0] ?? '');
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    containerRef = moduleRef as unknown as NestContainer;
    app = moduleRef.createNestApplication();
    configureApp(app); // 与 main.ts 共用同一份配置（全局前缀 /api/v1、Cookie 解析）
    await app.init();
    db = app.get<Db>(DB);
    server = app.getHttpServer() as Server;
    admin = app.get(AdminService);

    await db.delete(sessions);
    const auditRows = await db.select({ id: auditLogs.id }).from(auditLogs);
    auditHighWater = auditRows.reduce((max, r) => Math.max(max, r.id), 0);

    dutyDate = (await app.get(RecordsService).resolveDutyDate()).dutyDate;

    // 种子哨兵（同 notifications.spec 口径）：D+1~D+7 有排班、无记录——黄金值的前提，跨灌种日缺位即显式红
    const schedRows = await db.select({ dutyDate: schedules.dutyDate }).from(schedules);
    const schedSet = new Set(schedRows.map((r) => r.dutyDate));
    const recRows = await db.select({ dutyDate: records.dutyDate }).from(records);
    const recSet = new Set(recRows.map((r) => r.dutyDate));
    for (let i = 1; i <= 7; i++) {
      const d = plusDays(dutyDate, i);
      if (!schedSet.has(d)) throw new Error(`种子排班缺 ${d}（D+1~D+7）——请先 db:setup 重灌种子`);
      if (recSet.has(d)) throw new Error(`非预期：${d} 已有记录行——黄金值前提被破坏，请重灌种子`);
    }

    masterCookie = await login('zhang');
    chiefCookie = await login('chief');
  });

  afterAll(async () => {
    // 还原登录审计行（按 id 上界只删本测试新增的，同 configs.spec 纪律）与会话存根
    await db.delete(auditLogs).where(gt(auditLogs.id, auditHighWater));
    await db.delete(sessions);
    await app.close();
  });

  // ── 路由完备性哨兵 + 权限矩阵（TK-23 判据本体）─────────────────────

  describe('chief 角色守卫（C-05、契约 §3.6）：师傅访问后台接口一律 403', () => {
    it('路由完备性哨兵：Nest 实际注册的 /admin 路由 == 契约 §3.6 当前已落地清单', () => {
      const routes = discoverAdminRoutes(containerRef);
      // TK-24~29 落地用户/排班/电梯/点位/配置/审计等后台路由后，此处须同步扩入
      //（哨兵红 = 有新后台路由未进权限矩阵，「一律 403」承诺须重新断言）
      expect(routes.map((r) => `${r.verb.toUpperCase()} ${r.url}`)).toEqual([
        `GET ${MISSING_SUBMITS_API}`,
        'POST /api/v1/admin/records/:id/annotation',
        'GET /api/v1/admin/records/export',
      ]);
    });

    it('权限矩阵：master 调全部 admin 路由 → 403 FORBIDDEN（TK-23 判据）', async () => {
      for (const route of discoverAdminRoutes(containerRef)) {
        const res = await request(server)[route.verb](route.url).set('Cookie', masterCookie);
        expect(`${route.url} → ${res.status} ${(res.body as { code?: string }).code ?? ''}`).toBe(
          `${route.url} → 403 FORBIDDEN`,
        );
      }
    });

    it('权限矩阵：未登录调全部 admin 路由 → 401 UNAUTHENTICATED（先鉴权后鉴角色）', async () => {
      for (const route of discoverAdminRoutes(containerRef)) {
        const res = await request(server)[route.verb](route.url);
        expect(`${route.url} → ${res.status} ${(res.body as { code?: string }).code ?? ''}`).toBe(
          `${route.url} → 401 UNAUTHENTICATED`,
        );
      }
    });

    it('chief 调全部 admin 路由 → 非鉴权类失败（矩阵只验守卫；业务判据归各规格 -T 用例）', async () => {
      for (const route of discoverAdminRoutes(containerRef)) {
        const res = await request(server)[route.verb](route.url).set('Cookie', chiefCookie);
        expect([401, 403]).not.toContain(res.status);
      }
    });
  });

  // ── GET /admin/missing-submits：F6-06 后台视图半边 ─────────────────

  describe('GET /admin/missing-submits 应提交未提交视图（F6-06；数据源与通知同源）', () => {
    /** 视图黄金构造：注入 now = D+8 正午 → 窗口下界 D+1，缺失集合 = D+1~D+7（种子排班、无记录） */
    const futureNoon = (): Date => shanghaiNoon(plusDays(dutyDate, 8));

    it('黄金值：D+1~D+7 全列、duty_date 倒序、排班人姓名与 users 表同源', async () => {
      const body = await admin.missingSubmits(futureNoon());

      const expectedDates = Array.from({ length: 7 }, (_, i) => plusDays(dutyDate, 7 - i));
      expect(body.items.map((i) => i.duty_date)).toEqual(expectedDates);

      // 排班人姓名从库反查（不硬编码种子值；user_id 与 real_name 一致即与通知 message 同源）
      const nameOf = new Map(
        (await db.select({ id: users.id, realName: users.realName }).from(users)).map((r) => [
          r.id,
          r.realName,
        ]),
      );
      for (const item of body.items) {
        expect(item.real_name).toBe(nameOf.get(item.user_id));
        expect(item.user_id).toBeGreaterThan(0);
      }
    });

    it('records 行存在即不算漏交（台账增补 #27 口径在视图上同样成立）：直插 D+3 draft 行 → 视图剔除', async () => {
      const d3 = plusDays(dutyDate, 3);
      const before = await admin.missingSubmits(futureNoon());
      expect(before.items.some((i) => i.duty_date === d3)).toBe(true);

      // 任意状态行存在即不算漏交（#27：draft 撤回未重提也不算）——直插最小行，try/finally 即时删除
      const zhangId = (
        await db.select({ id: users.id }).from(users).where(eq(users.username, 'zhang')).limit(1)
      )[0]!.id;
      await db.insert(records).values({
        recordNo: 'HB-TK23VIEW-01',
        dutyDate: d3,
        submitterId: zhangId,
        status: 'draft',
        version: 1,
      });
      try {
        const after = await admin.missingSubmits(futureNoon());
        expect(after.items.some((i) => i.duty_date === d3)).toBe(false);
        expect(after.items).toHaveLength(before.items.length - 1);
      } finally {
        await db.delete(records).where(eq(records.recordNo, 'HB-TK23VIEW-01'));
      }
    });

    it('补交窗口外班次不展示（D-T21 L3）：种子远期排班 D-14~D-11（无记录、早已过截止）恒不入视图', async () => {
      const body = await admin.missingSubmits(futureNoon());

      // now = D+8 → 窗口下界 = D+1：D-14~D-11 有排班无记录且截止早已过，但因窗口界外不列出
      const outsideWindow = [-14, -13, -12, -11].map((n) => plusDays(dutyDate, n));
      for (const d of outsideWindow) {
        expect(body.items.some((i) => i.duty_date === d) ? `${d} 不应出现在视图` : 'ok').toBe('ok');
      }
      // 且窗口内每个条目都确有排班（数据来自排班表 join，而非 records 反推）
      expect(body.items.every((i) => i.duty_date >= plusDays(dutyDate, 1))).toBe(true);
    });

    it('路由层冒烟：GET 实时返回 200、body 形状与 service 同刻结果逐字一致（路由仅薄委托）', async () => {
      const res = await request(server)
        .get(MISSING_SUBMITS_API)
        .set('Cookie', chiefCookie)
        .expect(200);
      const svc = await admin.missingSubmits();

      const body = res.body as MissingSubmitListDto;
      expect(body).toEqual(svc);
      expect(Array.isArray(body.items)).toBe(true);
      for (const item of body.items) {
        expect(Object.keys(item).sort()).toEqual(['duty_date', 'real_name', 'user_id']);
      }
    });
  });
});
