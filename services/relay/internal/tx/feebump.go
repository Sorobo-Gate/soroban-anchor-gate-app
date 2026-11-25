// Package tx implements automated fee bumping for stuck Soroban
// transactions. The relay tracks the transactions it has submitted; when one
// is not included within a configurable number of ledgers the manager signs
// and submits a Stellar fee bump transaction that pays 1.5x the previous
// per-operation fee, never exceeding a hard ceiling that protects the relay
// account from fund depletion.
package tx

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/soroban-anchor-gate/relay/internal/signer"
)

// Defaults applied when a Config field is left at its zero value.
const (
	// DefaultConfirmationWindow is the number of ledgers a transaction may stay
	// unconfirmed before the relay submits a fee bump.
	DefaultConfirmationWindow uint32 = 3
	// DefaultFeeBumpMultiplier is the per-operation fee escalation factor.
	DefaultFeeBumpMultiplier = 1.5
	// DefaultBaseFee is the Stellar base fee, in stroops, for one operation.
	DefaultBaseFee uint32 = 100
	// DefaultMaxBumps caps how many fee bumps a single transaction may receive.
	DefaultMaxBumps uint32 = 5
	// DefaultPollInterval is how often Run evaluates tracked transactions.
	DefaultPollInterval = 5 * time.Second
	// maxFeeBumpMultiplier is the largest escalation factor the manager accepts,
	// preventing a misconfiguration from spending the fee ceiling in one bump.
	maxFeeBumpMultiplier = 10.0
	// maxConfirmationWindow bounds the confirmation window to a year of ledgers.
	maxConfirmationWindow uint32 = 1_000_000
)

// Errors returned by the fee bump manager.
var (
	// ErrManagerClosed is returned after Close has been called.
	ErrManagerClosed = errors.New("tx: fee bump manager is closed")
	// ErrInvalidClient is returned when no RPC client is configured.
	ErrInvalidClient = errors.New("tx: fee bump manager requires a Soroban RPC client")
	// ErrInvalidSigner is returned when no key manager is configured.
	ErrInvalidSigner = errors.New("tx: fee bump manager requires a signer key manager")
	// ErrInvalidCeiling is returned when no maximum fee is configured.
	ErrInvalidCeiling = errors.New("tx: fee bump ceiling must be greater than zero")
	// ErrInvalidMultiplier is returned for an out-of-range escalation factor.
	ErrInvalidMultiplier = fmt.Errorf("tx: fee bump multiplier must be between 1.0 and %.0f", maxFeeBumpMultiplier)
	// ErrInvalidConfirmationWindow is returned for an out-of-range window.
	ErrInvalidConfirmationWindow = errors.New("tx: confirmation window must be between 1 and 1000000 ledgers")
	// ErrInvalidTransactionHash is returned for a hash that is not 64 hex chars.
	ErrInvalidTransactionHash = errors.New("tx: transaction hash must be 64 lowercase hex characters")
	// ErrInvalidOperationCount is returned when a transaction has no operations.
	ErrInvalidOperationCount = errors.New("tx: transaction must contain at least one operation")
	// ErrInvalidEnvelope is returned when the tracked envelope is not a valid
	// base64 TransactionV1Envelope.
	ErrInvalidEnvelope = errors.New("tx: tracked envelope must be a base64 TransactionV1Envelope")
	// ErrAlreadyTracked is returned when a different transaction is already
	// tracked under the same hash.
	ErrAlreadyTracked = errors.New("tx: transaction hash is already tracked")
	// ErrUnknownTransaction is returned when untracking an unknown hash.
	ErrUnknownTransaction = errors.New("tx: transaction hash is not tracked")
	// ErrFeeCeilingReached is returned when the next bump would exceed the
	// configured maximum fee. The transaction stays tracked but is no longer
	// bumped, so funds are never spent past the ceiling.
	ErrFeeCeilingReached = errors.New("tx: fee bump ceiling reached, transaction left un-bumped")
	// ErrMaxBumpsReached is returned when a transaction has already received
	// the configured number of fee bumps.
	ErrMaxBumpsReached = errors.New("tx: maximum number of fee bumps reached")
	// ErrTransactionRejected is returned when Soroban RPC rejects the fee bump.
	ErrTransactionRejected = errors.New("tx: soroban rpc rejected the fee bump transaction")
)

// InclusionStatus is the network's view of a tracked transaction.
type InclusionStatus string

