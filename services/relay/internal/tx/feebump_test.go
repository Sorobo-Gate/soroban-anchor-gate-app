package tx

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/soroban-anchor-gate/relay/internal/signer"
)

// hashA and hashB are canonical 64-character transaction hashes used by tests.
var (
	hashA = strings.Repeat("a", 64)
	hashB = strings.Repeat("b", 64)
	hashC = strings.Repeat("c", 64)
)

// fakeClient is an in-memory Client implementation for deterministic tests.
type fakeClient struct {
	mu sync.Mutex

	latest    uint32
	latestErr error

	statuses  map[string]TransactionStatus
	statusErr error

	sendResult SendResult
	sendErr    error

	sentEnvelopes []string
	latestCalls   int
}

func newFakeClient(latest uint32) *fakeClient {
	return &fakeClient{latest: latest, statuses: make(map[string]TransactionStatus)}
}

func (f *fakeClient) GetLatestLedger(context.Context) (uint32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.latestCalls++
	if f.latestErr != nil {
		return 0, f.latestErr
	}
	return f.latest, nil
}

func (f *fakeClient) GetTransaction(_ context.Context, hash string) (TransactionStatus, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.statusErr != nil {
		return TransactionStatus{}, f.statusErr
	}
	if status, ok := f.statuses[hash]; ok {
		return status, nil
	}
	return TransactionStatus{Hash: hash, Status: InclusionNotFound}, nil
}

func (f *fakeClient) SendTransaction(_ context.Context, envelopeXDR string) (SendResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.sendErr != nil {
		return SendResult{}, f.sendErr
	}
	f.sentEnvelopes = append(f.sentEnvelopes, envelopeXDR)
	if f.sendResult.Status == "" {
		return SendResult{Status: SendPending}, nil
	}
	return f.sendResult, nil
}

func (f *fakeClient) sentCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sentEnvelopes)
}

func newTestManager(t *testing.T, client Client, cfg Config) *FeeBumpManager {
	t.Helper()
	keyManager, err := signer.GenerateEphemeralKeyManager()
	if err != nil {
		t.Fatalf("generate key manager: %v", err)
	}
	if cfg.NetworkPassphrase == "" {
		cfg.NetworkPassphrase = testnetPassphrase
	}
	if cfg.MaxFee == 0 {
		cfg.MaxFee = 100_000
	}
	manager, err := NewFeeBumpManager(client, keyManager, cfg)
	if err != nil {
		t.Fatalf("NewFeeBumpManager: %v", err)
	}
	return manager
}

func TestNewFeeBumpManagerValidation(t *testing.T) {
	keyManager, err := signer.GenerateEphemeralKeyManager()
	if err != nil {
		t.Fatalf("generate key manager: %v", err)
	}
	client := newFakeClient(100)

	tests := []struct {
		name       string
		client     Client
		keyManager signer.KeyManager
		cfg        Config
		wantErr    error
	}{
		{name: "nil client", client: nil, keyManager: keyManager, cfg: Config{NetworkPassphrase: testnetPassphrase, MaxFee: 1000}, wantErr: ErrInvalidClient},
		{name: "nil signer", client: client, keyManager: nil, cfg: Config{NetworkPassphrase: testnetPassphrase, MaxFee: 1000}, wantErr: ErrInvalidSigner},
		{name: "missing passphrase", client: client, keyManager: keyManager, cfg: Config{MaxFee: 1000}, wantErr: ErrEmptyNetworkPassphrase},
		{name: "zero ceiling", client: client, keyManager: keyManager, cfg: Config{NetworkPassphrase: testnetPassphrase}, wantErr: ErrInvalidCeiling},
		{name: "low multiplier", client: client, keyManager: keyManager, cfg: Config{NetworkPassphrase: testnetPassphrase, MaxFee: 1000, FeeBumpMultiplier: 0.5}, wantErr: ErrInvalidMultiplier},
		{name: "high multiplier", client: client, keyManager: keyManager, cfg: Config{NetworkPassphrase: testnetPassphrase, MaxFee: 1000, FeeBumpMultiplier: 11}, wantErr: ErrInvalidMultiplier},
		{name: "huge confirmation window", client: client, keyManager: keyManager, cfg: Config{NetworkPassphrase: testnetPassphrase, MaxFee: 1000, ConfirmationWindow: 5_000_000}, wantErr: ErrInvalidConfirmationWindow},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			manager, err := NewFeeBumpManager(tt.client, tt.keyManager, tt.cfg)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("expected error %v, got %v", tt.wantErr, err)
			}
			if manager != nil {
				t.Fatal("expected no manager on validation failure")
			}
		})
	}

	manager, err := NewFeeBumpManager(client, keyManager, Config{NetworkPassphrase: testnetPassphrase, MaxFee: 1000})
	if err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	if got := manager.cfg.confirmationWindow; got != DefaultConfirmationWindow {
		t.Fatalf("confirmation window = %d, want %d", got, DefaultConfirmationWindow)
	}
	if got := manager.cfg.multiplier; got != DefaultFeeBumpMultiplier {
		t.Fatalf("multiplier = %v, want %v", got, DefaultFeeBumpMultiplier)
	}
	if got := manager.cfg.maxBumps; got != DefaultMaxBumps {
		t.Fatalf("max bumps = %d, want %d", got, DefaultMaxBumps)
	}
	if got := manager.cfg.baseFee; got != DefaultBaseFee {
		t.Fatalf("base fee = %d, want %d", got, DefaultBaseFee)
	}
	if got := manager.cfg.pollInterval; got != DefaultPollInterval {
		t.Fatalf("poll interval = %v, want %v", got, DefaultPollInterval)
	}
}

