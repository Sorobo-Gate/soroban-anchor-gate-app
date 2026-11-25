package migrations

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	_ "github.com/lib/pq"
)

func TestEmbeddedSQLFiles(t *testing.T) {
	migrator := NewMigrator(nil, nil)
	migrations, err := migrator.LoadMigrations()
	if err != nil {
		t.Fatalf("LoadMigrations() failed: %v", err)
	}

	if len(migrations) < 3 {
		t.Fatalf("expected at least 3 migrations, got %d", len(migrations))
	}

	if migrations[0].Version != 1 || migrations[0].Name != "initial_schema" {
		t.Errorf("migration 0 mismatch: got version=%d, name=%s", migrations[0].Version, migrations[0].Name)
	}
	if !strings.Contains(migrations[0].UpSQL, "CREATE TABLE IF NOT EXISTS processed_events") {
		t.Errorf("migration 1 UpSQL missing processed_events table")
	}
	if !strings.Contains(migrations[0].DownSQL, "DROP TABLE IF EXISTS processed_events") {
		t.Errorf("migration 1 DownSQL missing DROP TABLE")
	}

	if migrations[1].Version != 2 || migrations[1].Name != "add_anchor_transactions" {
		t.Errorf("migration 1 mismatch: got version=%d, name=%s", migrations[1].Version, migrations[1].Name)
	}
	if !strings.Contains(migrations[1].UpSQL, "CREATE TABLE IF NOT EXISTS anchor_transactions") {
		t.Errorf("migration 2 UpSQL missing anchor_transactions table")
	}

	if migrations[2].Version != 3 || migrations[2].Name != "outbox_and_processed_ledgers" {
		t.Errorf("migration 2 mismatch: got version=%d, name=%s", migrations[2].Version, migrations[2].Name)
	}
	if !strings.Contains(migrations[2].UpSQL, "CREATE TABLE IF NOT EXISTS outbox_events") {
		t.Errorf("migration 3 UpSQL missing outbox_events table")
	}
	if !strings.Contains(migrations[2].UpSQL, "CREATE TABLE IF NOT EXISTS processed_ledgers") {
		t.Errorf("migration 3 UpSQL missing processed_ledgers table")
	}
	if !strings.Contains(migrations[1].DownSQL, "DROP TABLE IF EXISTS anchor_transactions") {
		t.Errorf("migration 2 DownSQL missing DROP TABLE")
	}
}

func TestLoadMigrationsCustomFS(t *testing.T) {
	customFS := fstest.MapFS{
		"000001_first.up.sql":    &fstest.MapFile{Data: []byte("CREATE TABLE t1 (id int);")},
		"000001_first.down.sql":  &fstest.MapFile{Data: []byte("DROP TABLE t1;")},
		"000002_second.up.sql":   &fstest.MapFile{Data: []byte("CREATE TABLE t2 (id int);")},
		"000002_second.down.sql": &fstest.MapFile{Data: []byte("DROP TABLE t2;")},
	}

	migrator := NewMigrator(nil, nil).WithFS(customFS)
	migrations, err := migrator.LoadMigrations()
	if err != nil {
		t.Fatalf("LoadMigrations() with custom FS failed: %v", err)
	}

	if len(migrations) != 2 {
		t.Fatalf("expected 2 migrations, got %d", len(migrations))
	}
	if migrations[0].Version != 1 || migrations[0].Name != "first" {
		t.Errorf("expected version 1 (first), got %d (%s)", migrations[0].Version, migrations[0].Name)
	}
	if migrations[1].Version != 2 || migrations[1].Name != "second" {
		t.Errorf("expected version 2 (second), got %d (%s)", migrations[1].Version, migrations[1].Name)
	}
}

// In-memory mock SQL driver for testing migration operations and state management
type mockState struct {
	mu           sync.Mutex
	tableCreated bool
	versions     map[int]bool // version -> dirty
	executedSQL  []string
	failNextExec bool
}

var (
	testDriverOnce sync.Once
	globalMock     = &mockState{
		versions: make(map[int]bool),
	}
)

type mockDriver struct{}

func (d *mockDriver) Open(name string) (driver.Conn, error) {
	return &mockConn{state: globalMock}, nil
}

type mockConn struct {
	state *mockState
}

func (c *mockConn) Prepare(query string) (driver.Stmt, error) {
	return &mockStmt{conn: c, query: query}, nil
}

func (c *mockConn) Close() error {
	return nil
}

func (c *mockConn) Begin() (driver.Tx, error) {
	return &mockTx{conn: c}, nil
}