// Inclusion statuses reported by Soroban RPC getTransaction.
const (
	InclusionPending  InclusionStatus = "pending"
	InclusionSuccess  InclusionStatus = "success"
	InclusionFailed   InclusionStatus = "failed"
	InclusionNotFound InclusionStatus = "not_found"
)

// TransactionStatus is the result of looking up a transaction hash.
type TransactionStatus struct {
	// Hash is the transaction hash that was queried.
	Hash string
	// Status is the network inclusion status.
	Status InclusionStatus
	// Ledger is the ledger that included the transaction, when known.
	Ledger uint32
}

// SendStatus is the submission verdict returned by Soroban RPC.
type SendStatus string

// Submission statuses returned by Soroban RPC sendTransaction.
const (
	SendPending       SendStatus = "PENDING"
	SendDuplicate     SendStatus = "DUPLICATE"
	SendTryAgainLater SendStatus = "TRY_AGAIN_LATER"
	SendError         SendStatus = "ERROR"
)

// SendResult is the result of submitting a transaction envelope.
type SendResult struct {
	// Hash is the submitted transaction hash, when the node returns one.
	Hash string
	// Status is the submission verdict.
	Status SendStatus
	// ErrorResultXDR carries the transaction result XDR for SendError.
	ErrorResultXDR string
}

// Client is the Soroban RPC surface required for automated fee bumping.
// SorobanRPCClient is the production implementation; tests substitute fakes.
type Client interface {
	// GetLatestLedger returns the latest closed ledger sequence.
	GetLatestLedger(ctx context.Context) (uint32, error)
	// GetTransaction reports the inclusion status of a transaction hash.
	GetTransaction(ctx context.Context, hash string) (TransactionStatus, error)
	// SendTransaction submits a base64 transaction envelope.
	SendTransaction(ctx context.Context, envelopeXDR string) (SendResult, error)
}

// Config configures a FeeBumpManager. MaxFee and NetworkPassphrase are
// required; every other field falls back to its documented default.
type Config struct {
	// NetworkPassphrase is the Stellar network passphrase used to derive the
	// transaction hash that the fee source signs. Required.
	NetworkPassphrase string
	// MaxFee is the hard ceiling, in stroops, for the total fee paid by a fee
	// bump. Required and must be greater than zero.
	MaxFee uint32
	// BaseFee is the base fee, in stroops, of one operation. Defaults to 100.
	BaseFee uint32
	// FeeBumpMultiplier is the per-operation fee escalation factor. It must be
	// at least 1.0 and defaults to 1.5 (a 50% bump).
	FeeBumpMultiplier float64
	// ConfirmationWindow is the number of ledgers a transaction may stay
	// unconfirmed before it is bumped. Defaults to 3.
	ConfirmationWindow uint32
	// MaxBumps caps the number of fee bumps per transaction. Defaults to 5.
	MaxBumps uint32
	// PollInterval is the Run evaluation cadence. Defaults to 5s.
	PollInterval time.Duration
	// Logger receives operational messages. Defaults to slog.Default().
	Logger *slog.Logger
}

// PendingTransaction is a submitted transaction the manager is monitoring.
type PendingTransaction struct {
	// Hash is the transaction hash currently awaiting inclusion.
	Hash string
	// EnvelopeXDR is the base64 transaction envelope currently in flight. It is
	// the original envelope for the first bump and the latest fee bump envelope
	// afterwards.
	EnvelopeXDR string
	// InnerEnvelopeXDR is the base64 TransactionV1Envelope of the original
	// transaction. Every fee bump wraps this envelope, because a fee bump
	// envelope can never wrap another fee bump envelope. It defaults to
	// EnvelopeXDR when tracking a freshly submitted transaction.
	InnerEnvelopeXDR string
	// OperationCount is the number of operations in the inner transaction and
	// is used to translate per-operation fees into total fees.
	OperationCount uint32
	// PerOperationFee is the fee per operation, in stroops, paid by the current
	// envelope.
	PerOperationFee uint32
	// SubmittedLedger is the ledger at which the current envelope was
	// submitted. It is filled in from the RPC node when left at zero.
	SubmittedLedger uint32
	// MaxFee is the total fee ceiling, in stroops, resolved from Config.
	MaxFee uint32
	// Bumps is the number of fee bumps already submitted for this transaction.
	Bumps uint32
	// Exhausted reports that fee bumping stopped because the ceiling or bump
	// limit was reached. The transaction is still monitored for inclusion.
	Exhausted bool
	// LastBumpHash is the hash of the most recent fee bump envelope.
	LastBumpHash string
}