func TestTrackValidation(t *testing.T) {
	client := newFakeClient(100)
	manager := newTestManager(t, client, Config{})
	envelope := testInnerEnvelope(t, envelopeTypeTx)
	ctx := context.Background()

	tests := []struct {
		name    string
		pending PendingTransaction
		wantErr error
	}{
		{name: "short hash", pending: PendingTransaction{Hash: "abc", EnvelopeXDR: envelope, OperationCount: 1}, wantErr: ErrInvalidTransactionHash},
		{name: "non hex hash", pending: PendingTransaction{Hash: strings.Repeat("z", 64), EnvelopeXDR: envelope, OperationCount: 1}, wantErr: ErrInvalidTransactionHash},
		{name: "zero operations", pending: PendingTransaction{Hash: hashA, EnvelopeXDR: envelope}, wantErr: ErrInvalidOperationCount},
		{name: "empty envelope", pending: PendingTransaction{Hash: hashA, OperationCount: 1}, wantErr: ErrInvalidEnvelope},
		{name: "bad envelope", pending: PendingTransaction{Hash: hashA, EnvelopeXDR: "%%%", OperationCount: 1}, wantErr: ErrInvalidEnvelope},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := manager.Track(ctx, tt.pending); !errors.Is(err, tt.wantErr) {
				t.Fatalf("expected error %v, got %v", tt.wantErr, err)
			}
		})
	}
	if manager.PendingCount() != 0 {
		t.Fatalf("expected no tracked transactions, got %d", manager.PendingCount())
	}
}

func TestTrackResolvesLedgerAndDefaults(t *testing.T) {
	client := newFakeClient(500)
	manager := newTestManager(t, client, Config{BaseFee: 250, MaxFee: 9_000})
	envelope := testInnerEnvelope(t, envelopeTypeTx)

	tracked, err := manager.Track(context.Background(), PendingTransaction{
		Hash:           strings.ToUpper(hashA),
		EnvelopeXDR:    envelope,
		OperationCount: 1,
	})
	if err != nil {
		t.Fatalf("Track: %v", err)
	}
	if tracked.Hash != hashA {
		t.Fatalf("hash = %s, want %s", tracked.Hash, hashA)
	}
	if tracked.SubmittedLedger != 500 {
		t.Fatalf("submitted ledger = %d, want 500", tracked.SubmittedLedger)
	}
	if tracked.PerOperationFee != 250 {
		t.Fatalf("per-operation fee = %d, want 250", tracked.PerOperationFee)
	}
	if tracked.MaxFee != 9_000 {
		t.Fatalf("max fee = %d, want 9000", tracked.MaxFee)
	}

	// Tracking the same envelope again is idempotent.
	again, err := manager.Track(context.Background(), PendingTransaction{
		Hash:           hashA,
		EnvelopeXDR:    envelope,
		OperationCount: 1,
	})
	if err != nil {
		t.Fatalf("idempotent Track: %v", err)
	}
	if again.Bumps != 0 || manager.PendingCount() != 1 {
		t.Fatal("expected exactly one tracked transaction after duplicate Track")
	}

	// A different envelope under the same hash is rejected.
	other := base64.StdEncoding.EncodeToString(append(mustDecode(t, envelope), 0x01))
	if _, err := manager.Track(context.Background(), PendingTransaction{
		Hash:           hashA,
		EnvelopeXDR:    other,
		OperationCount: 1,
	}); !errors.Is(err, ErrAlreadyTracked) {
		t.Fatalf("expected ErrAlreadyTracked, got %v", err)
	}
}

