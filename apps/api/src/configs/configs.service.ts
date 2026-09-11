import { Inject, Injectable, Logger } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import {
  FORM_OPTION_CONFIG_KEYS,
  type FormOptionConfigKey,
  type FormOptionsDto,
} from '@handover/shared';
import { DB, type Db } from '../db/db.module';
import { configs } from '../db/schema';

/**
 * 配置只读服务（TK-11）：读 configs 表并把 config_value 的 JSON 数组解析为候选清单。
 *
 * 键集白名单 `FORM_OPTION_CONFIG_KEYS` 为 **shared 三端同源常量**（评审 M5 上移）：
 * 只暴露师傅端表单候选渲染所需的清单类键——configs 表另有阈值（lo_threshold）、
 * 会话时长（session_timeout_minutes）等运营键，读取口径归科长后台 GET /admin/configs
 * （契约 §3.6），不在此端点出网。新增表单清单键只改 shared 常量并回写契约 §3.7。
 *
 * 解析降级口径：值非法（非 JSON / 非字符串数组，含科长后台误存）→ 该键回落**空数组**
 * 并记警告日志，不抛 500——候选是表单渲染数据源，配置脏不应阻塞师傅填写；
 * h5 侧另有种子占位回落（SectionView，❓ 候选待总务科），两层降级互不依赖。
 *
 * **空清单（值为空数组或键缺失未灌种子）属配置错误态，不是合法表单语义**（评审 M1）：
 * 必填推定口径不变——hvac_locs 恒必填、提交仍被点名拦截（cards.ts 规则 0「消费端不得
 * 自行放宽」），h5 渲染层显式提示「候选清单为空，请联系科长在后台配置」引导科长修复，
 * 期间该卡无法提交是预期行为；是否允许空清单提交并入台账待确认清单第 9 项复核范围。
 */
@Injectable()
export class ConfigsService {
  private readonly logger = new Logger(ConfigsService.name);

  constructor(@Inject(DB) private readonly db: Db) {}

  /** GET /configs 的完整响应（表单选项白名单；白名单键恒在响应中，未灌种子为空数组） */
  async formOptions(): Promise<FormOptionsDto> {
    const rows = await this.db
      .select({ key: configs.configKey, value: configs.configValue })
      .from(configs)
      .where(inArray(configs.configKey, [...FORM_OPTION_CONFIG_KEYS]));

    // 中间构造去 readonly（响应类型对消费方只读；组装方在此赋值）
    const options: { -readonly [K in FormOptionConfigKey]: readonly string[] } = {
      hvac_locs: [],
      boiler_list: [],
    };
    for (const key of FORM_OPTION_CONFIG_KEYS) {
      const row = rows.find((r) => r.key === key);
      options[key] = row ? this.parseOptionList(key, row.value) : [];
    }
    return options;
  }

  /** config_value（JSON 字符串数组文本）→ 候选数组；非法回落 [] 并警告（见类头降级口径） */
  private parseOptionList(key: FormOptionConfigKey, raw: string): readonly string[] {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        Array.isArray(parsed) &&
        parsed.every((item) => typeof item === 'string' && item.trim() !== '')
      ) {
        return parsed;
      }
    } catch {
      // 非 JSON 文本，走下方统一警告
    }
    this.logger.warn(`configs.${key} 不是字符串数组（值见库），候选降级为空数组`);
    return [];
  }
}
