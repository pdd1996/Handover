/**
 * TK-11 配置只读端点测试 —— 挂钩台账 DATA-07（AGENTS.md「需求即测试」：用例名以 -T 编号挂钩台账）。
 *
 * 覆盖台账用例：
 * - DATA-07-T1 接口层先行：新风候选来自后台配置（GET /configs 返回的 hvac_locs 候选与
 *   configs 表逐字一致，boiler_list 同口径）→ 多选保存 → 数组落库。**「数组落库」半边
 *   依赖提交端点 POST /records/today/submit（TK-12），复验挂 TK-12 supertest**，
 *   与 TK-10 的 DATA-05-T1「接口层契约级先行」同模式。
 * - 黄金值哨兵：种子候选清单逐字钉死（《开发种子数据》§四）——上条的断言基准取自库
 *   （端点 vs 库），但两侧若用同一解析语义会「一致地绿」（同源盲区，D-T17 轮教训）；
 *   黄金值把期望锚定到种子文档，解析语义漂移（如未来加 trim/去重）在此显式红。
 * - 附加口径（端点自身设计，非台账用例）：白名单收敛（运营键不出网）、鉴权
 *   （未登录 401、chief 覆盖可读）、脏配置降级（非法 JSON / 键缺失回落空数组不 500）。
 *
 * **需真实 MySQL 与种子数据**：本地先 `pnpm --filter @handover/api db:setup`；
 * CI 由 workflow 的 mysql service 提供。测试对库的改动在 afterAll 全部还原，
 * 不破坏《开发种子数据》的计数口径（records=10、configs=19）。
 *
 * **必须串行跑**（api 的 test 脚本为 `jest --runInBand` + `maxWorkers: 1`）：
 * 与其余 spec 共用同一真实 MySQL，纪律同 records.spec.ts 头部说明。
 */
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, gt, inArray } from 'drizzle-orm';
import request from 'supertest';
import type { FormOptionsDto } from '@handover/shared';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { DB, type Db } from '../db/db.module';
import { auditLogs, configs, sessions } from '../db/schema';

/** 种子统一开发密码（《开发种子数据》§一） */
const PASSWORD = 'Handover@2026';
/** 契约 §1 基础路径 + §3.7 配置只读路由 */
const API = '/api/v1/configs';

