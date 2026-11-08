CREATE TABLE participants (
    participant_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    kind VARCHAR(5) NOT NULL CHECK (kind IN ('human', 'agent')),
    name LONGTEXT NOT NULL CHECK (CHAR_LENGTH(TRIM(name)) > 0),
    created_at BIGINT NOT NULL -- Unix 毫秒。
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

CREATE TABLE participant_accounts (
  participant_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  kind VARCHAR(5) NOT NULL,
  owner_participant_id BIGINT UNSIGNED NULL,
  username VARCHAR(64) NOT NULL,
  password VARCHAR(255) NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE KEY participant_accounts_username (username),
  KEY participant_accounts_owner_participant (owner_participant_id, participant_id),
  CONSTRAINT participant_accounts_kind_owner CHECK (
    (kind = 'human' AND owner_participant_id IS NULL) OR
    (kind = 'agent' AND owner_participant_id IS NOT NULL AND owner_participant_id > 0 AND owner_participant_id <> participant_id)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE conversations (
    conversation_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    kind VARCHAR(6) NOT NULL CHECK (kind IN ('direct', 'group')),
    title LONGTEXT CHECK (title IS NULL OR CHAR_LENGTH(TRIM(title)) > 0),
    created_at BIGINT NOT NULL, -- Unix 毫秒。
    dissolved_at BIGINT, -- Unix 毫秒；NULL 表示未解散。
    CHECK (kind <> 'group' OR title IS NOT NULL)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

CREATE TABLE conversation_members (
    conversation_id BIGINT UNSIGNED NOT NULL,
    participant_id BIGINT UNSIGNED NOT NULL,
    created_at BIGINT NOT NULL, -- Unix 毫秒。
    PRIMARY KEY (conversation_id, participant_id),
    KEY conversation_members_participant_conversation (participant_id, conversation_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

CREATE TABLE messages (
    message_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    conversation_id BIGINT UNSIGNED NOT NULL,
    sender_id BIGINT UNSIGNED NOT NULL,
    content LONGTEXT NOT NULL,
    quoted_message_id BIGINT UNSIGNED, -- NULL 表示未引用。
    created_at BIGINT NOT NULL, -- Unix 毫秒。
    mentioned_agent_ids JSON NOT NULL DEFAULT (JSON_ARRAY())
        CHECK (JSON_TYPE(mentioned_agent_ids) = 'ARRAY'),
    KEY messages_conversation_id_message_id (conversation_id, message_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;
