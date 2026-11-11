CREATE TABLE agents (
    agent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY CHECK (REGEXP_LIKE(agent_id, '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'c')), -- 沿用 IM 中 kind=agent 的 participant_id，不自增。
    created_at BIGINT NOT NULL -- 在 Trigger 注册的 Unix 毫秒时间。
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

-- 每个 Agent、channel 的持久化收件队列；收到客户端落盘 ACK 后记录 acked_at。
CREATE TABLE deliveries (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    agent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    channel_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    message_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    message_seq BIGINT NOT NULL,
    payload JSON NOT NULL,
    created_at BIGINT NOT NULL,
    acked_at BIGINT NULL,
    UNIQUE KEY deliveries_agent_message (agent_id, message_id),
    KEY deliveries_pending (agent_id, channel_id, acked_at, message_seq)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

-- 每行表示一个 Agent 对一个 channel 的订阅；同一来源会话的订阅共享 channel_id。
CREATE TABLE channels (
    agent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (REGEXP_LIKE(agent_id, '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'c')),
    channel_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    channel_type VARCHAR(32) NOT NULL CHECK (CHAR_LENGTH(TRIM(channel_type)) > 0), -- 首版：im_direct、im_group。
    conversation_id VARCHAR(191) NOT NULL CHECK (CHAR_LENGTH(TRIM(conversation_id)) > 0), -- 来源会话 ID；IM 会话 ID 直接保存标准 UUIDv7 字符串。
    created_at BIGINT NOT NULL, -- 订阅创建的 Unix 毫秒时间。
    PRIMARY KEY (agent_id, channel_id),
    UNIQUE KEY channels_source_agent (channel_type, conversation_id, agent_id),
    KEY channels_channel_agent (channel_id, agent_id),
    CONSTRAINT channels_uuid_v7 CHECK (
        REGEXP_LIKE(channel_id, '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'c')
    )
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;