func (c *mockConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.state.mu.Lock()
	defer c.state.mu.Unlock()

	if c.state.failNextExec {
		c.state.failNextExec = false
		return nil, errors.New("simulated execution failure")
	}

	c.state.executedSQL = append(c.state.executedSQL, query)

	if strings.Contains(query, "CREATE TABLE IF NOT EXISTS schema_migrations") {
		c.state.tableCreated = true
		return driver.RowsAffected(1), nil
	}

	if strings.Contains(query, "INSERT INTO schema_migrations") {
		if len(args) > 0 {
			if v, ok := args[0].Value.(int64); ok {
				c.state.versions[int(v)] = true
			}
		}
		return driver.RowsAffected(1), nil
	}

	if strings.Contains(query, "UPDATE schema_migrations SET dirty = false") {
		if len(args) > 0 {
			if v, ok := args[0].Value.(int64); ok {
				c.state.versions[int(v)] = false
			}
		}
		return driver.RowsAffected(1), nil
	}

	if strings.Contains(query, "UPDATE schema_migrations SET dirty = true") {
		if len(args) > 0 {
			if v, ok := args[0].Value.(int64); ok {
				c.state.versions[int(v)] = true
			}
		}
		return driver.RowsAffected(1), nil
	}

	if strings.Contains(query, "DELETE FROM schema_migrations") {
		if len(args) > 0 {
			if v, ok := args[0].Value.(int64); ok {
				delete(c.state.versions, int(v))
			}
		}
		return driver.RowsAffected(1), nil
	}

	return driver.RowsAffected(1), nil
}

func (c *mockConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	c.state.mu.Lock()
	defer c.state.mu.Unlock()

	if strings.Contains(query, "SELECT version, dirty FROM schema_migrations") {
		var maxVer int = -1
		var isDirty bool = false
		for v, d := range c.state.versions {
			if v > maxVer {
				maxVer = v
				isDirty = d
			}
		}

		if maxVer == -1 {
			return &mockRows{rows: nil}, nil
		}
		return &mockRows{
			rows: [][]driver.Value{
				{int64(maxVer), isDirty},
			},
		}, nil
	}

	return &mockRows{rows: nil}, nil
}

type mockStmt struct {
	conn  *mockConn
	query string
}

func (s *mockStmt) Close() error {
	return nil
}

func (s *mockStmt) NumInput() int {
	return -1
}

func (s *mockStmt) Exec(args []driver.Value) (driver.Result, error) {
	named := make([]driver.NamedValue, len(args))
	for i, a := range args {
		named[i] = driver.NamedValue{Ordinal: i + 1, Value: a}
	}
	return s.conn.ExecContext(context.Background(), s.query, named)
}

func (s *mockStmt) Query(args []driver.Value) (driver.Rows, error) {
	named := make([]driver.NamedValue, len(args))
	for i, a := range args {
		named[i] = driver.NamedValue{Ordinal: i + 1, Value: a}
	}
	return s.conn.QueryContext(context.Background(), s.query, named)
}

type mockTx struct {
	conn *mockConn
}

func (tx *mockTx) Commit() error {
	return nil
}

func (tx *mockTx) Rollback() error {
	return nil
}

type mockRows struct {
	rows [][]driver.Value
	idx  int
}

func (r *mockRows) Columns() []string {
	return []string{"version", "dirty"}
}

func (r *mockRows) Close() error {
	return nil
}

func (r *mockRows) Next(dest []driver.Value) error {
	if r.idx >= len(r.rows) {
		return io.EOF
	}
	for i, v := range r.rows[r.idx] {
		dest[i] = v
	}
	r.idx++
	return nil
}

func getMockDB(t *testing.T) (*sql.DB, *mockState) {
	testDriverOnce.Do(func() {
		sql.Register("mock_migration_driver", &mockDriver{})
	})

	globalMock.mu.Lock()
	globalMock.tableCreated = false
	globalMock.versions = make(map[int]bool)
	globalMock.executedSQL = nil
	globalMock.failNextExec = false
	globalMock.mu.Unlock()

	db, err := sql.Open("mock_migration_driver", "mock_dsn")
	if err != nil {
		t.Fatalf("failed to open mock db: %v", err)
	}
	return db, globalMock
}

