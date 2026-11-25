package listener

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/soroban-anchor-gate/relay/internal/store"
)

func TestBackoffConfig_ExponentialProgressionAndCap(t *testing.T) {
	cfg := BackoffConfig{
		InitialInterval: 1 * time.Second,
		MaxInterval:     60 * time.Second,
		Multiplier:      2.0,
		JitterFactor:    0.2, // +/- 20%
	}
	sm := NewReconnectStateMachine(cfg)

	// Attempt 1: base = 1s, with +/-20% jitter -> [0.8s, 1.2s]
	b1 := sm.CalculateBackoff(1)
	if b1 < 750*time.Millisecond || b1 > 1250*time.Millisecond {
		t.Fatalf("expected attempt 1 in [0.8s, 1.2s], got %v", b1)
	}

	// Attempt 2: base = 2s, with +/-20% jitter -> [1.6s, 2.4s]
	b2 := sm.CalculateBackoff(2)
	if b2 < 1500*time.Millisecond || b2 > 2500*time.Millisecond {
		t.Fatalf("expected attempt 2 in [1.6s, 2.4s], got %v", b2)
	}

	// Attempt 3: base = 4s, with +/-20% jitter -> [3.2s, 4.8s]
	b3 := sm.CalculateBackoff(3)
	if b3 < 3100*time.Millisecond || b3 > 4900*time.Millisecond {
		t.Fatalf("expected attempt 3 in [3.2s, 4.8s], got %v", b3)
	}

	// Attempt 10: base would be 512s, capped at 60s -> with +/-20% jitter -> [48s, 72s]
	b10 := sm.CalculateBackoff(10)
	if b10 < 47*time.Second || b10 > 73*time.Second {
		t.Fatalf("expected attempt 10 capped around 60s (+/-20%%), got %v", b10)
	}
}

func TestReconnectStateMachine_Transitions(t *testing.T) {
	sm := NewReconnectStateMachine(DefaultBackoffConfig())
	if sm.State() != StateDisconnected {
		t.Fatalf("expected initial state %s, got %s", StateDisconnected, sm.State())
	}

	var transitions []string
	sm.SetOnTransition(func(oldState, newState ConnectionState) {
		transitions = append(transitions, fmt.Sprintf("%s->%s", oldState, newState))
	})

	sm.Transition(StateConnecting)
	if sm.State() != StateConnecting {
		t.Fatalf("expected state %s, got %s", StateConnecting, sm.State())
	}

	sm.RecordSuccess()
	if sm.State() != StateConnected {
		t.Fatalf("expected state %s, got %s", StateConnected, sm.State())
	}

	// Disconnection occurs
	dur := sm.RecordFailure(fmt.Errorf("websocket disconnect"))
	if sm.State() != StateReconnecting {
		t.Fatalf("expected state %s, got %s", StateReconnecting, sm.State())
	}
	if sm.Attempts() != 1 {
		t.Fatalf("expected attempts=1, got %d", sm.Attempts())
	}
	if dur <= 0 {
		t.Fatalf("expected positive backoff duration, got %v", dur)
	}

	// Backfill stage
	sm.Transition(StateBackfilling)
	if sm.State() != StateBackfilling {
		t.Fatalf("expected state %s, got %s", StateBackfilling, sm.State())
	}

	// Backfilled and fully recovered
	sm.RecordSuccess()
	if sm.State() != StateConnected {
		t.Fatalf("expected state %s, got %s", StateConnected, sm.State())
	}
	if sm.Attempts() != 0 {
		t.Fatalf("expected attempts reset to 0, got %d", sm.Attempts())
	}

	expectedTransitions := []string{
		"DISCONNECTED->CONNECTING",
		"CONNECTING->CONNECTED",
		"CONNECTED->RECONNECTING",
		"RECONNECTING->BACKFILLING",
		"BACKFILLING->CONNECTED",
	}

	if len(transitions) != len(expectedTransitions) {
		t.Fatalf("expected %d transitions, got %d: %v", len(expectedTransitions), len(transitions), transitions)
	}
	for i, tr := range expectedTransitions {
		if transitions[i] != tr {
			t.Errorf("transition %d: expected %s, got %s", i, tr, transitions[i])
		}
	}
}

