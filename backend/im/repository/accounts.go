package repository

import (
	"context"
	"yqx-team/backend/im/model"
)

const accountColumns = "participant_id, kind, owner_participant_id, username, password, created_at"

func scanAccount(row scanner) (model.ParticipantAccount, error) {
	var account model.ParticipantAccount
	err := row.Scan(&account.ParticipantID, &account.Kind, &account.OwnerParticipantID, &account.Username, &account.Password, &account.CreatedAt)
	return account, err
}

func (q *Queries) GetAccountByUsername(ctx context.Context, username string) (model.ParticipantAccount, error) {
	return scanAccount(q.db.QueryRowContext(ctx, "SELECT "+accountColumns+" FROM participant_accounts WHERE username=?", username))
}

func (q *Queries) GetAccount(ctx context.Context, id string) (model.ParticipantAccount, error) {
	return scanAccount(q.db.QueryRowContext(ctx, "SELECT "+accountColumns+" FROM participant_accounts WHERE participant_id=?", id))
}

func (q *Queries) LockAccount(ctx context.Context, id string) (model.ParticipantAccount, error) {
	return scanAccount(q.db.QueryRowContext(ctx, "SELECT "+accountColumns+" FROM participant_accounts WHERE participant_id=? FOR UPDATE", id))
}

func (q *Queries) InsertAccount(ctx context.Context, account model.ParticipantAccount) error {
	_, err := q.db.ExecContext(ctx, "INSERT INTO participant_accounts (participant_id,kind,owner_participant_id,username,password,created_at) VALUES (?,?,?,?,?,?)", account.ParticipantID, account.Kind, account.OwnerParticipantID, account.Username, account.Password, account.CreatedAt)
	return err
}

func (q *Queries) UpdateAccountCredentials(ctx context.Context, id string, username, password string) error {
	_, err := q.db.ExecContext(ctx, "UPDATE participant_accounts SET username=?, password=? WHERE participant_id=?", username, password, id)
	return err
}

func (q *Queries) ListAccountsByOwner(ctx context.Context, ownerID string) ([]model.ParticipantAccount, error) {
	rows, err := q.db.QueryContext(ctx, "SELECT "+accountColumns+" FROM participant_accounts WHERE owner_participant_id=? AND kind='agent' ORDER BY participant_id", ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	accounts := []model.ParticipantAccount{}
	for rows.Next() {
		account, err := scanAccount(rows)
		if err != nil {
			return nil, err
		}
		accounts = append(accounts, account)
	}
	return accounts, rows.Err()
}