func mustDecode(t *testing.T, value string) []byte {
	t.Helper()
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	return decoded
}

func TestTrackRequiresLedgerLookup(t *testing.T) {
	client := newFakeClient(100)
	client.latestErr = errors.New("rpc down")
	manager := newTestManager(t, client, Config{})

	if _, err := manager.Track(context.Background(), PendingTransaction{
		Hash:           hashA,
		EnvelopeXDR:    testInnerEnvelope(t, envelopeTypeTx),
		OperationCount: 1,
	}); err == nil {
		t.Fatal("expected Track to fail when the latest ledger cannot be read")
	}
	if manager.PendingCount() != 0 {
		t.Fatal("expected no transaction to be tracked after a ledger lookup failure")
	}
}

func TestCheckPendingAwaitingConfirmation(t *testing.T) {
	client := newFakeClient(102)
	manager := newTestManager(t, client, Config{})
	tracked, err := manager.Track(context.Background(), PendingTransaction{
		Hash:            hashA,
		EnvelopeXDR:     testInnerEnvelope(t, envelopeTypeTx),
		OperationCount:  1,
		PerOperationFee: 100,
		SubmittedLedger: 100,
	})
	if err != nil {
		t.Fatalf("Track: %v", err)
	}

	// Two ledgers is inside the three-ledger confirmation window.
	outcomes, err := manager.CheckPending(context.Background())
	if err != nil {
		t.Fatalf("CheckPending: %v", err)
	}
	if len(outcomes) != 1 || outcomes[0].Action != ActionAwaitingConfirmation {
		t.Fatalf("outcome = %+v, want awaiting_confirmation", outcomes)
	}
	if outcomes[0].LedgersElapsed != 2 {
		t.Fatalf("ledgers elapsed = %d, want 2", outcomes[0].LedgersElapsed)
	}
	if client.sentCount() != 0 {
		t.Fatal("no fee bump should be submitted inside the confirmation window")
	}
	if manager.PendingCount() != 1 {
		t.Fatal("transaction should remain tracked")
	}
	if tracked.PerOperationFee != 100 {
		t.Fatal("snapshot of tracked transaction should be unaffected")
	}
}

func TestCheckPendingBumpsAtOnePointFiveX(t *testing.T) {
	client := newFakeClient(103)
	client.sendResult = SendResult{Hash: hashB, Status: SendPending}
	manager := newTestManager(t, client, Config{MaxFee: 10_000})
	if _, err := manager.Track(context.Background(), PendingTransaction{
		Hash:            hashA,
		EnvelopeXDR:     testInnerEnvelope(t, envelopeTypeTx),
		OperationCount:  2,
		PerOperationFee: 100,
		SubmittedLedger: 100,
	}); err != nil {
		t.Fatalf("Track: %v", err)
	}

	outcomes, err := manager.CheckPending(context.Background())
	if err != nil {
		t.Fatalf("CheckPending: %v", err)
	}
	if len(outcomes) != 1 || outcomes[0].Action != ActionBumped {
		t.Fatalf("outcome = %+v, want bumped", outcomes)
	}
	if outcomes[0].BumpedHash != hashB {
		t.Fatalf("bumped hash = %s, want %s", outcomes[0].BumpedHash, hashB)
	}
	if outcomes[0].PerOperationFee != 150 {
		t.Fatalf("per-operation fee = %d, want 150 (1.5x)", outcomes[0].PerOperationFee)
	}
	if outcomes[0].TotalFee != 300 {
		t.Fatalf("total fee = %d, want 300 (150 x 2 operations)", outcomes[0].TotalFee)
	}

	if client.sentCount() != 1 {
		t.Fatalf("expected exactly one submitted fee bump, got %d", client.sentCount())
	}
	raw := mustDecode(t, client.sentEnvelopes[0])
	if got := int32(binary.BigEndian.Uint32(raw[:4])); got != envelopeTypeTxFeeBump {
		t.Fatalf("submitted envelope type = %d, want %d", got, envelopeTypeTxFeeBump)
	}
	if got := feeOfFeeBumpBody(raw[4:]); got != 300 {
		t.Fatalf("submitted fee = %d, want 300", got)
	}

	// The bumped hash replaces the original and resets the confirmation window.
	pending := manager.Pending()
	if len(pending) != 1 || pending[0].Hash != hashB {
		t.Fatalf("pending = %+v, want single entry keyed by %s", pending, hashB)
	}
	if pending[0].Bumps != 1 || pending[0].PerOperationFee != 150 {
		t.Fatalf("bumped record = %+v, want bumps=1 fee=150", pending[0])
	}
	if pending[0].SubmittedLedger != 103 {
		t.Fatalf("submitted ledger = %d, want 103", pending[0].SubmittedLedger)
	}

	// A second bump escalates from 150 to 225 (ceil of 150 x 1.5).
	client.mu.Lock()
	client.latest = 106
	client.sendResult = SendResult{Hash: hashC, Status: SendPending}
	client.mu.Unlock()

	outcomes, err = manager.CheckPending(context.Background())
	if err != nil {
		t.Fatalf("second CheckPending: %v", err)
	}
	if len(outcomes) != 1 || outcomes[0].Action != ActionBumped {
		t.Fatalf("second outcome = %+v, want bumped", outcomes)
	}
	if outcomes[0].PerOperationFee != 225 {
		t.Fatalf("second per-operation fee = %d, want 225", outcomes[0].PerOperationFee)
	}
	if outcomes[0].TotalFee != 450 {
		t.Fatalf("second total fee = %d, want 450", outcomes[0].TotalFee)
	}
}

