package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/soroban-anchor-gate/relay/internal/store"
)

func TestAPIServer_HealthEndpoint(t *testing.T) {
	st := store.NewMemoryStore(5000)
	srv := NewServer("CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT", "https://soroban-testnet.stellar.org", st)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()

	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}

	var resp HealthResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode health response: %v", err)
	}

	if resp.Status != "ok" {
		t.Fatalf("expected status 'ok', got %s", resp.Status)
	}
	if resp.CurrentCursor != 5000 {
		t.Fatalf("expected cursor 5000, got %d", resp.CurrentCursor)
	}
}

func TestAPIServer_StatusAndEventsEndpoints(t *testing.T) {
	st := store.NewMemoryStore(100)
	_ = st.RecordObserved("event-001")
	_ = st.MarkCompleted("event-001")

	srv := NewServer("CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT", "https://soroban-testnet.stellar.org", st)

	// Test /status
	reqStatus := httptest.NewRequest(http.MethodGet, "/status", nil)
	recStatus := httptest.NewRecorder()
	srv.Handler().ServeHTTP(recStatus, reqStatus)

	if recStatus.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", recStatus.Code)
	}

	var statusResp StatusResponse
	if err := json.NewDecoder(recStatus.Body).Decode(&statusResp); err != nil {
		t.Fatalf("failed to decode status response: %v", err)
	}
	if statusResp.TotalEvents != 1 {
		t.Fatalf("expected 1 total event, got %d", statusResp.TotalEvents)
	}

	// Test /events
	reqEvents := httptest.NewRequest(http.MethodGet, "/events", nil)
	recEvents := httptest.NewRecorder()
	srv.Handler().ServeHTTP(recEvents, reqEvents)

	if recEvents.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", recEvents.Code)
	}

	var eventsPayload struct {
		Count  int                 `json:"count"`
		Events []store.EventRecord `json:"events"`
	}
	if err := json.NewDecoder(recEvents.Body).Decode(&eventsPayload); err != nil {
		t.Fatalf("failed to decode events response: %v", err)
	}
	if eventsPayload.Count != 1 || len(eventsPayload.Events) != 1 {
		t.Fatalf("expected 1 event, got count %d, len %d", eventsPayload.Count, len(eventsPayload.Events))
	}
	if eventsPayload.Events[0].EventID != "event-001" {
		t.Fatalf("expected eventID 'event-001', got %s", eventsPayload.Events[0].EventID)
	}
}
