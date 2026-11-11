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
    state TEXT NOT NULL DEFAULT 'pending',
    received_at INTEGER NOT NULL,
    UNIQUE (agent_id, message_id)
);
CREATE INDEX inbox_agent_id ON inbox(agent_id, id);