func TestCheckPendingRefusesToExceedCeiling(t *testing.T) {
	client := newFakeClient(103)
	manager := newTestManager(t, client, Config{MaxFee: 250})
	if _, err := manager.Track(context.Background(), PendingTransaction{
		Hash:            hashA,
		EnvelopeXDR:     testInnerEnvelope(t, envelopeTypeTx),
		OperationCount:  2,
		PerOperationFee: 100,
		SubmittedLedger: 100,
	}); err != nil {
		t.Fatalf("Track: %v", err)
	}

	outcomes, err := manager.CheckPending(context.Background())
	if err != nil {
		t.Fatalf("CheckPending: %v", err)
	}
	if len(outcomes) != 1 || outcomes[0].Action != ActionCeilingReached {
		t.Fatalf("outcome = %+v, want fee_ceiling_reached", outcomes)
	}
	if !errors.Is(outcomes[0].Err, ErrFeeCeilingReached) {
		t.Fatalf("expected ErrFeeCeilingReached, got %v", outcomes[0].Err)
	}
	if client.sentCount() != 0 {
		t.Fatal("no fee bump may be submitted above the ceiling")
	}

	pending := manager.Pending()
	if len(pending) != 1 {
		t.Fatalf("expected the transaction to stay tracked, got %d entries", len(pending))
	}
	if !pending[0].Exhausted {
		t.Fatal("expected the transaction to be flagged exhausted")
	}

	// Subsequent evaluations report the ceiling without submitting anything.
	client.mu.Lock()
	client.latest = 200
	client.mu.Unlock()
	outcomes, err = manager.CheckPending(context.Background())
	if err != nil {
		t.Fatalf("second CheckPending: %v", err)
	}
	if outcomes[0].Action != ActionCeilingReached || !errors.Is(outcomes[0].Err, ErrFeeCeilingReached) {
		t.Fatalf("second outcome = %+v, want fee_ceiling_reached", outcomes[0])
	}
	if client.sentCount() != 0 {
		t.Fatal("no fee bump may be submitted once exhausted")
	}
}

