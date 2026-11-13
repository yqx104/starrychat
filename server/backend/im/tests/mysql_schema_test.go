package tests

import (
	"errors"
	"fmt"
	"github.com/go-sql-driver/mysql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSchemaContainsOnlySixCreateTables(t *testing.T) {
	schema, err := os.ReadFile(filepath.Join("..", "sql", "schema.sql"))
	if err != nil {
		t.Fatal(err)
	}
	var sql strings.Builder
	for _, line := range strings.Split(string(schema), "\n") {
		line, _, _ = strings.Cut(line, "--")
		sql.WriteString(line + "\n")
	}
	count := 0
	for _, statement := range strings.Split(sql.String(), ";") {
		statement = strings.TrimSpace(statement)
		if statement == "" {
			continue
		}
		if !strings.HasPrefix(statement, "CREATE TABLE ") {
			t.Fatalf("schema has a standalone non-table statement: %s", statement)
		}
		count++
	}
	if count != 6 {
		t.Fatalf("CREATE TABLE statements = %d, want 6", count)
	}
}

// Opt-in integration test: only a new private data directory and Unix socket are used.
func TestMySQLSchema(t *testing.T) {
	instance := startMySQL(t)
	f := newIMFixture(t, instance)
	reject := func(statement string, code uint16, args ...any) {
		t.Helper()
		_, err := f.db.ExecContext(t.Context(), statement, args...)
		var sqlError *mysql.MySQLError
		if !errors.As(err, &sqlError) || sqlError.Number != code {
			t.Fatalf("expected MySQL error %d, got %v", code, err)
		}
	}
	t.Run("uuid_columns_indexes_and_sequence_constraints", func(t *testing.T) {
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND engine='InnoDB'"), int64(6))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND column_name IN ('participant_id','owner_participant_id','conversation_id','message_id','sender_id','quoted_message_id') AND column_type='char(36)' AND collation_name='ascii_bin'"), int64(11))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND extra LIKE '%auto_increment%'"), int64(1))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE()"), int64(0))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema=DATABASE()"), int64(0))
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND column_name='created_at' AND data_type='bigint' AND is_nullable='NO' AND column_default IS NULL"), int64(6))
		var columns string
		if err := f.db.QueryRowContext(t.Context(), "SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index) FROM information_schema.statistics WHERE table_schema=DATABASE() AND index_name='messages_conversation_seq' AND non_unique=0").Scan(&columns); err != nil {
			t.Fatal(err)
		}
		equalValue(t, columns, "conversation_id,message_seq")
	})
	t.Run("rejects_noncanonical_uuids_and_invalid_fields", func(t *testing.T) {
		for _, id := range []string{"1", "", "00000000-0000-4000-8000-000000000001", "00000000-0000-7000-8000-00000000000A"} {
			reject("INSERT INTO participants (participant_id,kind,name,created_at) VALUES (?,'agent','Invalid',1)", 3819, id)
		}
		for _, kind := range []string{"bot", "HUMAN"} {
			reject("INSERT INTO participants (participant_id,kind,name,created_at) VALUES (?,?,'Bad',1)", 3819, testID(100), kind)
		}
		reject("INSERT INTO participants (participant_id,kind,name,created_at) VALUES (?,'agent','   ',1)", 3819, testID(100))
		reject("INSERT INTO participants (participant_id,kind,name,created_at) VALUES (?,'agent',NULL,1)", 1048, testID(100))
		reject("INSERT INTO participants (participant_id,kind,name) VALUES (?,'agent','Missing time')", 1364, testID(100))
		reject("INSERT INTO conversations (conversation_id,kind,title,created_at) VALUES (?,'group',NULL,1)", 3819, testID(100))
		reject("INSERT INTO conversations (conversation_id,kind,title,created_at) VALUES (?,'group',' ',1)", 3819, testID(100))
		reject("INSERT INTO conversations (conversation_id,kind,title,created_at) VALUES (?,'other','Bad',1)", 3819, testID(100))
	})
	t.Run("trigger_event_conversation_scope", func(t *testing.T) {
		insert := "INSERT INTO trigger_outbox (conversation_id,operation,payload,next_attempt_at,created_at) VALUES (?,?,JSON_OBJECT('agent_id',?),0,1)"
		f.exec(t, insert, nil, "register_agent", f.alpha.ParticipantID)
		reject(insert, 3819, testID(100), "register_agent", f.alpha.ParticipantID)
		for _, operation := range []string{"subscribe", "unsubscribe", "clear", "message"} {
			reject(insert, 3819, nil, operation, f.alpha.ParticipantID)
		}
	})
	t.Run("message_sequences_quotes_and_json", func(t *testing.T) {
		group := f.group(t, f.alpha)
		other := f.group(t, f.beta)
		first := f.send(t, group.ConversationID, "First", f.human)
		second := f.send(t, other.ConversationID, "Other first", f.human)
		equalValue(t, first.MessageSeq, int64(1))
		equalValue(t, second.MessageSeq, int64(1))
		equalValue(t, f.count(t, "SELECT last_message_seq FROM conversations WHERE conversation_id=?", group.ConversationID), int64(1))
		equalValue(t, f.count(t, "SELECT quoted_message_id IS NULL AND JSON_LENGTH(mentioned_agent_ids)=0 FROM messages WHERE message_id=?", first.MessageID), int64(1))
		insert := "INSERT INTO messages (message_id,conversation_id,sender_id,message_seq,content,quoted_message_id,created_at,mentioned_agent_ids) VALUES (?,?,?,?,?,?,?,?)"
		reject(insert, 1062, testID(100), group.ConversationID, f.human.ParticipantID, 1, "Duplicate seq", nil, 1, "[]")
		reject(insert, 1062, first.MessageID, group.ConversationID, f.human.ParticipantID, 2, "Duplicate ID", nil, 1, "[]")
		reject(insert, 3819, testID(100), group.ConversationID, f.human.ParticipantID, 0, "Zero seq", nil, 1, "[]")
		reject(insert, 3819, testID(100), group.ConversationID, f.human.ParticipantID, int64(9007199254740992), "Unsafe seq", nil, 1, "[]")
		for _, json := range []string{"{}", "null", "1"} {
			reject(insert, 3819, testID(100), group.ConversationID, f.human.ParticipantID, 2, "Invalid mentions", nil, 1, json)
		}
		reject(insert, 3140, testID(100), group.ConversationID, f.human.ParticipantID, 2, "Invalid JSON", nil, 1, "[bad")
		reject(insert, 1048, testID(100), group.ConversationID, f.human.ParticipantID, 2, "Null JSON", nil, 1, nil)
		reject("UPDATE conversations SET last_message_seq=9007199254740992 WHERE conversation_id=?", 3819, group.ConversationID)
		reject("INSERT INTO conversation_members (conversation_id,participant_id,created_at) VALUES (?,?,1)", 1062, group.ConversationID, f.human.ParticipantID)
		f.exec(t, insert, testID(100), group.ConversationID, f.alpha.ParticipantID, 2, "Quote", first.MessageID, 1, fmt.Sprintf("[%q]", f.alpha.ParticipantID))
		message, err := f.store.GetMessage(t.Context(), testID(100))
		if err != nil {
			t.Fatal(err)
		}
		equalValue(t, message.QuotedMessageID, &first.MessageID)
		equalValue(t, message.MentionedAgentIDs, []string{f.alpha.ParticipantID})
		f.exec(t, "UPDATE conversations SET dissolved_at=1 WHERE conversation_id=?", group.ConversationID)
		f.exec(t, "DELETE FROM conversation_members WHERE conversation_id=? AND participant_id=?", group.ConversationID, f.alpha.ParticipantID)
		equalValue(t, f.count(t, "SELECT COUNT(*) FROM messages WHERE conversation_id=?", group.ConversationID), int64(2))
	})
	t.Run("trigger_uses_im_uuid_agent_ids", func(t *testing.T) {
		schema, err := os.ReadFile(filepath.Join("..", "..", "trigger", "sql", "schema.sql"))
		if err != nil {
			t.Fatal(err)
		}
		if output, err := instance.query("CREATE DATABASE trigger_schema_test; USE trigger_schema_test; "+string(schema), ""); err != nil {
			t.Fatalf("trigger schema: %v: %s", err, output)
		}
		statement := fmt.Sprintf("INSERT INTO agents VALUES ('%s',1); INSERT INTO channels VALUES ('%s','%s','im_group','%s',1)", f.alpha.ParticipantID, f.alpha.ParticipantID, testID(100), testID(101))
		if output, err := instance.query(statement, "trigger_schema_test"); err != nil {
			t.Fatalf("trigger insert: %v: %s", err, output)
		}
		output, err := instance.query("SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND column_name='agent_id' AND column_type='char(36)' AND collation_name='ascii_bin'", "trigger_schema_test")
		if err != nil || output != "3" {
			t.Fatalf("trigger columns: %v %s", err, output)
		}
		if _, err := instance.query("INSERT INTO agents VALUES ('1',1)", "trigger_schema_test"); err == nil {
			t.Fatal("numeric Trigger agent accepted")
		}
	})
}