// Action classifies what CheckPending did with a transaction.
type Action string

// Actions reported by CheckPending.
const (
	// ActionAwaitingConfirmation means the transaction is still inside the
	// confirmation window and no fee bump was submitted.
	ActionAwaitingConfirmation Action = "awaiting_confirmation"
	// ActionConfirmed means the transaction was included successfully.
	ActionConfirmed Action = "confirmed"
	// ActionFailed means the transaction was included and failed on-chain.
	ActionFailed Action = "failed"
	// ActionBumped means a fee bump envelope was accepted by the network.
	ActionBumped Action = "bumped"
	// ActionCeilingReached means the fee bump ceiling or bump limit stopped
	// further bumps.
	ActionCeilingReached Action = "fee_ceiling_reached"
	// ActionRejected means Soroban RPC rejected the fee bump outright.
	ActionRejected Action = "rejected"
	// ActionRetryLater means the network asked the relay to try again later.
	ActionRetryLater Action = "retry_later"
	// ActionError means the status lookup or submission failed; the transaction
	// remains tracked and is retried on the next evaluation.
	ActionError Action = "error"
)

// Outcome is the result of evaluating one tracked transaction.
type Outcome struct {
	// Hash is the hash that was evaluated.
	Hash string
	// Action is the classification of the evaluation.
	Action Action
	// BumpedHash is the new transaction hash when Action is ActionBumped.
	BumpedHash string
	// PerOperationFee is the per-operation fee of the active envelope after the
	// evaluation.
	PerOperationFee uint32
	// TotalFee is the total fee, in stroops, of the active envelope.
	TotalFee uint32
	// LedgersElapsed is the number of ledgers since the active envelope was
	// submitted.
	LedgersElapsed uint32
	// Ledger is the inclusion ledger for confirmed or failed transactions.
	Ledger uint32
	// Err carries the reason for a ceiling, rejection, or transport outcome.
	Err error
}

// resolvedConfig is the validated manager configuration.
type resolvedConfig struct {
	networkPassphrase  string
	maxFee             uint32
	baseFee            uint32
	multiplier         float64
	confirmationWindow uint32
	maxBumps           uint32
	pollInterval       time.Duration
}

// FeeBumpManager monitors pending transactions and bumps their fees when they
// are slow to confirm. It is safe for concurrent use.
type FeeBumpManager struct {
	client Client
	signer signer.KeyManager
	cfg    resolvedConfig
	logger *slog.Logger

	mu      sync.Mutex
	pending map[string]*PendingTransaction
	closed  bool
}

// NewFeeBumpManager validates cfg and returns a manager. client and keyManager
// are required.
func NewFeeBumpManager(client Client, keyManager signer.KeyManager, cfg Config) (*FeeBumpManager, error) {
	if client == nil {
		return nil, ErrInvalidClient
	}
	if keyManager == nil {
		return nil, ErrInvalidSigner
	}
	if strings.TrimSpace(cfg.NetworkPassphrase) == "" {
		return nil, ErrEmptyNetworkPassphrase
	}
	if cfg.MaxFee == 0 {
		return nil, ErrInvalidCeiling
	}

	multiplier := cfg.FeeBumpMultiplier
	if multiplier == 0 {
		multiplier = DefaultFeeBumpMultiplier
	}
	if multiplier < 1.0 || multiplier > maxFeeBumpMultiplier {
		return nil, ErrInvalidMultiplier
	}

	window := cfg.ConfirmationWindow
	if window == 0 {
		window = DefaultConfirmationWindow
	}
	if window > maxConfirmationWindow {
		return nil, ErrInvalidConfirmationWindow
	}

	baseFee := cfg.BaseFee
	if baseFee == 0 {
		baseFee = DefaultBaseFee
	}

	maxBumps := cfg.MaxBumps
	if maxBumps == 0 {
		maxBumps = DefaultMaxBumps
	}

	pollInterval := cfg.PollInterval
	if pollInterval <= 0 {
		pollInterval = DefaultPollInterval
	}

	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}

	return &FeeBumpManager{
		client: client,
		signer: keyManager,
		cfg: resolvedConfig{
			networkPassphrase:  cfg.NetworkPassphrase,
			maxFee:             cfg.MaxFee,
			baseFee:            baseFee,
			multiplier:         multiplier,
			confirmationWindow: window,
			maxBumps:           maxBumps,
			pollInterval:       pollInterval,
		},
		logger:  logger,
		pending: make(map[string]*PendingTransaction),
	}, nil
}