describe('DATA-07-T1 配置只读端点（TK-11）', () => {
  let app: INestApplication;
  let db: Db;
  let server: Server;
  let auditHighWater = 0;
  /** 师傅会话 Cookie（zhang，master 角色） */
  let masterCookie = '';
  /** 科长会话 Cookie（chief，验证契约 §1「chief：全部 + 配置」覆盖师傅端接口） */
  let chiefCookie = '';
  /** hvac_locs 种子整行（beforeAll 捕获）：降级用例改/删该行后由此无条件还原（评审 L1） */
  let origHvacRow: typeof configs.$inferSelect | undefined;

  async function login(username: string): Promise<string> {
    const res = await request(server)
      .post('/api/v1/auth/login')
      .send({ username, password: PASSWORD })
      .expect(200);
    return String(res.headers['set-cookie']?.[0] ?? '');
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app); // 与 main.ts 共用同一份配置，避免前缀/Cookie 解析漂移
    await app.init();
    db = app.get<Db>(DB);
    server = app.getHttpServer() as Server;

    // 种子不含会话数据，清空以保证登录断言干净（与 auth.spec.ts 同一纪律）
    await db.delete(sessions);
    const rows = await db.select({ id: auditLogs.id }).from(auditLogs);
    auditHighWater = rows.reduce((max, r) => Math.max(max, r.id), 0);

    // 捕获 hvac_locs 种子整行：下方两个降级用例会改写/删除它，用例自身的 try/finally
    // 只保证即时还原，若用例中途被 CI 杀掉则由 afterAll 无条件还原兜底（评审 L1：
    // 脏值 'not-json' 留库会污染后续 spec 与 E2E）
    origHvacRow = (
      await db.select().from(configs).where(eq(configs.configKey, 'hvac_locs')).limit(1)
    )[0];
    if (!origHvacRow) throw new Error('[configs.spec] 种子缺少 hvac_locs 行，请先 db:setup');

    masterCookie = await login('zhang');
    chiefCookie = await login('chief');
  });

  afterAll(async () => {
    // 无条件还原 hvac_locs 种子行（评审 L1 兜底：不依赖各用例的 try/finally 存活）
    await db.delete(configs).where(eq(configs.configKey, 'hvac_locs'));
    if (origHvacRow) await db.insert(configs).values(origHvacRow);
    // 还原登录审计行（按 id 上界只删本测试新增的）与会话存根
    await db.delete(auditLogs).where(gt(auditLogs.id, auditHighWater));
    await db.delete(sessions);
    // 关闭应用触发 DbModule.onApplicationShutdown 结束连接池，否则 Jest 进程不退出
    await app.close();
  });

  /** 取配置响应 */
  async function fetchConfigs(cookie = masterCookie): Promise<FormOptionsDto> {
    const res = await request(server).get(API).set('Cookie', cookie).expect(200);
    return res.body as FormOptionsDto;
  }

  /** 还原 hvac_locs 种子行（降级用例的即时还原路径；afterAll 另有无条件兜底） */
  async function restoreHvacRow(): Promise<void> {
    await db.delete(configs).where(eq(configs.configKey, 'hvac_locs'));
    if (origHvacRow) await db.insert(configs).values(origHvacRow);
  }

  describe('DATA-07-T1（接口层先行）：候选清单与 configs 表同步', () => {
    it('GET /configs 返回的 hvac_locs / boiler_list 与 configs 表逐字一致', async () => {
      const body = await fetchConfigs();

      // 断言基准取自库（非硬编码种子值）：后台改 configs → 下一班表单候选即时反映（F4-11 精神）；
      // 只取白名单两键（其余键值是标量文本，非 JSON 数组）
      const rows = await db
        .select({ key: configs.configKey, value: configs.configValue })
        .from(configs)
        .where(inArray(configs.configKey, ['hvac_locs', 'boiler_list']));
      const fromDb = Object.fromEntries(
        rows.map((r) => [r.key, JSON.parse(r.value) as readonly string[]]),
      );

      expect(body.hvac_locs).toEqual(fromDb.hvac_locs);
      expect(body.boiler_list).toEqual(fromDb.boiler_list);
      // DATA-07 规格词面：多选候选非空（种子占位值渲染，❓ 待总务科）
      expect(body.hvac_locs.length).toBeGreaterThan(0);
    });

    it('黄金值哨兵：候选清单与《开发种子数据》§四逐字钉死（防解析语义漂移的静默绿）', async () => {
      // 上一条用例「端点 vs 库」两侧若共用同一解析语义会一致地绿（同源盲区）；
      // 本条把期望锚定到种子文档，改解析实现（trim/去重/排序等）在此显式红，
      // 须人工对照《开发种子数据》§四后更新
      const body = await fetchConfigs();
      expect(body.hvac_locs).toEqual(['手术部', 'ICU', '门诊大厅']);
      expect(body.boiler_list).toEqual(['1号', '2号']);
    });
  });

  describe('白名单收敛（端点设计口径）：运营键不经表单候选端点出网', () => {
    it('返回体只含表单清单键，阈值/会话时长等运营键不出现', async () => {
      const body = await fetchConfigs();

      expect(Object.keys(body).sort()).toEqual(['boiler_list', 'hvac_locs']);
      // 抽查两个运营键（前者随 DATA-12 全局联动，后者随 D-T13 会话机制），确认未泄露
      expect(body).not.toHaveProperty('lo_threshold');
      expect(body).not.toHaveProperty('session_timeout_minutes');
    });
  });

  describe('鉴权与角色（契约 §1/§3.1 统一口径）', () => {
    it('未登录 → 401 UNAUTHENTICATED', async () => {
      const res = await request(server).get(API).expect(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
    });

    it('chief 可读（契约 §1「chief：全部 + 配置」覆盖师傅端只读接口）', async () => {
      const body = await fetchConfigs(chiefCookie);
      expect(body.hvac_locs.length).toBeGreaterThan(0);
    });
  });

  describe('脏配置降级：解析失败不阻塞填写（空清单 = 配置错误态，评审 M1/L2）', () => {
    it('config_value 非法 JSON → 该键候选回落空数组，其余键不受影响', async () => {
      await db
        .update(configs)
        .set({ configValue: 'not-json' })
        .where(eq(configs.configKey, 'hvac_locs'));

      try {
        const body = await fetchConfigs();
        expect(body.hvac_locs).toEqual([]);
        expect(body.boiler_list.length).toBeGreaterThan(0); // 其余键不受脏键牵连
      } finally {
        await restoreHvacRow();
      }
    });

    it('键缺失（未灌种子）→ 该键回落空数组，白名单键仍在响应中（评审 L2）', async () => {
      await db.delete(configs).where(eq(configs.configKey, 'hvac_locs'));

      try {
        const body = await fetchConfigs();
        expect(body.hvac_locs).toEqual([]);
        expect(Object.keys(body).sort()).toEqual(['boiler_list', 'hvac_locs']); // 键恒在，值为空
        expect(body.boiler_list.length).toBeGreaterThan(0);
      } finally {
        await restoreHvacRow();
      }
    });
  });
});
