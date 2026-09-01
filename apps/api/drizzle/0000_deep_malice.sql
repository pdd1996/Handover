CREATE TABLE `alerts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`record_id` int NOT NULL,
	`rule_key` varchar(64) NOT NULL,
	`target` varchar(64),
	`level` enum('high','mid','low') NOT NULL,
	`message` varchar(300) NOT NULL,
	`acknowledged_by` int,
	`acknowledged_at` datetime,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `alerts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`record_id` int NOT NULL,
	`field_name` varchar(64) NOT NULL,
	`file_path` varchar(200) NOT NULL,
	`size_kb` int,
	`taken_at` datetime,
	`uploaded_by` int NOT NULL,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `attachments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`actor_id` int,
	`action` varchar(64) NOT NULL,
	`target_type` varchar(32),
	`target_id` varchar(32),
	`old_value` json,
	`new_value` json,
	`reason` varchar(200),
	`ip` varchar(64),
	`device` varchar(200),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `configs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`config_key` varchar(64) NOT NULL,
	`config_value` text NOT NULL,
	`remark` varchar(200),
	`updated_by` int NOT NULL,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `configs_id` PRIMARY KEY(`id`),
	CONSTRAINT `configs_config_key_unique` UNIQUE(`config_key`)
);
--> statement-breakpoint
CREATE TABLE `elevator_checks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`record_id` int NOT NULL,
	`elevator_id` int NOT NULL,
	`check_time` datetime NOT NULL,
	`expected` enum('run','stop') NOT NULL,
	`actual` enum('match','run','stop','fault'),
	`explanation` varchar(300),
	CONSTRAINT `elevator_checks_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_rec_lift` UNIQUE(`record_id`,`elevator_id`)
);
--> statement-breakpoint
CREATE TABLE `elevators` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(40) NOT NULL,
	`plan_type` enum('always','scheduled','stopped') NOT NULL DEFAULT 'always',
	`windows` json,
	`stop_reason` varchar(200),
	`status` enum('active','retired') NOT NULL DEFAULT 'active',
	`updated_by` int,
	`updated_at` datetime,
	CONSTRAINT `elevators_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`kind` varchar(32) NOT NULL,
	`title` varchar(100) NOT NULL,
	`message` varchar(300),
	`record_id` int,
	`alert_id` int,
	`read_at` datetime,
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `record_versions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`record_id` int NOT NULL,
	`version` int NOT NULL,
	`snapshot` json NOT NULL,
	`changed` json,
	`editor_id` int NOT NULL,
	`reason` varchar(200),
	`edited_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `record_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `uk_rec_ver` UNIQUE(`record_id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `records` (
	`id` int AUTO_INCREMENT NOT NULL,
	`record_no` varchar(20) NOT NULL,
	`duty_date` date NOT NULL,
	`submitter_id` int NOT NULL,
	`receiver_id` int,
	`receiver_change_reason` varchar(200),
	`status` enum('draft','submitted','objection','completed') NOT NULL DEFAULT 'draft',
	`submitted_at` datetime,
	`confirmed_at` datetime,
	`objection_note` varchar(500),
	`objection_at` datetime,
	`escalated_at` datetime,
	`version` int NOT NULL DEFAULT 1,
	`water_reading` decimal(12,1),
	`water_use` decimal(12,1),
	`e1_reading` decimal(12,1),
	`e2_reading` decimal(12,1),
	`e_use` decimal(12,1),
	`hp_status` enum('ok','bad'),
	`hp_note` varchar(200),
	`g1_remaining` decimal(12,1),
	`g2_remaining` decimal(12,1),
	`gas_use` decimal(12,1),
	`tank_in_use` tinyint,
	`t1_c830` decimal(8,2),
	`t1_p830` decimal(5,2),
	`t1_c2030` decimal(8,2),
	`t1_p2030` decimal(5,2),
	`t2_c830` decimal(8,2),
	`t2_p830` decimal(5,2),
	`t2_c2030` decimal(8,2),
	`t2_p2030` decimal(5,2),
	`lo_measured_am` datetime,
	`lo_measured_pm` datetime,
	`lo_day_use` decimal(8,2),
	`lo_station_press` decimal(5,2),
	`hbo_press` decimal(5,2),
	`b40` int,
	`b10` int,
	`b6` int,
	`b_co2` int,
	`b_pulm` int,
	`manifold_press` decimal(5,2),
	`co2_out_press` decimal(5,2),
	`neg_status` enum('ok','bad'),
	`neg_note` varchar(200),
	`air_status` enum('ok','bad'),
	`air_note` varchar(200),
	`boiler_status` enum('ok','bad'),
	`boiler_note` varchar(200),
	`boiler_run` enum('run','stop'),
	`boiler_no` varchar(16),
	`supply_temp` decimal(5,1),
	`return_temp` decimal(5,1),
	`coolroom_status` enum('ok','bad'),
	`coolroom_note` varchar(200),
	`cool_run` enum('run','stop'),
	`h1_set_temp` decimal(5,1),
	`h1_out_temp` decimal(5,1),
	`h3_set_temp` decimal(5,1),
	`h3_out_temp` decimal(5,1),
	`p1_press` decimal(5,2),
	`p3_press` decimal(5,2),
	`p1_level` enum('ok','high','low'),
	`p1_height` decimal(6,2),
	`p3_level` enum('ok','high','low'),
	`p3_height` decimal(6,2),
	`hvac_status` enum('ok','bad'),
	`hvac_note` varchar(200),
	`hvac_locs` json,
	`energy_note` varchar(500),
	`handover_note` varchar(1000),
	`signature_path` varchar(200),
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `records_id` PRIMARY KEY(`id`),
	CONSTRAINT `records_record_no_unique` UNIQUE(`record_no`),
	CONSTRAINT `records_duty_date_unique` UNIQUE(`duty_date`)
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`duty_date` date NOT NULL,
	`user_id` int NOT NULL,
	`updated_by` int,
	`updated_at` datetime,
	CONSTRAINT `schedules_id` PRIMARY KEY(`id`),
	CONSTRAINT `schedules_duty_date_unique` UNIQUE(`duty_date`)
);
--> statement-breakpoint
CREATE TABLE `spots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(40) NOT NULL,
	`sort_no` int NOT NULL DEFAULT 0,
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`updated_by` int,
	`updated_at` datetime,
	CONSTRAINT `spots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`username` varchar(32) NOT NULL,
	`real_name` varchar(32) NOT NULL,
	`role` enum('master','chief') NOT NULL DEFAULT 'master',
	`password_hash` varchar(128) NOT NULL,
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_username_unique` UNIQUE(`username`)
);
--> statement-breakpoint
ALTER TABLE `alerts` ADD CONSTRAINT `alerts_record_id_records_id_fk` FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `attachments` ADD CONSTRAINT `attachments_record_id_records_id_fk` FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `elevator_checks` ADD CONSTRAINT `elevator_checks_record_id_records_id_fk` FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `elevator_checks` ADD CONSTRAINT `elevator_checks_elevator_id_elevators_id_fk` FOREIGN KEY (`elevator_id`) REFERENCES `elevators`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_record_id_records_id_fk` FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_alert_id_alerts_id_fk` FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `record_versions` ADD CONSTRAINT `record_versions_record_id_records_id_fk` FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `records` ADD CONSTRAINT `records_submitter_id_users_id_fk` FOREIGN KEY (`submitter_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `records` ADD CONSTRAINT `records_receiver_id_users_id_fk` FOREIGN KEY (`receiver_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `schedules` ADD CONSTRAINT `schedules_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_rec` ON `alerts` (`record_id`);--> statement-breakpoint
CREATE INDEX `idx_time` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_target` ON `audit_logs` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_user` ON `notifications` (`user_id`,`read_at`);--> statement-breakpoint
CREATE INDEX `idx_status` ON `records` (`status`);--> statement-breakpoint
-- ── 对齐《技术方案》§4.2（drizzle-kit 不生成的部分，手工补齐，改本文件需同步 schema 语义）──
ALTER TABLE `users` ENGINE = InnoDB, DEFAULT CHARSET = utf8mb4, COMMENT = '人员账号';--> statement-breakpoint
ALTER TABLE `users` MODIFY `username` varchar(32) NOT NULL COMMENT '系统发号', MODIFY `real_name` varchar(32) NOT NULL COMMENT '实名';--> statement-breakpoint
ALTER TABLE `users` MODIFY `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间';--> statement-breakpoint
ALTER TABLE `schedules` ENGINE = InnoDB, DEFAULT CHARSET = utf8mb4, COMMENT = '排班表';--> statement-breakpoint
ALTER TABLE `schedules` MODIFY `duty_date` date NOT NULL COMMENT '值班日期';--> statement-breakpoint
ALTER TABLE `records` ENGINE = InnoDB, DEFAULT CHARSET = utf8mb4, COMMENT = '交接记录主表';--> statement-breakpoint
ALTER TABLE `records`
  MODIFY `record_no` varchar(20) NOT NULL COMMENT '如 HB-20260827-001',
  MODIFY `duty_date` date NOT NULL COMMENT '班次起始日（非提交日）',
  MODIFY `submitter_id` int NOT NULL COMMENT '交班人',
  MODIFY `receiver_id` int COMMENT '接班人（排班带出，可改需留痕）',
  MODIFY `submitted_at` datetime COMMENT '以同步成功时刻为准；重新提交则更新',
  MODIFY `objection_at` datetime COMMENT '异议发起时刻（24 小时升级计时起点）',
  MODIFY `escalated_at` datetime COMMENT '升级提醒科长时刻（防重复提醒）',
  MODIFY `tank_in_use` tinyint COMMENT '1/2 号',
  MODIFY `lo_measured_am` datetime COMMENT '早时点实际测量时刻（名义 8:30，填写时自动记录）',
  MODIFY `lo_measured_pm` datetime COMMENT '晚时点实际测量时刻（名义 20:30，填写时自动记录）',
  MODIFY `lo_day_use` decimal(8,2) COMMENT '日间用量=在用罐8:30-20:30',
  MODIFY `p1_height` decimal(6,2) COMMENT '水位高度 m',
  MODIFY `p3_height` decimal(6,2) COMMENT '水位高度 m',
  MODIFY `hvac_locs` json COMMENT '使用位置数组',
  MODIFY `signature_path` varchar(200) COMMENT '接班人签名图',
  MODIFY `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;--> statement-breakpoint
ALTER TABLE `record_versions` ENGINE = InnoDB, DEFAULT CHARSET = utf8mb4, COMMENT = '记录历史版本';--> statement-breakpoint
ALTER TABLE `record_versions` MODIFY `snapshot` json NOT NULL COMMENT '该版本全字段快照', MODIFY `changed` json COMMENT '相对上版变更的字段与旧值';--> statement-breakpoint
ALTER TABLE `elevators` ENGINE = InnoDB, DEFAULT CHARSET = utf8mb4, COMMENT = '电梯字典';--> statement-breakpoint
ALTER TABLE `elevators` MODIFY `name` varchar(40) NOT NULL COMMENT '1号/扶梯/人防/发热门诊…', MODIFY `windows` json COMMENT '如 [["06:00","22:00"]]', MODIFY `stop_reason` varchar(200) COMMENT '长期停运原因';--> statement-breakpoint
ALTER TABLE `elevator_checks` ENGINE = InnoDB, DEFAULT CHARSET = utf8mb4, COMMENT = '电梯核对明细（打开电梯板块时按台生成明细行）';--> statement-breakpoint
ALTER TABLE `elevator_checks` MODIFY `check_time` datetime NOT NULL COMMENT '核对时刻（预期状态基准）', MODIFY `actual` enum('match','run','stop','fault') COMMENT 'NULL=未核对；match=核对一致；run/stop=与预期相反；fault=故障', MODIFY `explanation` varchar(300) COMMENT '不符必填说明';--> statement-breakpoint
ALTER TABLE `spots` ENGINE = InnoDB, DEFAULT CHARSET = utf8mb4, COMMENT = '巡检点位字典';--> statement-breakpoint
ALTER TABLE `spots` MODIFY `name` varchar(40) NOT NULL COMMENT '表房/液氧站/泵房/锅炉房/制冷机房…';--> statement-breakpoint
ALTER TABLE `configs` ENGINE = InnoDB, DEFAULT CHARSET = utf8mb4, COMMENT = '配置中心';--> statement-breakpoint
ALTER TABLE `configs` MODIFY `config_key` varchar(64) NOT NULL COMMENT '如 lo_threshold / cyl_base_co2', MODIFY `config_value` text NOT NULL COMMENT '阈值/基数/区间，及新风位置、锅炉清单等列表值';--> statement-breakpoint
ALTER TABLE `alerts` ENGINE = InnoDB, DEFAULT CHARSET = utf8mb4, COMMENT = '预警/标红确认项';--> statement-breakpoint
ALTER TABLE `alerts` MODIFY `rule_key` varchar(64) NOT NULL COMMENT '如 lo_below_threshold / elevator_mismatch / handover_note', MODIFY `target` varchar(64) COMMENT '结构化目标，如 elevator:3 / field:b_co2', MODIFY `message` varchar(300) NOT NULL COMMENT '可解释文案：命中规则+阈值', MODIFY `acknowledged_at` datetime COMMENT '接班人逐条知晓';--> statement-breakpoint
ALTER TABLE `notifications` ENGINE = InnoDB, DEFAULT CHARSET = utf8mb4, COMMENT = '站内通知';--> statement-breakpoint
ALTER TABLE `notifications` MODIFY `user_id` int NOT NULL COMMENT '收件人', MODIFY `kind` varchar(32) NOT NULL COMMENT 'confirm_due / objection_escalated / alert_push / monitor / missing_submit', MODIFY `record_id` int, MODIFY `alert_id` int;--> statement-breakpoint
ALTER TABLE `attachments` ENGINE = InnoDB, DEFAULT CHARSET = utf8mb4, COMMENT = '照片附件';--> statement-breakpoint
ALTER TABLE `attachments` MODIFY `field_name` varchar(64) NOT NULL COMMENT '挂在哪个字段上', MODIFY `taken_at` datetime COMMENT '拍摄时刻（EXIF）', MODIFY `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '上传时刻';--> statement-breakpoint
ALTER TABLE `audit_logs` ENGINE = InnoDB, DEFAULT CHARSET = utf8mb4, COMMENT = '审计日志';--> statement-breakpoint
ALTER TABLE `audit_logs` MODIFY `action` varchar(64) NOT NULL COMMENT '如 config.update / schedule.update / record.override / login', MODIFY `reason` varchar(200) COMMENT '覆盖/充气/防呆确认等原因';