// Track starts monitoring a submitted transaction. SubmittedLedger and
// PerOperationFee are filled in from defaults when left at zero. Tracking the
// same hash twice with the same envelope is idempotent.
func (m *FeeBumpManager) Track(ctx context.Context, pending PendingTransaction) (PendingTransaction, error) {
	if err := validateHash(pending.Hash); err != nil {
		return PendingTransaction{}, err
	}
	if pending.OperationCount == 0 {
		return PendingTransaction{}, ErrInvalidOperationCount
	}
	if pending.EnvelopeXDR == "" {
		return PendingTransaction{}, ErrInvalidEnvelope
	}
	innerEnvelope := pending.InnerEnvelopeXDR
	if innerEnvelope == "" {
		innerEnvelope = pending.EnvelopeXDR
	}
	if _, err := decodeInnerEnvelope(innerEnvelope); err != nil {
		return PendingTransaction{}, fmt.Errorf("%w: %v", ErrInvalidEnvelope, err)
	}

	hash := strings.ToLower(pending.Hash)

	m.mu.Lock()
	closed := m.closed
	existing := m.pending[hash]
	m.mu.Unlock()
	if closed {
		return PendingTransaction{}, ErrManagerClosed
	}
	if existing != nil {
		if existing.EnvelopeXDR != pending.EnvelopeXDR {
			return PendingTransaction{}, ErrAlreadyTracked
		}
		return *existing, nil
	}

	perOpFee := pending.PerOperationFee
	if perOpFee == 0 {
		perOpFee = m.cfg.baseFee
	}

	submittedLedger := pending.SubmittedLedger
	if submittedLedger == 0 {
		latest, err := m.client.GetLatestLedger(ctx)
		if err != nil {
			return PendingTransaction{}, fmt.Errorf("tx: failed to resolve submission ledger for %s: %w", hash, err)
		}
		submittedLedger = latest
	}

	record := PendingTransaction{
		Hash:             hash,
		EnvelopeXDR:      pending.EnvelopeXDR,
		InnerEnvelopeXDR: innerEnvelope,
		OperationCount:   pending.OperationCount,
		PerOperationFee:  perOpFee,
		SubmittedLedger:  submittedLedger,
		MaxFee:           m.cfg.maxFee,
		Bumps:            0,
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return PendingTransaction{}, ErrManagerClosed
	}
	if current := m.pending[hash]; current != nil {
		if current.EnvelopeXDR != record.EnvelopeXDR {
			return PendingTransaction{}, ErrAlreadyTracked
		}
		return *current, nil
	}
	stored := record
	m.pending[hash] = &stored

	m.logger.Info("Tracking transaction for fee bump monitoring",
		"hash", hash,
		"submitted_ledger", submittedLedger,
		"per_operation_fee", perOpFee,
		"confirmation_window", m.cfg.confirmationWindow,
		"max_fee", m.cfg.maxFee,
	)
	return stored, nil
}

// Untrack stops monitoring a transaction by its current hash.
func (m *FeeBumpManager) Untrack(hash string) error {
	target := strings.ToLower(strings.TrimSpace(hash))

	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.pending[target]; !ok {
		return ErrUnknownTransaction
	}
	delete(m.pending, target)
	return nil
}

// Pending returns a snapshot of every tracked transaction, ordered by hash.
func (m *FeeBumpManager) Pending() []PendingTransaction {
	m.mu.Lock()
	defer m.mu.Unlock()

	records := make([]PendingTransaction, 0, len(m.pending))
	for _, record := range m.pending {
		records = append(records, *record)
	}
	sort.Slice(records, func(i, j int) bool { return records[i].Hash < records[j].Hash })
	return records
}

// PendingCount returns the number of tracked transactions.
func (m *FeeBumpManager) PendingCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.pending)
}

// Close stops accepting new transactions. Transactions already tracked remain
// inspectable.
func (m *FeeBumpManager) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	return nil
}

