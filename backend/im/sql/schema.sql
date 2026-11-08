CREATE TABLE participants (
    participant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY CHECK (REGEXP_LIKE(participant_id, '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'c')),
    kind VARCHAR(5) NOT NULL CHECK (kind IN ('human', 'agent')),
    name LONGTEXT NOT NULL CHECK (CHAR_LENGTH(TRIM(name)) > 0),
    created_at BIGINT NOT NULL -- Unix 毫秒。
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

CREATE TABLE participant_accounts (
  participant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY CHECK (REGEXP_LIKE(participant_id, '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'c')),
  kind VARCHAR(5) NOT NULL,
  owner_participant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL CHECK (REGEXP_LIKE(owner_participant_id, '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'c')),
  username VARCHAR(64) NOT NULL,
  password VARCHAR(255) NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE KEY participant_accounts_username (username),
  KEY participant_accounts_owner_participant (owner_participant_id, participant_id),
  CONSTRAINT participant_accounts_kind_owner CHECK (
    (kind = 'human' AND owner_participant_id IS NULL) OR
    (kind = 'agent' AND owner_participant_id IS NOT NULL AND owner_participant_id <> participant_id)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE conversations (
    conversation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY CHECK (REGEXP_LIKE(conversation_id, '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'c')),
    kind VARCHAR(6) NOT NULL CHECK (kind IN ('direct', 'group')),
    title LONGTEXT CHECK (title IS NULL OR CHAR_LENGTH(TRIM(title)) > 0),
    created_at BIGINT NOT NULL, -- Unix 毫秒。
    last_message_seq BIGINT UNSIGNED NOT NULL DEFAULT 0 CHECK (last_message_seq <= 9007199254740991),
    dissolved_at BIGINT, -- Unix 毫秒；NULL 表示未解散。
    CHECK (kind <> 'group' OR title IS NOT NULL)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

CREATE TABLE conversation_members (
    conversation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (REGEXP_LIKE(conversation_id, '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'c')),
    participant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (REGEXP_LIKE(participant_id, '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'c')),
    created_at BIGINT NOT NULL, -- Unix 毫秒。
    PRIMARY KEY (conversation_id, participant_id),
    KEY conversation_members_participant_conversation (participant_id, conversation_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

CREATE TABLE messages (
    message_seq BIGINT UNSIGNED NOT NULL CHECK (message_seq BETWEEN 1 AND 9007199254740991),
    message_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY CHECK (REGEXP_LIKE(message_id, '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'c')),
    conversation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (REGEXP_LIKE(conversation_id, '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'c')),
    sender_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (REGEXP_LIKE(sender_id, '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'c')),
    content LONGTEXT NOT NULL,
    quoted_message_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin CHECK (REGEXP_LIKE(quoted_message_id, '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'c')), -- NULL 表示未引用。
    created_at BIGINT NOT NULL, -- Unix 毫秒。
    mentioned_agent_ids JSON NOT NULL DEFAULT (JSON_ARRAY())
        CHECK (JSON_TYPE(mentioned_agent_ids) = 'ARRAY'),
    UNIQUE KEY messages_conversation_seq (conversation_id, message_seq)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;
