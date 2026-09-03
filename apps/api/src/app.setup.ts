import { RequestMethod, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';

/**
 * 应用级配置：`main.ts` 与接口测试（auth.spec.ts）**共用此函数**，避免两处配置漂移
 * ——测试里少设一项（如全局前缀）会让用例请求到错误路径，从而误判通过或失败。
 *
 * 内容：
 * - Cookie 解析：会话凭证的浏览器通道（D-T13 双通道之一）
 * - 代理采信：`TRUST_PROXY=true` 时按 1 跳信任前置反代（生产 Nginx 同源反代，技术方案 §3），
 *   Express 的 req.ip 才会解析 X-Forwarded-For 为真实客户端地址；直连/开发不开启，
 *   避免无条件信任可伪造的请求头污染审计 IP（C-05）
 * - 契约 §1 基础路径 `/api/v1`；健康检查排除在外（供容器探活与 CI 冒烟）。
 *   h5/admin 的 vite proxy 不做 rewrite，故前缀由后端承担，前端直接请求 `/api/v1/*`
 */
export function configureApp(app: INestApplication): void {
  if (process.env.TRUST_PROXY === 'true') {
    // set 即底层 express 实例的 set；此处仅信任 1 跳（Node 的对端是 Nginx，其追加的末位地址才是真实客户端）
    (app as NestExpressApplication).set('trust proxy', 1);
  }
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: '/', method: RequestMethod.GET },
      { path: '/health', method: RequestMethod.GET },
    ],
  });
}