// Run evaluates tracked transactions every PollInterval until ctx is
// cancelled, returning the context error.
func (m *FeeBumpManager) Run(ctx context.Context) error {
	ticker := time.NewTicker(m.cfg.pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			outcomes, err := m.CheckPending(ctx)
			for _, outcome := range outcomes {
				m.logOutcome(outcome)
			}
			if err != nil {
				m.logger.Error("Fee bump evaluation completed with errors", "error", err)
			}
		}
	}
}

// CheckPending evaluates every tracked transaction once. Transactions whose
// status cannot be read remain tracked. The returned error aggregates transport
// failures; per-transaction decisions are reported through Outcome.Err.
func (m *FeeBumpManager) CheckPending(ctx context.Context) ([]Outcome, error) {
	m.mu.Lock()
	closed := m.closed
	hashes := make([]string, 0, len(m.pending))
	for hash := range m.pending {
		hashes = append(hashes, hash)
	}
	m.mu.Unlock()

	if closed {
		return nil, ErrManagerClosed
	}
	sort.Strings(hashes)

	outcomes := make([]Outcome, 0, len(hashes))
	var errs []error
	for _, hash := range hashes {
		outcome, err := m.reconcile(ctx, hash)
		outcomes = append(outcomes, outcome)
		if err != nil {
			errs = append(errs, err)
		}
	}
	return outcomes, errors.Join(errs...)
}

// reconcile evaluates one tracked transaction, bumping it when it has been
// unconfirmed for longer than the confirmation window.
func (m *FeeBumpManager) reconcile(ctx context.Context, hash string) (Outcome, error) {
	m.mu.Lock()
	entry := m.pending[hash]
	if entry == nil {
		m.mu.Unlock()
		return Outcome{Hash: hash, Action: ActionError, Err: ErrUnknownTransaction}, nil
	}
	snapshot := *entry
	m.mu.Unlock()

	status, err := m.client.GetTransaction(ctx, hash)
	if err != nil {
		outcome := Outcome{Hash: hash, Action: ActionError, PerOperationFee: snapshot.PerOperationFee, Err: err}
		return outcome, fmt.Errorf("tx: failed to read status of %s: %w", hash, err)
	}

	switch status.Status {
	case InclusionSuccess:
		m.remove(hash, &snapshot)
		totalFee, _ := totalFee(snapshot.PerOperationFee, snapshot.OperationCount, snapshot.MaxFee)
		return Outcome{
			Hash:            hash,
			Action:          ActionConfirmed,
			PerOperationFee: snapshot.PerOperationFee,
			TotalFee:        totalFee,
			Ledger:          status.Ledger,
		}, nil
	case InclusionFailed:
		m.remove(hash, &snapshot)
		totalFee, _ := totalFee(snapshot.PerOperationFee, snapshot.OperationCount, snapshot.MaxFee)
		return Outcome{
			Hash:            hash,
			Action:          ActionFailed,
			PerOperationFee: snapshot.PerOperationFee,
			TotalFee:        totalFee,
			Ledger:          status.Ledger,
		}, nil
	}

	latest, err := m.client.GetLatestLedger(ctx)
	if err != nil {
		outcome := Outcome{Hash: hash, Action: ActionError, PerOperationFee: snapshot.PerOperationFee, Err: err}
		return outcome, fmt.Errorf("tx: failed to read latest ledger for %s: %w", hash, err)
	}

	elapsed := ledgersElapsed(latest, snapshot.SubmittedLedger)
	active := Outcome{
		Hash:            hash,
		PerOperationFee: snapshot.PerOperationFee,
		LedgersElapsed:  elapsed,
	}
	activeTotalFee, _ := totalFee(snapshot.PerOperationFee, snapshot.OperationCount, snapshot.MaxFee)
	active.TotalFee = activeTotalFee

	if snapshot.Exhausted {
		active.Action = ActionCeilingReached
		active.Err = exhaustionReason(snapshot, m.cfg)
		return active, nil
	}

	if elapsed < m.cfg.confirmationWindow {
		active.Action = ActionAwaitingConfirmation
		return active, nil
	}

	if snapshot.Bumps >= m.cfg.maxBumps {
		m.markExhausted(hash, &snapshot)
		active.Action = ActionCeilingReached
		active.Err = ErrMaxBumpsReached
		return active, nil
	}

	nextPerOp := nextPerOperationFee(snapshot.PerOperationFee, m.cfg.multiplier)
	bumpFee, overCeiling := totalFee(nextPerOp, snapshot.OperationCount, snapshot.MaxFee)
	if overCeiling {
		m.markExhausted(hash, &snapshot)
		active.Action = ActionCeilingReached
		active.Err = ErrFeeCeilingReached
		m.logger.Warn("Refusing to fee bump: ceiling would be exceeded",
			"hash", hash,
			"next_per_operation_fee", nextPerOp,
			"operation_count", snapshot.OperationCount,
			"ceiling", snapshot.MaxFee,
		)
		return active, nil
	}

	bumped, err := m.submitBump(ctx, &snapshot, int64(bumpFee))
	if err != nil {
		active.Action = ActionError
		active.Err = err
		return active, err
	}

	return Outcome{
		Hash:            hash,
		Action:          bumped.Action,
		BumpedHash:      bumped.BumpedHash,
		PerOperationFee: bumped.PerOperationFee,
		TotalFee:        bumped.TotalFee,
		LedgersElapsed:  elapsed,
		Err:             bumped.Err,
	}, nil
}

