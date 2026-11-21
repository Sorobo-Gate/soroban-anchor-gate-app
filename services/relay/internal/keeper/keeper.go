package keeper

import (
	"bytes"
	"encoding/binary"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"time"

	"github.com/soroban-anchor-gate/relay/internal/store"
	"github.com/soroban-anchor-gate/relay/internal/telemetry"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/trace"
	"log/slog"
)

// Keeper is an autonomous routine that periodically queries for expired escrows
// and submits claim_refund transactions to Soroban on behalf of beneficiaries.
type Keeper struct {
	rpcURL       string
	contractID   string
	eventStore   store.IdempotencyStore
	signer       Signer
	cycleInterval time.Duration
	maxSubmissionsPerCycle int
	logger       *slog.Logger
	metrics      *telemetry.Metrics
	tracer       trace.Tracer
	shutdown     chan struct{}
}

// Signer defines the interface for signing Soroban transactions.
type Signer interface {
	Sign(ctx context.Context, message []byte) ([]byte, error)
	PublicKey(ctx context.Context) ([]byte, error)
}

// EscrowState represents the onchain escrow state tracked by the keeper.
type EscrowState struct {
	EventID      string
	EscrowID     uint64
	ProfileHash  string
	PayoutAmount *big.Int
	Beneficiary  string
	UnlockTime   int64
	Status       string
	Ledger       uint32
}

// NewKeeper creates a new Keeper instance.
func NewKeeper(rpcURL, contractID string, eventStore store.IdempotencyStore, signer Signer, options ...KeeperOption) *Keeper {
	k := &Keeper{
		rpcURL:          rpcURL,
		contractID:      contractID,
		eventStore:      eventStore,
		signer:          signer,
		cycleInterval:   30 * time.Second,
		maxSubmissionsPerCycle: 5,
		shutdown:        make(chan struct{}),
		logger:          slog.New(slog.NewJSONHandler(os.Stderr, nil)),
		metrics:         telemetry.NewMetrics(),
		tracer:          otel.Tracer("soroban-anchor-gate/keeper"),
	}

	for _, opt := range options {
		opt(k)
	}

	return k
}

// KeeperOption configures a Keeper instance.
type KeeperOption func(*Keeper)

func WithCycleInterval(d time.Duration) KeeperOption {
	return func(k *Keeper) { k.cycleInterval = d }
}
func WithMaxSubmissionsPerCycle(n int) KeeperOption {
	return func(k *Keeper) { k.maxSubmissionsPerCycle = n }
}
func WithLogger(l *slog.Logger) KeeperOption {
	return func(k *Keeper) { k.logger = l }
}
func WithMetrics(m *telemetry.Metrics) KeeperOption {
	return func(k *Keeper) { k.metrics = m }
}

// Start begins the keeper main loop.
func (k *Keeper) Start(ctx context.Context) {
	defer close(k.shutdown)
	ticker := time.NewTicker(k.cycleInterval)
	defer ticker.Stop()
	k.logger.Info("Keeper starting", "interval", k.cycleInterval)

	for {
		select {
		case <-ctx.Done():
			k.logger.Info("Keeper shutting down")
			return
		case <-k.shutdown:
			return
		case <-ticker.C:
			if err := k.Cycle(ctx); err != nil {
				k.logger.Error("Keeper cycle failed", "error", err)
				k.metrics.RecordRPCError("keeper_cycle_failure")
			}
		}
	}
}

// Cycle performs one keeper cycle.
func (k *Keeper) Cycle(ctx context.Context) error {
	ctx, span := k.tracer.Start(ctx, "keeper.cycle")
	defer span.End()

	k.logger.Info("Starting keeper cycle")
	expired, err := k.queryExpiredEscrows(ctx)
	if err != nil {
		k.logger.Error("Failed to query expired escrows", "error", err)
		return err
	}
	k.logger.Info("Found expired escrows", "count", len(expired))

	successCount := 0
	failureCount := 0
	for i, escrow := range expired {
		if i >= k.maxSubmissionsPerCycle {
			break
		}
		if err := k.claimRefund(ctx, &escrow); err != nil {
			failureCount++
			k.logger.Error("Failed claim refund", "escrow_id", escrow.EscrowID, "error", err)
			k.metrics.RecordRPCError("keeper_claim_refund_failure")
		} else {
			successCount++
			k.logger.Info("Successful claim refund", "escrow_id", escrow.EscrowID)
			k.metrics.RecordEscrowEvent("claim_refund_success")
		}
	}
	k.logger.Info("Keeper cycle complete", "found", len(expired), "successes", successCount, "failures", failureCount)
	return nil
}

func (k *Keeper) queryExpiredEscrows(ctx context.Context) ([]EscrowState, error) {
	var expired []EscrowState
	allEvents := k.eventStore.ListAll()
	now := time.Now().Unix()

	for _, event := range allEvents {
		if event.State != store.StateObserved {
			continue
		}
		// Decode event payload to get unlock time
		payload, err := decodeEventPayload(event.EventID)
		if err != nil {
			continue
		}
		if now > payload.UnlockTime {
			expired = append(expired, EscrowState{
				EventID:      event.EventID,
				EscrowID:     payload.EscrowID,
				ProfileHash:  payload.ProfileHashHex,
				PayoutAmount: payload.PayoutAmount,
				UnlockTime:   payload.UnlockTime,
				Status:       "FUNDED",
			})
		}
	}
	return expired, nil
}

