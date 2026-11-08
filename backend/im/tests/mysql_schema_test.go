package tests

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSchemaContainsOnlyFiveCreateTables(t *testing.T) {
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
	if count != 5 {
		t.Fatalf("CREATE TABLE statements = %d, want 5", count)
	}
}

// Opt-in integration test: only a new private data directory and Unix socket are used.
func TestMySQLSchema(t *testing.T) {
	instance := startMySQL(t)
	query := func(statement string, useDatabase bool) (string, error) {
		database := ""
		if useDatabase {
			database = "im_schema_test"
		}
		return instance.query(statement, database)
	}
	version, err := query("SELECT VERSION()", false)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("isolated MySQL %s", version)
	if output, err := query("CREATE DATABASE im_schema_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin", false); err != nil {
		t.Fatalf("create temporary schema: %v: %s", err, output)
	}
	schema, err := os.ReadFile(filepath.Join("..", "sql", "schema.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if output, err := query(string(schema), true); err != nil {
		t.Fatalf("apply schema.sql: %v: %s", err, output)
	}
	must := func(t *testing.T, sql string) string {
		t.Helper()
		output, err := query(sql, true)
		if err != nil {
			t.Fatalf("SQL failed: %v\n%s\n%s", err, sql, output)
		}
		return output
	}
	reject := func(t *testing.T, sql string, code int) {
		t.Helper()
		output, err := query(sql, true)
		if err == nil || !strings.Contains(output, fmt.Sprintf("ERROR %d ", code)) {
			t.Fatalf("want MySQL error %d: %v\n%s\n%s", code, err, sql, output)
		}
	}
	equal := func(t *testing.T, sql, expected string) {
		t.Helper()
		if actual := must(t, sql); actual != expected {
			t.Fatalf("SQL result = %q, want %q\n%s", actual, expected, sql)
		}
	}
	must(t, "INSERT INTO participants (kind,name,created_at) VALUES ('human','用户',1700000000000); INSERT INTO participants (participant_id,kind,name,created_at) VALUES (10,'agent','Alpha',1700000000000),(11,'agent','Beta',1700000000000)")
	must(t, "INSERT INTO conversations (conversation_id,kind,title,created_at) VALUES (7,'group','Team',1700000000100),(8,'direct',NULL,1700000000100)")
	must(t, "INSERT INTO conversation_members (conversation_id,participant_id,created_at) VALUES (7,1,1700000000200),(7,10,1700000000200),(7,11,1700000000200)")
	must(t, "INSERT INTO messages (message_id,conversation_id,sender_id,content,created_at) VALUES (1,7,1,'Hello',1700000000000)")
	must(t, "INSERT INTO messages (message_id,conversation_id,sender_id,content,quoted_message_id,created_at,mentioned_agent_ids) VALUES (2,7,10,'Reply',1,1700000000000,JSON_ARRAY(10,11,10))")

	t.Run("multiple_humans_and_agents", func(t *testing.T) {
		equal(t, "SELECT participant_id,name FROM participants WHERE kind='human'", "1\t用户")
		equal(t, "START TRANSACTION; INSERT INTO participants (kind,name,created_at) VALUES ('human','Second',1700000000000); SELECT COUNT(*) FROM participants WHERE kind='human'; ROLLBACK", "2")
		equal(t, "SELECT COUNT(*) FROM participants WHERE kind='agent'", "2")
	})
	t.Run("field_and_membership_constraints", func(t *testing.T) {
		for _, sql := range []string{
			"INSERT INTO participants (kind,name,created_at) VALUES ('bot','Bad',1700000000000)",
			"INSERT INTO participants (kind,name,created_at) VALUES ('HUMAN','Bad',1700000000000)",
			"INSERT INTO participants (kind,name,created_at) VALUES ('agent','   ',1700000000000)",
			"INSERT INTO conversations (kind,title,created_at) VALUES ('other','Bad',1700000000000)",
			"INSERT INTO conversations (kind,title,created_at) VALUES ('group',NULL,1700000000000)",
			"INSERT INTO conversations (kind,title,created_at) VALUES ('group',' ',1700000000000)",
			"INSERT INTO conversations (kind,title,created_at) VALUES ('direct','',1700000000000)",
		} {
			reject(t, sql, 3819)
		}
		reject(t, "INSERT INTO participants (kind,name,created_at) VALUES ('agent',NULL,1700000000000)", 1048)
		reject(t, "INSERT INTO conversation_members VALUES (7,10,1700000000000)", 1062)
		reject(t, "INSERT INTO conversation_members VALUES (7,NULL,1700000000000)", 1048)
	})
	t.Run("required_creation_times_keep_participant_and_membership_times_distinct", func(t *testing.T) {
		equal(t, "SELECT p.created_at,m.created_at FROM participants p JOIN conversation_members m ON m.participant_id=p.participant_id WHERE p.participant_id=1 AND m.conversation_id=7", "1700000000000\t1700000000200")
		equal(t, "SELECT created_at FROM conversations WHERE conversation_id=7", "1700000000100")
		equal(t, "SELECT GROUP_CONCAT(table_name ORDER BY table_name) FROM information_schema.columns WHERE table_schema=DATABASE() AND column_name='created_at' AND data_type='bigint' AND is_nullable='NO' AND column_default IS NULL", "conversation_members,conversations,messages,participant_accounts,participants")
		for _, sql := range []string{
			"INSERT INTO participants (kind,name) VALUES ('agent','Missing timestamp')",
			"INSERT INTO conversations (kind,title) VALUES ('direct',NULL)",
			"INSERT INTO conversation_members (conversation_id,participant_id) VALUES (7,9999)",
		} {
			reject(t, sql, 1364)
		}
		for _, sql := range []string{
			"INSERT INTO participants (kind,name,created_at) VALUES ('agent','Null timestamp',NULL)",
			"INSERT INTO conversations (kind,title,created_at) VALUES ('direct',NULL,NULL)",
			"INSERT INTO conversation_members (conversation_id,participant_id,created_at) VALUES (7,9999,NULL)",
		} {
			reject(t, sql, 1048)
		}
	})
	t.Run("nullable_unsigned_message_quotes", func(t *testing.T) {
		equal(t, "SELECT quoted_message_id IS NULL FROM messages WHERE message_id=1", "1")
		equal(t, "SELECT quoted_message_id FROM messages WHERE message_id=2", "1")
		equal(t, "SELECT column_type,is_nullable,column_default IS NULL FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='messages' AND column_name='quoted_message_id'", "bigint unsigned\tYES\t1")
		equal(t, "START TRANSACTION; INSERT INTO messages (message_id,conversation_id,sender_id,content,quoted_message_id,created_at) VALUES (100,7,1,'Explicit null',NULL,1700000000000); SELECT quoted_message_id IS NULL FROM messages WHERE message_id=100; ROLLBACK", "1")
		// Existence and same-conversation validation remain future Service work.
		equal(t, "START TRANSACTION; INSERT INTO messages (message_id,conversation_id,sender_id,content,quoted_message_id,created_at) VALUES (100,7,1,'Unchecked target',9999,1700000000000); SELECT quoted_message_id FROM messages WHERE message_id=100; ROLLBACK", "9999")
	})
	t.Run("native_json_default_and_array_constraint", func(t *testing.T) {
		equal(t, "SELECT JSON_TYPE(mentioned_agent_ids),JSON_LENGTH(mentioned_agent_ids) FROM messages WHERE message_id=1", "ARRAY\t0")
		equal(t, "SELECT mentioned_agent_ids FROM messages WHERE message_id=2", "[10, 11, 10]")
		for _, value := range []string{"'{}'", "'1'", "'null'", "'\"text\"'"} {
			reject(t, "INSERT INTO messages (conversation_id,sender_id,content,created_at,mentioned_agent_ids) VALUES (7,1,'Invalid',1700000000000,"+value+")", 3819)
		}
		reject(t, "INSERT INTO messages (conversation_id,sender_id,content,created_at,mentioned_agent_ids) VALUES (7,1,'Invalid',1700000000000,'[bad')", 3140)
		reject(t, "INSERT INTO messages (conversation_id,sender_id,content,created_at,mentioned_agent_ids) VALUES (7,1,'Invalid',1700000000000,NULL)", 1048)
		reject(t, "INSERT INTO messages (conversation_id,sender_id,content,created_at) VALUES (7,1,NULL,1700000000000)", 1048)
		reject(t, "INSERT INTO messages (conversation_id,sender_id,content,created_at) VALUES (7,1,'Invalid',NULL)", 1048)
		equal(t, "SELECT COUNT(*) FROM messages", "2")
	})
	t.Run("five_tables_expected_columns_indexes_no_foreign_keys_or_triggers", func(t *testing.T) {
		equal(t, "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND engine='InnoDB'", "5")
		for table, columns := range map[string]string{
			"participants":         "participant_id,kind,name,created_at",
			"participant_accounts": "participant_id,kind,owner_participant_id,username,password,created_at",
			"conversations":        "conversation_id,kind,title,created_at,dissolved_at",
			"conversation_members": "conversation_id,participant_id,created_at",
			"messages":             "message_id,conversation_id,sender_id,content,quoted_message_id,created_at,mentioned_agent_ids",
		} {
			equal(t, "SELECT GROUP_CONCAT(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='"+table+"'", columns)
		}
		equal(t, "SELECT COUNT(*) FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE()", "0")
		equal(t, "SELECT column_type,is_nullable FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='participant_accounts' AND column_name='password'", "varchar(255)\tNO")
		equal(t, "SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema=DATABASE()", "0")
		equal(t, "SELECT COUNT(DISTINCT table_name,index_name) FROM information_schema.statistics WHERE table_schema=DATABASE()", "9")
		equal(t, "SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index) FROM information_schema.statistics WHERE table_schema=DATABASE() AND index_name='messages_conversation_id_message_id'", "conversation_id,message_id")
		equal(t, "SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index) FROM information_schema.statistics WHERE table_schema=DATABASE() AND index_name='conversation_members_participant_conversation'", "participant_id,conversation_id")
		equal(t, "SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND index_name='participants_one_human'", "0")
		equal(t, "SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index) FROM information_schema.statistics WHERE table_schema=DATABASE() AND index_name='participant_accounts_owner_participant'", "owner_participant_id,participant_id")
	})
	t.Run("message_id_pagination_and_retained_history", func(t *testing.T) {
		must(t, "INSERT INTO messages (message_id,conversation_id,sender_id,content,created_at) VALUES (20,8,1,'Other',1700000000000),(21,7,1,'Later',1700000000000)")
		equal(t, "SELECT message_id FROM messages WHERE conversation_id=7 AND message_id<21 ORDER BY message_id DESC LIMIT 2", "2\n1")
		equal(t, "SELECT message_id FROM messages WHERE conversation_id=7 AND message_id>1 ORDER BY message_id ASC LIMIT 2", "2\n21")
		must(t, "UPDATE conversations SET dissolved_at=1700000000001 WHERE conversation_id=7; DELETE FROM conversation_members WHERE conversation_id=7 AND participant_id=10")
		equal(t, "SELECT COUNT(*) FROM messages WHERE conversation_id=7", "3")
		equal(t, "SELECT COUNT(*) FROM participants WHERE participant_id=10", "1")
		equal(t, "SELECT dissolved_at FROM conversations WHERE conversation_id=7", "1700000000001")
	})
}
