package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/soroban-anchor-gate/relay/internal/store"
)

func TestAPIServer_HealthzEndpoint(t *testing.T) {
	st := store.NewMemoryStore(5000)
	srv := NewServer("CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT", "https://soroban-testnet.stellar.org", st)

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()

	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}

	var resp HealthResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode healthz response: %v", err)
	}

	if resp.Status != "ok" {
		t.Fatalf("expected status 'ok', got %s", resp.Status)
	}
	if resp.CurrentCursor != 5000 {
		t.Fatalf("expected cursor 5000, got %d", resp.CurrentCursor)
	}
}

func TestAPIServer_AdminPauseAuthenticationAndControl(t *testing.T) {
	st := store.NewMemoryStore(100)
	srv := NewServer("CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT", "https://soroban-testnet.stellar.org", st)
	srv.SetAdminKey("test-secret-key-123")

	handler := srv.Handler()

	// 1. Unauthorized request without headers must be rejected (401)
	reqUnauth := httptest.NewRequest(http.MethodPost, "/admin/pause", nil)
	recUnauth := httptest.NewRecorder()
	handler.ServeHTTP(recUnauth, reqUnauth)

	if recUnauth.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 Unauthorized, got %d", recUnauth.Code)
	}

	// 2. Unauthorized request with wrong Bearer token must be rejected (401)
	reqWrongToken := httptest.NewRequest(http.MethodPost, "/admin/pause", nil)
	reqWrongToken.Header.Set("Authorization", "Bearer invalid-token")
	recWrongToken := httptest.NewRecorder()
	handler.ServeHTTP(recWrongToken, reqWrongToken)

	if recWrongToken.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 Unauthorized for wrong token, got %d", recWrongToken.Code)
	}

	// 3. Authorized request with Bearer token pauses daemon
	reqPause := httptest.NewRequest(http.MethodPost, "/admin/pause", nil)
	reqPause.Header.Set("Authorization", "Bearer test-secret-key-123")
	recPause := httptest.NewRecorder()
	handler.ServeHTTP(recPause, reqPause)

	if recPause.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for authorized pause, got %d", recPause.Code)
	}

	var pauseResp PauseResponse
	if err := json.NewDecoder(recPause.Body).Decode(&pauseResp); err != nil {
		t.Fatalf("failed to decode pause response: %v", err)
	}
	if !pauseResp.Paused || pauseResp.Status != "paused" {
		t.Fatalf("expected paused=true, status='paused', got %+v", pauseResp)
	}
	if !srv.IsPaused() {
		t.Fatalf("expected srv.IsPaused() to be true")
	}

	// 4. Verify /status endpoint reflects paused state
	reqStatus := httptest.NewRequest(http.MethodGet, "/status", nil)
	recStatus := httptest.NewRecorder()
	handler.ServeHTTP(recStatus, reqStatus)

	var statusResp StatusResponse
	if err := json.NewDecoder(recStatus.Body).Decode(&statusResp); err != nil {
		t.Fatalf("failed to decode status response: %v", err)
	}
	if !statusResp.Paused || statusResp.Status != "paused" {
		t.Fatalf("expected status to show paused, got status=%s, paused=%v", statusResp.Status, statusResp.Paused)
	}

	// 5. Authorized request with X-API-Key unpauses daemon
	unpausePayload, _ := json.Marshal(map[string]bool{"paused": false})
	reqUnpause := httptest.NewRequest(http.MethodPost, "/admin/pause", bytes.NewReader(unpausePayload))
	reqUnpause.Header.Set("X-API-Key", "test-secret-key-123")
	reqUnpause.Header.Set("Content-Type", "application/json")
	recUnpause := httptest.NewRecorder()
	handler.ServeHTTP(recUnpause, reqUnpause)

	if recUnpause.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for unpause, got %d", recUnpause.Code)
	}
	if srv.IsPaused() {
		t.Fatalf("expected srv.IsPaused() to be false after unpause")
	}
}

