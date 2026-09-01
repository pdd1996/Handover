import { AppController } from './app.controller';

// TK-01 空测试占位：保证 CI 测试管线跑通；接口级用例随 TK-04（F1-11-T1/T2/T3）进入
describe('AppController', () => {
  const controller = new AppController();

  it('root 返回服务标识', () => {
    expect(controller.root()).toEqual({ app: 'handover-api', status: 'ok' });
  });

  it('health 返回 ok', () => {
    expect(controller.health()).toEqual({ status: 'ok' });
  });
});
