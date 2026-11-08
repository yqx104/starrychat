package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

type dbtx interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type scanner interface{ Scan(...any) error }

type Queries struct{ db dbtx }

type Repository struct {
	*Queries
	pool *sql.DB
}

// Open connects only to the explicitly configured database. It does not create or migrate tables.
func Open(ctx context.Context, dsn string) (*Repository, error) {
	if strings.TrimSpace(dsn) == "" {
		return nil, errors.New("an explicit MySQL DSN is required")
	}
	config, err := mysql.ParseDSN(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse MySQL DSN: %w", err)
	}
	if config.DBName == "" {
		return nil, errors.New("the MySQL DSN must select a database")
	}
	if config.Timeout == 0 {
		config.Timeout = 5 * time.Second
	}
	connector, err := mysql.NewConnector(config)
	if err != nil {
		return nil, err
	}
	pool := sql.OpenDB(connector)
	pool.SetMaxOpenConns(10)
	pool.SetMaxIdleConns(5)
	pool.SetConnMaxLifetime(3 * time.Minute)
	pool.SetConnMaxIdleTime(time.Minute)
	if err := pool.PingContext(ctx); err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("connect to MySQL: %w", err)
	}
	return &Repository{Queries: &Queries{db: pool}, pool: pool}, nil
}

func (r *Repository) Close() error {
	return r.pool.Close()
}

// The service chooses transaction scope and isolation; every query uses this transaction's connection.
func (r *Repository) WithinTx(ctx context.Context, options *sql.TxOptions, run func(*Queries) error) error {
	tx, err := r.pool.BeginTx(ctx, options)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := run(&Queries{db: tx}); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *Repository) CheckSchema(ctx context.Context) error {
	for _, query := range []string{
		"SELECT participant_id, kind, name, created_at FROM participants LIMIT 0",
		"SELECT participant_id, kind, owner_participant_id, username, password, created_at FROM participant_accounts LIMIT 0",
		"SELECT conversation_id, kind, title, created_at, dissolved_at, last_message_seq FROM conversations LIMIT 0",
		"SELECT conversation_id, participant_id, created_at FROM conversation_members LIMIT 0",
		"SELECT message_id, message_seq, conversation_id, sender_id, content, quoted_message_id, created_at, mentioned_agent_ids FROM messages LIMIT 0",
	} {
		rows, err := r.pool.QueryContext(ctx, query)
		if err != nil {
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}
	}
	return nil
}