func TestAPIServer_AdminPauseFailsClosedWithoutAdminKey(t *testing.T) {
	t.Setenv("ADMIN_API_KEY", "")
	st := store.NewMemoryStore(100)
	srv := NewServer("CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT", "https://soroban-testnet.stellar.org", st)
	handler := srv.Handler()

	// Even with the legacy fallback token, unconfigured admin auth must fail closed (401).
	req := httptest.NewRequest(http.MethodPost, "/admin/pause", nil)
	req.Header.Set("Authorization", "Bearer admin-secret-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 Unauthorized when ADMIN_API_KEY is unset, got %d", rec.Code)
	}
	if srv.IsPaused() {
		t.Fatalf("expected relay not to be paused when ADMIN_API_KEY is unset")
	}
}

func TestAPIServer_EscrowsQueryEndpoint(t *testing.T) {
	st := store.NewMemoryStore(100)
	srv := NewServer("CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT", "https://soroban-testnet.stellar.org", st)

	handler := srv.Handler()

	// 1. Query existing seeded escrow #1
	reqEscrow := httptest.NewRequest(http.MethodGet, "/escrows/1", nil)
	recEscrow := httptest.NewRecorder()
	handler.ServeHTTP(recEscrow, reqEscrow)

	if recEscrow.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for escrow 1, got %d", recEscrow.Code)
	}

	var escrow EscrowResponse
	if err := json.NewDecoder(recEscrow.Body).Decode(&escrow); err != nil {
		t.Fatalf("failed to decode escrow response: %v", err)
	}
	if escrow.EscrowID != "1" || escrow.Status != "funded" {
		t.Fatalf("unexpected escrow response: %+v", escrow)
	}

	// 2. Query registered custom escrow
	srv.RegisterEscrow(EscrowResponse{
		EscrowID:    "42",
		ContractID:  "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT",
		Status:      "disbursed",
		Amount:      "500.0000000",
		Payer:       "GBZXN7PIRZGNMHGA728KLMS729DNMC718290",
		Beneficiary: "GD2C7N6B37L4Y3T5G6D7H8J9K0L1M2N3P4Q5R6S7",
		ProfileHash: "abcd1234",
	})

	reqCustom := httptest.NewRequest(http.MethodGet, "/escrows/42", nil)
	recCustom := httptest.NewRecorder()
	handler.ServeHTTP(recCustom, reqCustom)

	if recCustom.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for escrow 42, got %d", recCustom.Code)
	}

	// 3. Query non-existent escrow returns 404 Not Found
	reqNotFound := httptest.NewRequest(http.MethodGet, "/escrows/99999", nil)
	recNotFound := httptest.NewRecorder()
	handler.ServeHTTP(recNotFound, reqNotFound)

	if recNotFound.Code != http.StatusNotFound {
		t.Fatalf("expected 404 Not Found, got %d", recNotFound.Code)
	}

	// 4. Query invalid path format returns 400 Bad Request
	reqInvalid := httptest.NewRequest(http.MethodGet, "/escrows/", nil)
	recInvalid := httptest.NewRecorder()
	handler.ServeHTTP(recInvalid, reqInvalid)

	if recInvalid.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request, got %d", recInvalid.Code)
	}
}

func TestAPIServer_OpenAPISpecificationEndpoint(t *testing.T) {
	st := store.NewMemoryStore(100)
	srv := NewServer("CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT", "https://soroban-testnet.stellar.org", st)

	req := httptest.NewRequest(http.MethodGet, "/openapi.json", nil)
	rec := httptest.NewRecorder()

	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for /openapi.json, got %d", rec.Code)
	}

	var spec map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&spec); err != nil {
		t.Fatalf("failed to decode OpenAPI spec JSON: %v", err)
	}

	if spec["openapi"] != "3.0.3" {
		t.Fatalf("expected openapi version '3.0.3', got %v", spec["openapi"])
	}
}