func TestReconnect_SimulatedDisconnectionsAndBackfillRecovery(t *testing.T) {
	var requestCount int64
	var disconnectActive atomic.Bool
	disconnectActive.Store(false)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&requestCount, 1)

		bodyBytes, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}

		var req RPCRequest
		if err := json.Unmarshal(bodyBytes, &req); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}

		// When disconnectActive is true, simulate RPC 503 / connection drop
		if disconnectActive.Load() {
			http.Error(w, "RPC service unavailable: connection dropped", http.StatusServiceUnavailable)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if req.Method == "getLatestLedger" {
			_ = json.NewEncoder(w).Encode(LatestLedgerResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Result: LatestLedgerResult{
					Sequence: 105,
				},
			})
			return
		}

		if req.Method == "getEvents" {
			// Serve a test event at ledger 102
			eventItem := EventItem{
				ID:                       "0000000102-0000000001",
				ContractID:               testContractID,
				Topic:                    []string{topicDisbursedXDR, topicEscrow42XDR},
				Ledger:                   102,
				InSuccessfulContractCall: true,
				Value: EventValue{
					XDR: valueNormalXDR,
				},
			}
			_ = json.NewEncoder(w).Encode(RPCResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Result: GetEventsResult{
					Events:       []EventItem{eventItem},
					LatestLedger: 105,
				},
			})
			return
		}

		http.Error(w, "unhandled method", http.StatusNotFound)
	}))
	defer server.Close()

	memStore := store.NewMemoryStore(100)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	fastBackoff := BackoffConfig{
		InitialInterval: 10 * time.Millisecond,
		MaxInterval:     50 * time.Millisecond,
		Multiplier:      1.5,
		JitterFactor:    0.1,
	}

	subscriber := NewEventSubscriber(server.URL, testContractID, memStore, logger)
	subscriber.WithBackoffConfig(fastBackoff)
	subscriber.SetPollInterval(25 * time.Millisecond)

	eventChan := make(chan EventPayload, 10)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Track connection state transitions
	var observedStates []ConnectionState
	subscriber.StateMachine().SetOnTransition(func(oldState, newState ConnectionState) {
		observedStates = append(observedStates, newState)
	})

	errChan := make(chan error, 1)
	go func() {
		errChan <- subscriber.PollEvents(ctx, eventChan)
	}()

	// 1. Wait for initial event
	select {
	case ev := <-eventChan:
		if ev.EscrowID != 42 {
			t.Fatalf("expected escrow ID 42, got %d", ev.EscrowID)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("timed out waiting for initial event")
	}

	// 2. Trigger simulated disconnection
	disconnectActive.Store(true)

	// Wait for subscriber to transition to RECONNECTING
	time.Sleep(100 * time.Millisecond)
	if subscriber.ConnectionState() != StateReconnecting {
		t.Logf("active connection state during outage: %s (expected %s)", subscriber.ConnectionState(), StateReconnecting)
	}

	// 3. Restore server and verify automatic reconnection and backfill
	disconnectActive.Store(false)

	// Wait for reconnection to succeed and state to return to CONNECTED
	deadline := time.Now().Add(2 * time.Second)
	recovered := false
	for time.Now().Before(deadline) {
		if subscriber.ConnectionState() == StateConnected {
			recovered = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	if !recovered {
		t.Fatalf("expected subscriber to recover to CONNECTED state, got %s", subscriber.ConnectionState())
	}

	// Verify cursor was updated to at least 105
	if memStore.GetCursor() < 105 {
		t.Fatalf("expected cursor to advance to at least 105 after backfill, got %d", memStore.GetCursor())
	}

	cancel()
	<-errChan
}