func TestCheckPendingStopsAtMaxBumps(t *testing.T) {
	client := newFakeClient(103)
	client.sendResult = SendResult{Hash: hashB, Status: SendPending}
	manager := newTestManager(t, client, Config{MaxFee: 1_000_000, MaxBumps: 1})
	if _, err := manager.Track(context.Background(), PendingTransaction{
		Hash:            hashA,
		EnvelopeXDR:     testInnerEnvelope(t, envelopeTypeTx),
		OperationCount:  1,
		PerOperationFee: 100,
		SubmittedLedger: 100,
	}); err != nil {
		t.Fatalf("Track: %v", err)
	}

	if _, err := manager.CheckPending(context.Background()); err != nil {
		t.Fatalf("first CheckPending: %v", err)
	}
	if client.sentCount() != 1 {
		t.Fatalf("expected one fee bump, got %d", client.sentCount())
	}

	client.mu.Lock()
	client.latest = 110
	client.mu.Unlock()

	outcomes, err := manager.CheckPending(context.Background())
	if err != nil {
		t.Fatalf("second CheckPending: %v", err)
	}
	if len(outcomes) != 1 || outcomes[0].Action != ActionCeilingReached {
		t.Fatalf("outcome = %+v, want fee_ceiling_reached", outcomes)
	}
	if !errors.Is(outcomes[0].Err, ErrMaxBumpsReached) {
		t.Fatalf("expected ErrMaxBumpsReached, got %v", outcomes[0].Err)
	}
	if client.sentCount() != 1 {
		t.Fatal("no further fee bump may be submitted after the bump limit")
	}
}

func TestCheckPendingResolvesTerminalStates(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		client := newFakeClient(110)
		client.statuses[hashA] = TransactionStatus{Hash: hashA, Status: InclusionSuccess, Ledger: 109}
		manager := newTestManager(t, client, Config{})
		if _, err := manager.Track(context.Background(), PendingTransaction{
			Hash:            hashA,
			EnvelopeXDR:     testInnerEnvelope(t, envelopeTypeTx),
			OperationCount:  1,
			PerOperationFee: 100,
			SubmittedLedger: 100,
		}); err != nil {
			t.Fatalf("Track: %v", err)
		}

		outcomes, err := manager.CheckPending(context.Background())
		if err != nil {
			t.Fatalf("CheckPending: %v", err)
		}
		if len(outcomes) != 1 || outcomes[0].Action != ActionConfirmed {
			t.Fatalf("outcome = %+v, want confirmed", outcomes)
		}
		if outcomes[0].Ledger != 109 {
			t.Fatalf("ledger = %d, want 109", outcomes[0].Ledger)
		}
		if manager.PendingCount() != 0 {
			t.Fatal("confirmed transaction should no longer be tracked")
		}
	})

	t.Run("failed", func(t *testing.T) {
		client := newFakeClient(110)
		client.statuses[hashA] = TransactionStatus{Hash: hashA, Status: InclusionFailed, Ledger: 109}
		manager := newTestManager(t, client, Config{})
		if _, err := manager.Track(context.Background(), PendingTransaction{
			Hash:            hashA,
			EnvelopeXDR:     testInnerEnvelope(t, envelopeTypeTx),
			OperationCount:  1,
			SubmittedLedger: 100,
		}); err != nil {
			t.Fatalf("Track: %v", err)
		}

		outcomes, err := manager.CheckPending(context.Background())
		if err != nil {
			t.Fatalf("CheckPending: %v", err)
		}
		if len(outcomes) != 1 || outcomes[0].Action != ActionFailed {
			t.Fatalf("outcome = %+v, want failed", outcomes)
		}
		if manager.PendingCount() != 0 {
			t.Fatal("failed transaction should no longer be tracked")
		}
	})
}

