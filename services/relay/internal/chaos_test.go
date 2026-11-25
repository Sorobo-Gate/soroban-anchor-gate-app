package relay_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/soroban-anchor-gate/relay/internal/listener"
	"github.com/soroban-anchor-gate/relay/internal/store"
	"github.com/soroban-anchor-gate/relay/internal/worker"
)

// This file implements the relay's end-to-end chaos engineering suite. Every
// scenario drives the real listener, idempotency store, transactional outbox
// and outbox worker against fault-injecting fakes:
//
//   - Soroban RPC returns HTTP 503 for a configurable share of calls and
//     injects 500ms latency into the response path.
//   - The anchor payout endpoint fails transiently, forcing outbox retries.
//   - The RPC event stream contains corrupted event payloads.
//
// The assertions encode the relay's durability contract: no disbursed event is
// dropped, no payout is submitted twice, and the pipeline recovers within the
// documented recovery time objective (RTO) in docs/relay.md.

const (
	chaosContractID = "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT"

	// chaosTopicDisbursed is Symbol("disbursed") encoded as an ScVal.
	chaosTopicDisbursed = "AAAADwAAAAlkaXNidXJzZWQAAAA="

	// chaosRTOObjective mirrors the RTO table published in docs/relay.md. A
	// relay that cannot resume normal processing within this window after the
	// last injected fault fails the suite.
	chaosRTOObjective = 30 * time.Second

	chaosStartLedger = uint32(5_000_000)
)

func chaosLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// chaosEscrowTopic encodes an escrow ID as an ScvU64 topic value.
func chaosEscrowTopic(escrowID uint64) string {
	var payload [12]byte
	binary.BigEndian.PutUint32(payload[0:4], 5) // ScvU64
	binary.BigEndian.PutUint64(payload[4:12], escrowID)
	return base64.StdEncoding.EncodeToString(payload[:])
}

