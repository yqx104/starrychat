CREATE TABLE agents (
    agent_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT NOT NULL,
    token TEXT NOT NULL,
    credential_expires_at INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    message_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','accepted','rejected','needs_recovery')),
    receipt_disposition TEXT CHECK (receipt_disposition IN ('started','queued','handled')),
    last_error TEXT,
    received_at INTEGER NOT NULL,
    UNIQUE (agent_id, message_id)
);
CREATE INDEX inbox_agent_id ON inbox(agent_id, id);

CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL UNIQUE REFERENCES agents(agent_id),
    harness TEXT NOT NULL,
    cwd TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json) AND json_type(config_json) = 'object'),
    native_ref_json TEXT DEFAULT NULL CHECK (native_ref_json IS NULL OR (json_valid(native_ref_json) AND json_type(native_ref_json) = 'object'))
);
