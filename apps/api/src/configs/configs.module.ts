import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConfigsController } from './configs.controller';
import { ConfigsService } from './configs.service';

/**
 * 配置只读模块（TK-11）：契约 §3.7 GET /configs（表单选项白名单，DATA-07）。
 * 技术方案 §3 模块划分中的「配置中心」全量维护路由（GET/PUT /admin/configs）随
 * TK-27 落地，届时可并入本模块；当前先挂只读半边服务师傅端表单渲染。
 */
@Module({
  imports: [AuthModule], // 复用其导出的 SessionGuard/RolesGuard（同 RecordsModule 口径）
  controllers: [ConfigsController],
  providers: [ConfigsService],
})
export class ConfigsModule {}