// chaosValueXDR encodes the (profile_hash: BytesN<32>, payout_amount: i128)
// tuple emitted by the escrow contract.
func chaosValueXDR(amount int64) string {
	profileHash := make([]byte, 32)
	for i := range profileHash {
		profileHash[i] = byte(i + 1)
	}

	var buf bytes.Buffer
	writeUint32 := func(value uint32) {
		var encoded [4]byte
		binary.BigEndian.PutUint32(encoded[:], value)
		buf.Write(encoded[:])
	}

	writeUint32(16) // ScvVec
	writeUint32(1)  // vector present
	writeUint32(2)  // two elements
	writeUint32(13) // ScvBytes (profile hash)
	writeUint32(32)
	buf.Write(profileHash)
	writeUint32(10) // ScvI128 (payout amount)

	var amountBytes [16]byte
	binary.BigEndian.PutUint64(amountBytes[8:], uint64(amount))
	buf.Write(amountBytes[:])

	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

// buildChaosEvents produces one disbursed event per ledger plus optional
// corrupted events that the decoder must skip without stalling the pipeline.
func buildChaosEvents(goodEvents, corruptEvents int) ([]listener.EventItem, []string, []string) {
	items := make([]listener.EventItem, 0, goodEvents+corruptEvents)
	goodIDs := make([]string, 0, goodEvents)
	corruptIDs := make([]string, 0, corruptEvents)

	ledger := chaosStartLedger
	for i := 0; i < goodEvents; i++ {
		escrowID := uint64(9_000 + i)
		eventID := fmt.Sprintf("%010d-0000000001", ledger)
		items = append(items, listener.EventItem{
			ID:                       eventID,
			Type:                     "contract",
			Ledger:                   ledger,
			LedgerClosedAt:           time.Now().UTC().Format(time.RFC3339),
			ContractID:               chaosContractID,
			Topic:                    []string{chaosTopicDisbursed, chaosEscrowTopic(escrowID)},
			Value:                    listener.EventValue{XDR: chaosValueXDR(int64(1_000_000 + i))},
			InSuccessfulContractCall: true,
		})
		goodIDs = append(goodIDs, eventID)
		ledger++

		// Interleave corrupted events in the middle of the stream so they land
		// on the same pages as live events.
		if corruptEvents > 0 && i == goodEvents/2 {
			for j := 0; j < corruptEvents; j++ {
				corruptID := fmt.Sprintf("%010d-0000000002", ledger)
				items = append(items, listener.EventItem{
					ID:                       corruptID,
					Type:                     "contract",
					Ledger:                   ledger,
					LedgerClosedAt:           time.Now().UTC().Format(time.RFC3339),
					ContractID:               chaosContractID,
					Topic:                    []string{chaosTopicDisbursed, chaosEscrowTopic(escrowID)},
					Value:                    listener.EventValue{XDR: "AAAA"}, // truncated ScVal vector
					InSuccessfulContractCall: true,
				})
				corruptIDs = append(corruptIDs, corruptID)
				ledger++
			}
		}
	}

	return items, goodIDs, corruptIDs
}

type chaosOptions struct {
	events            int
	corruptEvents     int
	pageSize          int
	failureRate       float64
	anchorFailureRate float64
	latency           time.Duration
	seed              int64
}

// chaosRPC is a Soroban RPC endpoint that injects HTTP 503 failures and
// response latency while serving a fixed event stream page by page.
type chaosRPC struct {
	server *httptest.Server

	mu              sync.Mutex
	rng             *rand.Rand
	events          []listener.EventItem
	tip             uint32
	pageSize        int
	failureRate     float64
	latency         time.Duration
	faultsActive    bool
	requests        int
	injected503     int
	injectedLatency int
	lastFaultAt     time.Time
}

func newChaosRPC(t *testing.T, events []listener.EventItem, opts chaosOptions) *chaosRPC {
	t.Helper()

	pageSize := opts.pageSize
	if pageSize <= 0 {
		pageSize = 2
	}
	latency := opts.latency
	if latency <= 0 {
		latency = 500 * time.Millisecond
	}

	rpc := &chaosRPC{
		rng:          rand.New(rand.NewSource(opts.seed)),
		events:       events,
		pageSize:     pageSize,
		failureRate:  opts.failureRate,
		latency:      latency,
		faultsActive: true,
	}
	if len(events) > 0 {
		rpc.tip = events[len(events)-1].Ledger
	}

	rpc.server = httptest.NewServer(http.HandlerFunc(rpc.handle))
	t.Cleanup(rpc.server.Close)
	return rpc
}

func (r *chaosRPC) handle(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var request struct {
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	body, err := io.ReadAll(io.LimitReader(req.Body, 1<<20))
	if err != nil || json.Unmarshal(body, &request) != nil {
		http.Error(w, `{"jsonrpc":"2.0","error":{"code":-32700,"message":"parse error"}}`, http.StatusBadRequest)
		return
	}

	if r.injectFault(w) {
		return
	}

	switch request.Method {
	case "getLatestLedger":
		r.mu.Lock()
		sequence := r.tip
		r.mu.Unlock()
		writeJSONRPCResult(w, map[string]interface{}{"sequence": sequence})
	case "getEvents":
		var params struct {
			StartLedger uint32 `json:"startLedger"`
		}
		if err := json.Unmarshal(request.Params, &params); err != nil {
			http.Error(w, `{"jsonrpc":"2.0","error":{"code":-32602,"message":"invalid params"}}`, http.StatusBadRequest)
			return
		}
		r.serveEvents(w, params.StartLedger)
	default:
		http.Error(w, `{"jsonrpc":"2.0","error":{"code":-32601,"message":"method not found"}}`, http.StatusNotFound)
	}
}

// injectFault applies the configured chaos policy. It reports whether the
// request was answered with an injected failure.
func (r *chaosRPC) injectFault(w http.ResponseWriter) bool {
	r.mu.Lock()
	r.requests++
	active := r.faultsActive
	fail := active && r.rng.Float64() < r.failureRate
	delayed := active && r.requests%3 == 0
	if fail {
		r.injected503++
		r.lastFaultAt = time.Now()
	}
	if delayed {
		r.injectedLatency++
	}
	r.mu.Unlock()

	if delayed {
		time.Sleep(r.latency)
	}
	if fail {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"rpc temporarily unavailable"}}`))
		return true
	}
	return false
}

func (r *chaosRPC) serveEvents(w http.ResponseWriter, startLedger uint32) {
	r.mu.Lock()
	page := make([]listener.EventItem, 0, r.pageSize)
	for _, item := range r.events {
		if item.Ledger < startLedger {
			continue
		}
		page = append(page, item)
		if len(page) >= r.pageSize {
			break
		}
	}
	latest := r.tip
	if len(page) > 0 {
		// Advance the cursor only to what was actually delivered so a dropped
		// response can never skip a ledger.
		latest = page[len(page)-1].Ledger
	}
	r.mu.Unlock()

	writeJSONRPCResult(w, map[string]interface{}{
		"events":       page,
		"latestLedger": latest,
	})
}

func writeJSONRPCResult(w http.ResponseWriter, result interface{}) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      1,
		"result":  result,
	})
}

// nextFailure decides whether the next simulated RPC call fails. Exposing it
// lets tests assert the fault policy is reproducible from its seed.
func (r *chaosRPC) nextFailure() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.rng.Float64() < r.failureRate
}

func (r *chaosRPC) stopFaults() {
	r.mu.Lock()
	r.faultsActive = false
	r.mu.Unlock()
}

type chaosRPCSnapshot struct {
	requests        int
	injected503     int
	injectedLatency int
	lastFaultAt     time.Time
}

func (r *chaosRPC) snapshot() chaosRPCSnapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	return chaosRPCSnapshot{
		requests:        r.requests,
		injected503:     r.injected503,
		injectedLatency: r.injectedLatency,
		lastFaultAt:     r.lastFaultAt,
	}
}

// chaosAnchor is an anchor payout endpoint that fails transiently and dedupes
// submissions by idempotency key, exposing any double settlement.
type chaosAnchor struct {
	server *httptest.Server

	mu            sync.Mutex
	rng           *rand.Rand
	failureRate   float64
	faultsActive  bool
	attempts      map[string]int
	settled       map[string]int
	failures      int
	duplicates    int
	lastFaultAt   time.Time
	lastSettledAt time.Time
}

func newChaosAnchor(t *testing.T, failureRate float64, seed int64) *chaosAnchor {
	t.Helper()

	anchor := &chaosAnchor{
		rng:          rand.New(rand.NewSource(seed)),
		failureRate:  failureRate,
		faultsActive: true,
		attempts:     make(map[string]int),
		settled:      make(map[string]int),
	}
	anchor.server = httptest.NewServer(http.HandlerFunc(anchor.handle))
	t.Cleanup(anchor.server.Close)
	return anchor
}

func (a *chaosAnchor) handle(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost || req.URL.Path != "/payouts" {
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		return
	}

	var payload struct {
		IdempotencyKey string `json:"idempotency_key"`
		EscrowID       uint64 `json:"escrow_id"`
		Amount         string `json:"amount"`
	}
	if err := json.NewDecoder(io.LimitReader(req.Body, 4096)).Decode(&payload); err != nil || payload.IdempotencyKey == "" {
		http.Error(w, `{"error":"invalid payout request"}`, http.StatusBadRequest)
		return
	}

	a.mu.Lock()
	a.attempts[payload.IdempotencyKey]++
	fail := a.faultsActive && a.rng.Float64() < a.failureRate
	if fail {
		a.failures++
		a.lastFaultAt = time.Now()
		a.mu.Unlock()
		http.Error(w, `{"error":"anchor temporarily unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	if a.settled[payload.IdempotencyKey] > 0 {
		a.duplicates++
	}
	a.settled[payload.IdempotencyKey]++
	a.lastSettledAt = time.Now()
	a.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"status":"settled"}`))
}

func (a *chaosAnchor) stopFaults() {
	a.mu.Lock()
	a.faultsActive = false
	a.mu.Unlock()
}

type chaosAnchorSnapshot struct {
	attempts      map[string]int
	settled       map[string]int
	failures      int
	duplicates    int
	lastFaultAt   time.Time
	lastSettledAt time.Time
}

func (a *chaosAnchor) snapshot() chaosAnchorSnapshot {
	a.mu.Lock()
	defer a.mu.Unlock()

	attempts := make(map[string]int, len(a.attempts))
	for key, value := range a.attempts {
		attempts[key] = value
	}
	settled := make(map[string]int, len(a.settled))
	for key, value := range a.settled {
		settled[key] = value
	}
	return chaosAnchorSnapshot{
		attempts:      attempts,
		settled:       settled,
		failures:      a.failures,
		duplicates:    a.duplicates,
		lastFaultAt:   a.lastFaultAt,
		lastSettledAt: a.lastSettledAt,
	}
}

// chaosHarness wires the real relay pipeline against the fault-injecting RPC
// and anchor fakes.
type chaosHarness struct {
	t       *testing.T
	options chaosOptions

	rpc    *chaosRPC
	anchor *chaosAnchor

	idem   *store.MemoryStore
	outbox *store.MemoryOutboxStore

	sub    *listener.EventSubscriber
	worker *worker.OutboxWorker

	goodIDs    []string
	corruptIDs []string
	emitted    map[string]int
	failures   []string
	mu         sync.Mutex
	cancel     context.CancelFunc
}

func newChaosHarness(t *testing.T, opts chaosOptions) *chaosHarness {
	t.Helper()

	if opts.events <= 0 {
		opts.events = 8
	}
	if opts.seed == 0 {
		opts.seed = 7
	}

	events, goodIDs, corruptIDs := buildChaosEvents(opts.events, opts.corruptEvents)

	harness := &chaosHarness{
		t:          t,
		options:    opts,
		rpc:        newChaosRPC(t, events, opts),
		anchor:     newChaosAnchor(t, opts.anchorFailureRate, opts.seed+1),
		idem:       store.NewMemoryStore(chaosStartLedger),
		outbox:     store.NewMemoryOutboxStore(),
		goodIDs:    goodIDs,
		corruptIDs: corruptIDs,
		emitted:    make(map[string]int),
	}
	t.Cleanup(harness.close)
	return harness
}

// start launches the RPC poller, the ingestion consumer and the outbox worker.
func (h *chaosHarness) start(ctx context.Context) {
	ctx, cancel := context.WithCancel(ctx)
	h.cancel = cancel

	eventChan := make(chan listener.EventPayload, 256)

	h.sub = listener.NewEventSubscriber(h.rpc.server.URL, chaosContractID, h.idem, chaosLogger())
	h.sub.WithBackoffConfig(listener.BackoffConfig{
		InitialInterval: 10 * time.Millisecond,
		MaxInterval:     80 * time.Millisecond,
		Multiplier:      2.0,
		JitterFactor:    0.1,
	})
	h.sub.SetPollInterval(10 * time.Millisecond)

	go func() {
		if err := h.sub.PollEvents(ctx, eventChan); err != nil && !errors.Is(err, context.Canceled) {
			h.recordError(fmt.Errorf("event poller stopped: %w", err))
		}
	}()

	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case payload, ok := <-eventChan:
				if !ok {
					return
				}
				h.consume(ctx, payload)
			}
		}
	}()

	h.worker = worker.NewOutboxWorker(h.outbox, h.submitPayout, worker.OutboxWorkerConfig{
		BatchSize:      4,
		PollInterval:   5 * time.Millisecond,
		AdvisoryLockID: 918_273,
		MaxRetries:     12,
	}, chaosLogger())
	if err := h.worker.Start(ctx); err != nil {
		h.recordError(fmt.Errorf("start outbox worker: %w", err))
	}
}

// consume persists an emitted event into the transactional outbox and marks it
// completed in the idempotency store, mirroring the daemon's event loop.
func (h *chaosHarness) consume(ctx context.Context, payload listener.EventPayload) {
	h.mu.Lock()
	h.emitted[payload.EventID]++
	h.mu.Unlock()

	event := store.OutboxEvent{
		EventID:   payload.EventID,
		EventType: "disbursed",
		Payload: fmt.Sprintf(`{"escrow_id":%d,"amount":"%s","profile_hash":"%s"}`,
			payload.EscrowID, payload.PayoutAmount.String(), payload.ProfileHashHex),
	}
	if err := h.outbox.InsertLedgerEventsAtomic(ctx, payload.Ledger, []store.OutboxEvent{event}); err != nil &&
		!errors.Is(err, store.ErrLedgerAlreadyProcessed) {
		h.recordError(fmt.Errorf("persist outbox event %s: %w", payload.EventID, err))
		return
	}
	if err := h.idem.MarkCompleted(payload.EventID); err != nil {
		h.recordError(fmt.Errorf("mark event %s completed: %w", payload.EventID, err))
	}
}

// submitPayout is the outbox worker handler. It submits a payout keyed by the
// Soroban event ID so an anchor can dedupe an ambiguous retry.
func (h *chaosHarness) submitPayout(ctx context.Context, event store.OutboxEvent) error {
	var payout struct {
		EscrowID uint64 `json:"escrow_id"`
		Amount   string `json:"amount"`
	}
	if err := json.Unmarshal([]byte(event.Payload), &payout); err != nil {
		return fmt.Errorf("decode outbox payload for %s: %w", event.EventID, err)
	}

	body, err := json.Marshal(map[string]interface{}{
		"idempotency_key": event.EventID,
		"escrow_id":       payout.EscrowID,
		"amount":          payout.Amount,
	})
	if err != nil {
		return fmt.Errorf("encode payout request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.anchor.server.URL+"/payouts", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build payout request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("submit payout: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("anchor returned HTTP %d for event %s", resp.StatusCode, event.EventID)
	}
	return nil
}

func (h *chaosHarness) recordError(err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.failures = append(h.failures, err.Error())
}

func (h *chaosHarness) reportedFailures() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.failures...)
}

func (h *chaosHarness) emissionCount(eventID string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.emitted[eventID]
}

func (h *chaosHarness) close() {
	if h.worker != nil {
		h.worker.Stop()
	}
	if h.cancel != nil {
		h.cancel()
	}
}

// waitUntil polls condition until it holds or the timeout expires.
func waitUntil(t *testing.T, timeout time.Duration, description string, condition func() bool) {
	t.Helper()

	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out after %s waiting for %s", timeout, description)
}

// waitForIngestion blocks until every disbursed event has been claimed,
// persisted to the outbox and marked completed by the idempotency store.
func (h *chaosHarness) waitForIngestion(timeout time.Duration) {
	h.t.Helper()

	waitUntil(h.t, timeout, "all events to be ingested", func() bool {
		for _, eventID := range h.goodIDs {
			if !h.idem.IsProcessed(eventID) {
				return false
			}
			event, err := h.outbox.GetEvent(context.Background(), eventID)
			if err != nil || event == nil {
				return false
			}
		}
		return true
	})
}

// waitForSettlements blocks until the outbox worker has settled every payout.
func (h *chaosHarness) waitForSettlements(timeout time.Duration) {
	h.t.Helper()

	waitUntil(h.t, timeout, "all payouts to settle", func() bool {
		settled := h.anchor.snapshot().settled
		for _, eventID := range h.goodIDs {
			if settled[eventID] == 0 {
				return false
			}
		}
		for _, eventID := range h.goodIDs {
			event, err := h.outbox.GetEvent(context.Background(), eventID)
			if err != nil || event == nil || event.Status != store.OutboxStatusCompleted {
				return false
			}
		}
		return true
	})
}

// waitForConnectedState blocks until the reconnect state machine reports a
// healthy connection again.
func (h *chaosHarness) waitForConnectedState(timeout time.Duration) {
	h.t.Helper()

	waitUntil(h.t, timeout, "the RPC listener to report CONNECTED", func() bool {
		return h.sub.ConnectionState() == listener.StateConnected
	})
}

func TestChaosRelayRecoversWithoutDroppingEventsOrDoublePaying(t *testing.T) {
	if testing.Short() {
		t.Skip("chaos suite injects deliberate RPC latency; run without -short")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	harness := newChaosHarness(t, chaosOptions{
		events:            8,
		pageSize:          2,
		failureRate:       0.35,
		anchorFailureRate: 0.25,
		latency:           500 * time.Millisecond,
		seed:              11,
	})
	harness.start(ctx)

	// Phase 1: ingest the whole stream while the RPC and anchor are failing.
	harness.waitForIngestion(45 * time.Second)

	// Phase 2: stop injecting faults and require the pipeline to drain.
	harness.rpc.stopFaults()
	harness.anchor.stopFaults()
	harness.waitForSettlements(45 * time.Second)
	harness.waitForConnectedState(15 * time.Second)

	if failures := harness.reportedFailures(); len(failures) > 0 {
		t.Fatalf("relay reported pipeline failures during chaos run: %v", failures)
	}

	rpcStats := harness.rpc.snapshot()
	if rpcStats.injected503 == 0 {
		t.Fatalf("chaos run injected no RPC 503s, the fault policy did not exercise recovery")
	}
	if rpcStats.injectedLatency == 0 {
		t.Fatalf("chaos run injected no network latency, the fault policy did not exercise recovery")
	}

	// No dropped events: every disbursed event was emitted exactly once and
	// reached a completed outbox state.
	for _, eventID := range harness.goodIDs {
		if emissions := harness.emissionCount(eventID); emissions != 1 {
			t.Fatalf("event %s was emitted %d times, want exactly 1", eventID, emissions)
		}
		event, err := harness.outbox.GetEvent(context.Background(), eventID)
		if err != nil {
			t.Fatalf("outbox lookup for %s failed: %v", eventID, err)
		}
		if event.Status != store.OutboxStatusCompleted {
			t.Fatalf("outbox event %s is %q, want %q", eventID, event.Status, store.OutboxStatusCompleted)
		}
	}

	// No double disbursement: every payout settled exactly once and at least
	// one payout was retried, proving retries are deduplicated rather than
	// replayed as a second transfer.
	anchorStats := harness.anchor.snapshot()
	retries := 0
	for _, eventID := range harness.goodIDs {
		if got := anchorStats.settled[eventID]; got != 1 {
			t.Fatalf("payout for %s settled %d times, want exactly 1", eventID, got)
		}
		if got := anchorStats.attempts[eventID]; got > 1 {
			retries++
		}
	}
	if anchorStats.duplicates != 0 {
		t.Fatalf("anchor observed %d double settlements", anchorStats.duplicates)
	}
	if anchorStats.failures == 0 || retries == 0 {
		t.Fatalf("expected transient anchor failures and at least one payout retry (failures=%d retries=%d)",
			anchorStats.failures, retries)
	}

	// Recovery time objective: from the last injected fault to the last
	// settlement must stay inside the documented RTO.
	lastFault := rpcStats.lastFaultAt
	if anchorStats.lastFaultAt.After(lastFault) {
		lastFault = anchorStats.lastFaultAt
	}
	if !lastFault.IsZero() && !anchorStats.lastSettledAt.IsZero() {
		recovery := anchorStats.lastSettledAt.Sub(lastFault)
		t.Logf("observed recovery time after the last injected fault: %s (RTO objective %s)", recovery.Round(time.Millisecond), chaosRTOObjective)
		if recovery > chaosRTOObjective {
			t.Fatalf("recovery took %s, exceeding the %s RTO documented in docs/relay.md", recovery, chaosRTOObjective)
		}
	}
}

func TestChaosRelaySkipsCorruptedEventStreamWithoutStalling(t *testing.T) {
	if testing.Short() {
		t.Skip("chaos suite injects deliberate RPC latency; run without -short")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	harness := newChaosHarness(t, chaosOptions{
		events:            6,
		corruptEvents:     2,
		pageSize:          2,
		failureRate:       0.2,
		anchorFailureRate: 0.0,
		latency:           500 * time.Millisecond,
		seed:              23,
	})
	harness.start(ctx)

	harness.waitForIngestion(45 * time.Second)
	harness.rpc.stopFaults()
	harness.waitForSettlements(45 * time.Second)

	if failures := harness.reportedFailures(); len(failures) > 0 {
		t.Fatalf("corrupted event stream caused pipeline failures: %v", failures)
	}

	// Corrupted events are skipped: they must never reach the outbox, and they
	// must not block the valid events that follow them.
	for _, eventID := range harness.corruptIDs {
		if _, err := harness.outbox.GetEvent(context.Background(), eventID); err == nil {
			t.Fatalf("corrupted event %s was written to the outbox", eventID)
		}
	}
	for _, eventID := range harness.goodIDs {
		if emissions := harness.emissionCount(eventID); emissions != 1 {
			t.Fatalf("event %s was emitted %d times, want exactly 1", eventID, emissions)
		}
	}

	anchorStats := harness.anchor.snapshot()
	for _, eventID := range harness.goodIDs {
		if got := anchorStats.settled[eventID]; got != 1 {
			t.Fatalf("payout for %s settled %d times, want exactly 1", eventID, got)
		}
	}
}

func TestChaosFaultPolicyIsDeterministic(t *testing.T) {
	// The chaos suite must be reproducible: identical seeds produce identical
	// fault decisions, otherwise failures cannot be diagnosed from CI logs.
	events, _, _ := buildChaosEvents(4, 0)
	first := newChaosRPC(t, events, chaosOptions{pageSize: 2, failureRate: 0.5, latency: time.Millisecond, seed: 5})
	second := newChaosRPC(t, events, chaosOptions{pageSize: 2, failureRate: 0.5, latency: time.Millisecond, seed: 5})

	for i := 0; i < 5; i++ {
		if first.nextFailure() != second.nextFailure() {
			t.Fatalf("identical seeds diverged at decision %d", i)
		}
	}
}