func decodeEventPayload(eventID string) (*eventPayloadDetails, error) {
	return &eventPayloadDetails{
		UnlockTime: time.Now().Unix() - 86400, // 24 hours ago as placeholder
	}, nil
}

type eventPayloadDetails struct {
	UnlockTime   int64
	EscrowID     uint64
	ProfileHashHex string
	PayoutAmount *big.Int
}

// claimRefund constructs, signs, and submits a claim_refund transaction for the given escrow.
func (k *Keeper) claimRefund(ctx context.Context, escrow *EscrowState) error {
	ctx, span := k.tracer.Start(ctx, "claimer.claim_refund")
	defer span.End()

	latestLedger, err := k.getLatestLedger(ctx)
	if err != nil {
		return fmt.Errorf("failed to get latest ledger: %w", err)
	}

	txXDR, err := k.buildClaimRefundTransaction(escrow, latestLedger)
	if err != nil {
		return fmt.Errorf("failed to build transaction: %w", err)
	}

	signature, err := k.signer.Sign(ctx, []byte(txXDR))
	if err != nil {
		return fmt.Errorf("failed to sign transaction: %w", err)
	}

	hash, err := k.submitTransaction(ctx, txXDR, signature)
	if err != nil {
		return fmt.Errorf("failed to submit transaction: %w", err)
	}

	if err := k.eventStore.ClaimForProcessing(escrow.EventID); err != nil {
		k.logger.Warn("Event already claimed", "event_id", escrow.EventID)
	}
	k.logger.Info("Claim refund submitted", "tx_hash", hash, "escrow_id", escrow.EscrowID)
	return nil
}

// getLatestLedger returns the latest ledger sequence from the Soroban RPC.
func (k *Keeper) getLatestLedger(ctx context.Context) (uint32, error) {
	reqBody := struct {
		JSONRPC string `json:"jsonrpc"`
		ID      int    `json:"id"`
		Method  string `json:"method"`
	}{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "getLatestLedger",
	}
	jsonBytes, err := json.Marshal(reqBody)
	if err != nil {
		return 0, fmt.Errorf("marshal error: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, "POST", k.rpcURL, bytes.NewReader(jsonBytes))
	if err != nil {
		return 0, fmt.Errorf("create request error: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("RPC HTTP error: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, fmt.Errorf("read body error: %w", err)
	}
	var result struct {
		Result struct {
			Sequence uint32 `json:"sequence"`
		} `json:"result"`
		Error *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error,omitempty"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return 0, fmt.Errorf("unmarshal error: %w", err)
	}
	if result.Error != nil {
		return 0, fmt.Errorf("RPC error: %d: %s", result.Error.Code, result.Error.Message)
	}
	return result.Result.Sequence, nil
}

// buildClaimRefundTransaction builds a claim_refund transaction XDR for the given escrow.
func (k *Keeper) buildClaimRefundTransaction(escrow *EscrowState, latestLedger uint32) (string, error) {
	// Build minimal XDR for claim_refund with escrow_id
	// escrow_id as big-endian u64 (8 bytes)
	escrowIDBytes := make([]byte, 8)
	binary.BigEndian.PutUint64(escrowIDBytes, escrow.EscrowID)

	// ScvU64: discriminator 5 + 8 bytes
	// ScvVec wrapper with 1 element: discriminator 16 + 4-byte length + 1 element
	vecDisc := []byte{0x10, 0x00, 0x00, 0x00} // ScvVec discriminator
	vecLen := []byte{0x00, 0x00, 0x00, 0x01}   // 1 element
	elemDisc := []byte{0x05, 0x00, 0x00, 0x00} // ScvU64 discriminator

	innerVec := append(vecDisc, vecLen...)
	innerVec = append(innerVec, elemDisc...)
	innerVec = append(innerVec, escrowIDBytes...)

	outerVec := append(vecDisc, vecLen...)
	outerVec = append(outerVec, 0x01) // num elements
	outerVec = append(outerVec, innerVec...)

	// Minimal XDR: version "AAAA" + operations vector
	xdr := "AAAA" + string(outerVec)

	return xdr, nil
}

// submitTransaction submits a signed transaction to the Soroban network.
func (k *Keeper) submitTransaction(ctx context.Context, txXDR string, signature []byte) (string, error) {
	reqBody := map[string]string{"transaction": txXDR}
	jsonBytes, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("marshal error: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, "POST", k.rpcURL+"/transactions", bytes.NewReader(jsonBytes))
	if err != nil {
		return "", fmt.Errorf("create request error: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("RPC HTTP submit error: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read submit body error: %w", err)
	}
	var result struct {
		Hash string `json:"hash"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return "", fmt.Errorf("unmarshal submit response error: %w", err)
	}
	return result.Hash, nil
}