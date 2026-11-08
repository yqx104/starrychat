package repository

import (
	"context"
	"database/sql"
	"errors"
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

// Open connects to an existing database. Schema changes remain an administrator operation.
func Open(ctx context.Context, dsn string) (*Repository, error) {
	c, err := mysql.ParseDSN(dsn)
	if err != nil {
		return nil, err
	}
	if c.DBName == "" {
		return nil, errors.New("the MySQL DSN must select a database")
	}
	if c.Timeout == 0 {
		c.Timeout = 5 * time.Second
	}
	connector, err := mysql.NewConnector(c)
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
		return nil, err
	}
	return &Repository{Queries: &Queries{db: pool}, pool: pool}, nil
}

func (r *Repository) Close() error { return r.pool.Close() }

func (r *Repository) Ping(ctx context.Context) error { return r.pool.PingContext(ctx) }

func (r *Repository) WithinTx(ctx context.Context, run func(*Queries) error) error {
	tx, err := r.pool.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := run(&Queries{db: tx}); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *Repository) CheckSchema(ctx context.Context) error {
	for _, query := range []string{
		"SELECT agent_id, created_at FROM agents LIMIT 0",
		"SELECT agent_id, channel_id, channel_type, conversation_id, created_at FROM channels LIMIT 0",
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