func TestMigratorRunPendingAndRollback(t *testing.T) {
	db, state := getMockDB(t)
	defer db.Close()

	ctx := context.Background()
	migrator := NewMigrator(db, nil)

	// 1. Initial version should be 0
	ver, dirty, err := migrator.GetVersion(ctx)
	if err != nil {
		t.Fatalf("GetVersion() unexpected error: %v", err)
	}
	if ver != 0 || dirty {
		t.Fatalf("expected version 0 and not dirty, got version=%d dirty=%v", ver, dirty)
	}

	// 2. Run pending migrations
	if err := migrator.RunPending(ctx); err != nil {
		t.Fatalf("RunPending() failed: %v", err)
	}

	// Should now be at version 3, clean
	ver, dirty, err = migrator.GetVersion(ctx)
	if err != nil {
		t.Fatalf("GetVersion() unexpected error: %v", err)
	}
	if ver != 3 || dirty {
		t.Fatalf("expected version 3 clean, got version=%d dirty=%v", ver, dirty)
	}

	// 3. Running pending again should be idempotent
	if err := migrator.RunPending(ctx); err != nil {
		t.Fatalf("second RunPending() failed: %v", err)
	}

	// 4. Rollback latest migration (version 3 -> 2)
	if err := migrator.RollbackLatest(ctx); err != nil {
		t.Fatalf("RollbackLatest() failed: %v", err)
	}
	ver, dirty, err = migrator.GetVersion(ctx)
	if err != nil {
		t.Fatalf("GetVersion() after rollback failed: %v", err)
	}
	if ver != 2 || dirty {
		t.Fatalf("expected version 2 clean after rollback, got version=%d dirty=%v", ver, dirty)
	}

	// 5. Rollback latest migration (version 2 -> 1)
	if err := migrator.RollbackLatest(ctx); err != nil {
		t.Fatalf("RollbackLatest() failed: %v", err)
	}
	ver, dirty, err = migrator.GetVersion(ctx)
	if err != nil {
		t.Fatalf("GetVersion() after second rollback failed: %v", err)
	}
	if ver != 1 || dirty {
		t.Fatalf("expected version 1 clean after second rollback, got version=%d dirty=%v", ver, dirty)
	}

	// 6. Rollback again (version 1 -> 0)
	if err := migrator.Down(ctx); err != nil {
		t.Fatalf("Down() failed: %v", err)
	}
	ver, dirty, err = migrator.GetVersion(ctx)
	if err != nil {
		t.Fatalf("GetVersion() after third rollback failed: %v", err)
	}
	if ver != 0 || dirty {
		t.Fatalf("expected version 0 clean after third rollback, got version=%d dirty=%v", ver, dirty)
	}

	// 7. Rollback when version is 0 is a clean no-op
	if err := migrator.RollbackLatest(ctx); err != nil {
		t.Fatalf("RollbackLatest() at version 0 returned error: %v", err)
	}

	_ = state
}

func TestMigratorDirtyStateProtection(t *testing.T) {
	db, state := getMockDB(t)
	defer db.Close()

	ctx := context.Background()
	migrator := NewMigrator(db, nil)

	// Simulate dirty state at version 1
	state.mu.Lock()
	state.tableCreated = true
	state.versions[1] = true
	state.mu.Unlock()

	// RunPending should be blocked by dirty state
	err := migrator.RunPending(ctx)
	if err == nil || !strings.Contains(err.Error(), "dirty state") {
		t.Fatalf("expected dirty state error from RunPending, got %v", err)
	}

	// RollbackLatest should also be blocked by dirty state
	err = migrator.RollbackLatest(ctx)
	if err == nil || !strings.Contains(err.Error(), "dirty state") {
		t.Fatalf("expected dirty state error from RollbackLatest, got %v", err)
	}
}

func TestMigratorExecutionFailure(t *testing.T) {
	db, state := getMockDB(t)
	defer db.Close()

	ctx := context.Background()
	migrator := NewMigrator(db, nil)

	// Tell mock to fail next execution
	state.mu.Lock()
	state.failNextExec = true
	state.mu.Unlock()

	err := migrator.RunPending(ctx)
	if err == nil {
		t.Fatal("expected error from simulated execution failure, got nil")
	}
}

func TestPostgresIntegration(t *testing.T) {
	connStr := os.Getenv("POSTGRES_URL")
	if connStr == "" {
		connStr = os.Getenv("DATABASE_URL")
	}
	if connStr == "" {
		t.Skip("PostgreSQL integration test skipped: set POSTGRES_URL or DATABASE_URL to run against PostgreSQL test container")
	}

	db, err := sql.Open("postgres", connStr)
	if err != nil {
		t.Skipf("cannot open postgres connection: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		t.Skipf("postgres database not reachable: %v", err)
	}

	migrator := NewMigrator(db, nil)

	// Test migration up
	if err := migrator.RunPending(ctx); err != nil {
		t.Fatalf("PostgreSQL RunPending failed: %v", err)
	}

	ver, dirty, err := migrator.GetVersion(ctx)
	if err != nil {
		t.Fatalf("PostgreSQL GetVersion failed: %v", err)
	}
	if ver < 2 || dirty {
		t.Fatalf("expected ver >= 2 clean, got ver=%d dirty=%v", ver, dirty)
	}

	// Verify tables exist
	var exists bool
	query := `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'processed_events');`
	if err := db.QueryRowContext(ctx, query).Scan(&exists); err != nil || !exists {
		t.Fatalf("table processed_events not found in postgres: %v", err)
	}

	// Test migration down
	if err := migrator.RollbackLatest(ctx); err != nil {
		t.Fatalf("PostgreSQL RollbackLatest failed: %v", err)
	}
}