// submitBump builds, signs and submits a fee bump for the snapshot. On success
// the tracked record is replaced by the new hash.
func (m *FeeBumpManager) submitBump(ctx context.Context, snapshot *PendingTransaction, fee int64) (Outcome, error) {
	publicKey, err := m.signer.PublicKey(ctx)
	if err != nil {
		return Outcome{}, fmt.Errorf("tx: failed to load fee source public key: %w", err)
	}
	if len(publicKey) != ed25519.PublicKeySize {
		return Outcome{}, ErrInvalidFeeSource
	}

	unsigned, err := BuildFeeBump(m.cfg.networkPassphrase, publicKey, fee, snapshot.InnerEnvelopeXDR)
	if err != nil {
		return Outcome{}, err
	}

	signature, err := m.signer.Sign(ctx, unsigned.Hash[:])
	if err != nil {
		return Outcome{}, fmt.Errorf("tx: failed to sign fee bump: %w", err)
	}

	envelope, err := unsigned.Sign(signature)
	if err != nil {
		return Outcome{}, err
	}

	sendResult, err := m.client.SendTransaction(ctx, envelope.EnvelopeXDR)
	if err != nil {
		return Outcome{}, fmt.Errorf("tx: failed to submit fee bump for %s: %w", snapshot.Hash, err)
	}

	switch sendResult.Status {
	case SendError:
		m.remove(snapshot.Hash, snapshot)
		return Outcome{
			Hash:   snapshot.Hash,
			Action: ActionRejected,
			Err:    fmt.Errorf("%w: result_xdr=%s", ErrTransactionRejected, sendResult.ErrorResultXDR),
		}, nil
	case SendTryAgainLater:
		return Outcome{
			Hash:   snapshot.Hash,
			Action: ActionRetryLater,
			Err:    errors.New("tx: soroban rpc asked the relay to retry the fee bump later"),
		}, nil
	}

	newHash := strings.ToLower(strings.TrimSpace(sendResult.Hash))
	if newHash == "" {
		newHash = envelope.Hash
	}
	if err := validateHash(newHash); err != nil {
		newHash = envelope.Hash
	}

	latest, err := m.client.GetLatestLedger(ctx)
	if err != nil {
		// The bump was accepted, so keep it tracked using the ledger the network
		// reported at submission time rather than dropping it.
		latest = snapshot.SubmittedLedger
	}

	nextPerOp := nextPerOperationFee(snapshot.PerOperationFee, m.cfg.multiplier)
	updated := PendingTransaction{
		Hash:             newHash,
		EnvelopeXDR:      envelope.EnvelopeXDR,
		InnerEnvelopeXDR: snapshot.InnerEnvelopeXDR,
		OperationCount:   snapshot.OperationCount,
		PerOperationFee:  nextPerOp,
		SubmittedLedger:  latest,
		MaxFee:           snapshot.MaxFee,
		Bumps:            snapshot.Bumps + 1,
		LastBumpHash:     envelope.Hash,
	}

	if err := m.replace(snapshot, updated); err != nil {
		return Outcome{}, err
	}

	total, _ := totalFee(nextPerOp, updated.OperationCount, updated.MaxFee)
	m.logger.Info("Submitted fee bump for unconfirmed transaction",
		"previous_hash", snapshot.Hash,
		"bumped_hash", newHash,
		"per_operation_fee", nextPerOp,
		"total_fee", total,
		"bumps", updated.Bumps,
		"send_status", string(sendResult.Status),
	)

	return Outcome{
		Hash:            snapshot.Hash,
		Action:          ActionBumped,
		BumpedHash:      newHash,
		PerOperationFee: nextPerOp,
		TotalFee:        total,
	}, nil
}

