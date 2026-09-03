CREATE TABLE `sessions` (
	`token_hash` char(64) NOT NULL,
	`user_id` int NOT NULL,
	`ip` varchar(64),
	`user_agent` varchar(200),
	`channel` enum('cookie','bearer') NOT NULL DEFAULT 'cookie',
	`created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`last_seen_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
	`expires_at` datetime NOT NULL,
	CONSTRAINT `sessions_token_hash` PRIMARY KEY(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_sess_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_sess_exp` ON `sessions` (`expires_at`);--> statement-breakpoint
ALTER TABLE `sessions` ENGINE = InnoDB, DEFAULT CHARSET = utf8mb4, COMMENT = '会话存根';--> statement-breakpoint
ALTER TABLE `sessions` MODIFY `token_hash` char(64) NOT NULL COMMENT 'SHA-256(令牌) 摘要，不存明文；拖库也不能冒用在线会话', MODIFY `ip` varchar(64) COMMENT '登录来源 IP（C-05）', MODIFY `user_agent` varchar(200) COMMENT '设备/客户端标识（C-05 登录设备可追溯）', MODIFY `channel` enum('cookie','bearer') NOT NULL DEFAULT 'cookie' COMMENT '凭证下发通道：浏览器 cookie / 小程序等 bearer', MODIFY `last_seen_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '最后活跃时刻（滑动超时判定）', MODIFY `expires_at` datetime NOT NULL COMMENT '过期时刻 = last_seen_at + configs.session_timeout_minutes';