func TestCheckPendingSubmissionFailures(t *testing.T) {
	t.Run("rejected", func(t *testing.T) {
		client := newFakeClient(103)
		client.sendResult = SendResult{Status: SendError, ErrorResultXDR: "AAAA"}
		manager := newTestManager(t, client, Config{})
		if _, err := manager.Track(context.Background(), PendingTransaction{
			Hash:            hashA,
			EnvelopeXDR:     testInnerEnvelope(t, envelopeTypeTx),
			OperationCount:  1,
			SubmittedLedger: 100,
		}); err != nil {
			t.Fatalf("Track: %v", err)
		}

		outcomes, err := manager.CheckPending(context.Background())
		if err != nil {
			t.Fatalf("CheckPending: %v", err)
		}
		if len(outcomes) != 1 || outcomes[0].Action != ActionRejected {
			t.Fatalf("outcome = %+v, want rejected", outcomes)
		}
		if !errors.Is(outcomes[0].Err, ErrTransactionRejected) {
			t.Fatalf("expected ErrTransactionRejected, got %v", outcomes[0].Err)
		}
		if manager.PendingCount() != 0 {
			t.Fatal("a rejected fee bump should stop being tracked")
		}
	})

	t.Run("try again later", func(t *testing.T) {
		client := newFakeClient(103)
		client.sendResult = SendResult{Status: SendTryAgainLater}
		manager := newTestManager(t, client, Config{})
		if _, err := manager.Track(context.Background(), PendingTransaction{
			Hash:            hashA,
			EnvelopeXDR:     testInnerEnvelope(t, envelopeTypeTx),
			OperationCount:  1,
			SubmittedLedger: 100,
		}); err != nil {
			t.Fatalf("Track: %v", err)
		}

		outcomes, err := manager.CheckPending(context.Background())
		if err != nil {
			t.Fatalf("CheckPending: %v", err)
		}
		if len(outcomes) != 1 || outcomes[0].Action != ActionRetryLater {
			t.Fatalf("outcome = %+v, want retry_later", outcomes)
		}
		if manager.PendingCount() != 1 {
			t.Fatal("a retryable submission should stay tracked")
		}
		pending := manager.Pending()
		if pending[0].Hash != hashA || pending[0].Bumps != 0 {
			t.Fatalf("pending = %+v, want unchanged entry", pending[0])
		}
	})

	t.Run("duplicate counts as bumped", func(t *testing.T) {
		client := newFakeClient(103)
		client.sendResult = SendResult{Hash: hashB, Status: SendDuplicate}
		manager := newTestManager(t, client, Config{})
		if _, err := manager.Track(context.Background(), PendingTransaction{
			Hash:            hashA,
			EnvelopeXDR:     testInnerEnvelope(t, envelopeTypeTx),
			OperationCount:  1,
			SubmittedLedger: 100,
		}); err != nil {
			t.Fatalf("Track: %v", err)
		}

		outcomes, err := manager.CheckPending(context.Background())
		if err != nil {
			t.Fatalf("CheckPending: %v", err)
		}
		if len(outcomes) != 1 || outcomes[0].Action != ActionBumped {
			t.Fatalf("outcome = %+v, want bumped", outcomes)
		}
		pending := manager.Pending()
		if len(pending) != 1 || pending[0].Hash != hashB {
			t.Fatalf("pending = %+v, want entry keyed by %s", pending, hashB)
		}
	})

	t.Run("transport error keeps transaction tracked", func(t *testing.T) {
		client := newFakeClient(103)
		client.sendErr = errors.New("connection reset")
		manager := newTestManager(t, client, Config{})
		if _, err := manager.Track(context.Background(), PendingTransaction{
			Hash:            hashA,
			EnvelopeXDR:     testInnerEnvelope(t, envelopeTypeTx),
			OperationCount:  1,
			SubmittedLedger: 100,
		}); err != nil {
			t.Fatalf("Track: %v", err)
		}

		outcomes, err := manager.CheckPending(context.Background())
		if err == nil {
			t.Fatal("expected an aggregated transport error")
		}
		if len(outcomes) != 1 || outcomes[0].Action != ActionError {
			t.Fatalf("outcome = %+v, want error", outcomes)
		}
		if manager.PendingCount() != 1 {
			t.Fatal("a transport failure should keep the transaction tracked")
		}
	})
}

func TestCheckPendingStatusLookupError(t *testing.T) {
	client := newFakeClient(103)
	client.statusErr = errors.New("rpc timeout")
	manager := newTestManager(t, client, Config{})
	if _, err := manager.Track(context.Background(), PendingTransaction{
		Hash:            hashA,
		EnvelopeXDR:     testInnerEnvelope(t, envelopeTypeTx),
		OperationCount:  1,
		SubmittedLedger: 100,
	}); err != nil {
		t.Fatalf("Track: %v", err)
	}

	outcomes, err := manager.CheckPending(context.Background())
	if err == nil {
		t.Fatal("expected an error from the status lookup")
	}
	if len(outcomes) != 1 || outcomes[0].Action != ActionError {
		t.Fatalf("outcome = %+v, want error", outcomes)
	}
	if manager.PendingCount() != 1 {
		t.Fatal("transaction should remain tracked after a status lookup error")
	}
}