// replace atomically swaps a tracked record for its fee bumped successor, as
// long as no other goroutine modified it first.
func (m *FeeBumpManager) replace(previous *PendingTransaction, updated PendingTransaction) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	current := m.pending[previous.Hash]
	if current == nil || current.Bumps != previous.Bumps {
		return errors.New("tx: tracked transaction changed while submitting a fee bump")
	}
	delete(m.pending, previous.Hash)
	stored := updated
	m.pending[updated.Hash] = &stored
	return nil
}

// markExhausted flags the record so no further fee bumps are attempted.
func (m *FeeBumpManager) markExhausted(hash string, snapshot *PendingTransaction) {
	m.mu.Lock()
	defer m.mu.Unlock()
	current := m.pending[hash]
	if current == nil || current.Bumps != snapshot.Bumps {
		return
	}
	current.Exhausted = true
}

// remove stops tracking a record if it has not been superseded.
func (m *FeeBumpManager) remove(hash string, snapshot *PendingTransaction) {
	m.mu.Lock()
	defer m.mu.Unlock()
	current := m.pending[hash]
	if current == nil || current.Bumps != snapshot.Bumps {
		return
	}
	delete(m.pending, hash)
}

// logOutcome records the operational result of one evaluation.
func (m *FeeBumpManager) logOutcome(outcome Outcome) {
	switch outcome.Action {
	case ActionConfirmed, ActionFailed:
		m.logger.Info("Tracked transaction reached a terminal state",
			"hash", outcome.Hash,
			"action", string(outcome.Action),
			"ledger", outcome.Ledger,
			"total_fee", outcome.TotalFee,
		)
	case ActionCeilingReached:
		m.logger.Warn("Fee bumping stopped for transaction",
			"hash", outcome.Hash,
			"action", string(outcome.Action),
			"reason", outcome.Err,
		)
	case ActionRejected, ActionError, ActionRetryLater:
		m.logger.Error("Fee bump evaluation failed",
			"hash", outcome.Hash,
			"action", string(outcome.Action),
			"error", outcome.Err,
		)
	default:
		m.logger.Debug("Fee bump evaluation outcome",
			"hash", outcome.Hash,
			"action", string(outcome.Action),
			"ledgers_elapsed", outcome.LedgersElapsed,
		)
	}
}

// exhaustionReason reports why a record stopped being bumped.
func exhaustionReason(snapshot PendingTransaction, cfg resolvedConfig) error {
	if snapshot.Bumps >= cfg.maxBumps {
		return ErrMaxBumpsReached
	}
	return ErrFeeCeilingReached
}

// ledgersElapsed returns how many ledgers have closed since submitted.
func ledgersElapsed(latest, submitted uint32) uint32 {
	if latest <= submitted {
		return 0
	}
	return latest - submitted
}

// nextPerOperationFee escalates a per-operation fee by multiplier, rounding up
// and always making progress so repeated bumps cannot stall at the same fee.
func nextPerOperationFee(current uint32, multiplier float64) uint32 {
	if current == 0 {
		return 1
	}
	next := uint32(math.Ceil(float64(current) * multiplier))
	if next <= current {
		next = current + 1
	}
	if next == 0 {
		// Overflow guard: saturate rather than wrap around.
		return math.MaxUint32
	}
	return next
}

// totalFee multiplies a per-operation fee by the operation count and reports
// whether the result exceeds ceiling. Fractional stroops are never produced,
// and the calculation cannot overflow.
func totalFee(perOperationFee, operationCount, ceiling uint32) (uint32, bool) {
	if operationCount == 0 {
		operationCount = 1
	}
	if perOperationFee == 0 {
		return 0, true
	}
	total := uint64(perOperationFee) * uint64(operationCount)
	if total > uint64(ceiling) {
		return ceiling, true
	}
	return uint32(total), false
}

// validateHash checks that hash is a canonical 64-character transaction hash.
func validateHash(hash string) error {
	trimmed := strings.ToLower(strings.TrimSpace(hash))
	if len(trimmed) != 64 {
		return ErrInvalidTransactionHash
	}
	decoded, err := hex.DecodeString(trimmed)
	if err != nil || len(decoded) != 32 {
		return ErrInvalidTransactionHash
	}
	return nil
}