func TestUntrackAndClose(t *testing.T) {
	client := newFakeClient(100)
	manager := newTestManager(t, client, Config{})
	if _, err := manager.Track(context.Background(), PendingTransaction{
		Hash:            hashA,
		EnvelopeXDR:     testInnerEnvelope(t, envelopeTypeTx),
		OperationCount:  1,
		SubmittedLedger: 100,
	}); err != nil {
		t.Fatalf("Track: %v", err)
	}

	if err := manager.Untrack(hashA); err != nil {
		t.Fatalf("Untrack: %v", err)
	}
	if err := manager.Untrack(hashA); !errors.Is(err, ErrUnknownTransaction) {
		t.Fatalf("expected ErrUnknownTransaction, got %v", err)
	}
	if manager.PendingCount() != 0 {
		t.Fatal("expected no tracked transactions after Untrack")
	}

	if _, err := manager.Track(context.Background(), PendingTransaction{
		Hash:            hashB,
		EnvelopeXDR:     testInnerEnvelope(t, envelopeTypeTx),
		OperationCount:  1,
		SubmittedLedger: 100,
	}); err != nil {
		t.Fatalf("Track before close: %v", err)
	}
	if err := manager.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := manager.Track(context.Background(), PendingTransaction{
		Hash:           hashC,
		EnvelopeXDR:    testInnerEnvelope(t, envelopeTypeTx),
		OperationCount: 1,
	}); !errors.Is(err, ErrManagerClosed) {
		t.Fatalf("expected ErrManagerClosed, got %v", err)
	}
	if _, err := manager.CheckPending(context.Background()); !errors.Is(err, ErrManagerClosed) {
		t.Fatalf("expected ErrManagerClosed from CheckPending, got %v", err)
	}
}

func TestCheckPendingConcurrentAccess(t *testing.T) {
	client := newFakeClient(103)
	client.sendResult = SendResult{Status: SendPending}
	manager := newTestManager(t, client, Config{MaxFee: 1_000_000})

	hashes := []string{hashA, hashB, hashC}
	for _, hash := range hashes {
		if _, err := manager.Track(context.Background(), PendingTransaction{
			Hash:            hash,
			EnvelopeXDR:     testInnerEnvelope(t, envelopeTypeTx),
			OperationCount:  1,
			SubmittedLedger: 100,
		}); err != nil {
			t.Fatalf("Track %s: %v", hash, err)
		}
	}

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 3; j++ {
				_, _ = manager.CheckPending(context.Background())
				_ = manager.Pending()
				_ = manager.PendingCount()
			}
		}()
	}
	wg.Wait()

	if manager.PendingCount() > len(hashes) {
		t.Fatalf("pending count grew to %d, want at most %d", manager.PendingCount(), len(hashes))
	}
}

func TestFeeMath(t *testing.T) {
	tests := []struct {
		current    uint32
		multiplier float64
		want       uint32
	}{
		{current: 100, multiplier: 1.5, want: 150},
		{current: 150, multiplier: 1.5, want: 225},
		{current: 225, multiplier: 1.5, want: 338},
		{current: 100, multiplier: 1.0, want: 101},
		{current: 0, multiplier: 1.5, want: 1},
	}
	for _, tt := range tests {
		if got := nextPerOperationFee(tt.current, tt.multiplier); got != tt.want {
			t.Errorf("nextPerOperationFee(%d, %v) = %d, want %d", tt.current, tt.multiplier, got, tt.want)
		}
	}

	if fee, over := totalFee(100, 3, 1000); over || fee != 300 {
		t.Fatalf("totalFee(100, 3, 1000) = (%d, %v), want (300, false)", fee, over)
	}
	if fee, over := totalFee(100, 3, 300); over || fee != 300 {
		t.Fatalf("totalFee at the ceiling = (%d, %v), want (300, false)", fee, over)
	}
	if fee, over := totalFee(100, 3, 299); !over || fee != 299 {
		t.Fatalf("totalFee over the ceiling = (%d, %v), want (299, true)", fee, over)
	}
	if _, over := totalFee(0, 1, 100); !over {
		t.Fatal("a zero per-operation fee must be treated as over the ceiling")
	}
	if fee, over := totalFee(1, 0, 100); over || fee != 1 {
		t.Fatalf("totalFee with zero operations = (%d, %v), want (1, false)", fee, over)
	}
}

func TestLedgersElapsed(t *testing.T) {
	tests := []struct {
		latest    uint32
		submitted uint32
		want      uint32
	}{
		{latest: 10, submitted: 7, want: 3},
		{latest: 7, submitted: 7, want: 0},
		{latest: 5, submitted: 7, want: 0},
	}
	for _, tt := range tests {
		if got := ledgersElapsed(tt.latest, tt.submitted); got != tt.want {
			t.Errorf("ledgersElapsed(%d, %d) = %d, want %d", tt.latest, tt.submitted, got, tt.want)
		}
	}
}
