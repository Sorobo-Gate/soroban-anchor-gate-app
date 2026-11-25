package api

import (
	"crypto/subtle"
	_ "embed"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/soroban-anchor-gate/relay/internal/store"
)

//go:embed openapi.json
var openAPISpec []byte

// Server provides an HTTP REST API for relay monitoring, health, admin operations, and escrow queries.
type Server struct {
	mu         sync.RWMutex
	contractID string
	rpcURL     string
	relayStore store.IdempotencyStore
	startedAt  time.Time
	adminKey   string
	paused     bool
	escrows    map[string]EscrowResponse
}

// HealthResponse represents the health status of the relay daemon.
type HealthResponse struct {
	Status        string `json:"status"`
	ContractID    string `json:"contract_id"`
	CurrentCursor uint32 `json:"current_cursor"`
	UptimeSeconds int64  `json:"uptime_seconds"`
	Timestamp     int64  `json:"timestamp"`
}

// StatusResponse provides operational metrics and configuration details.
type StatusResponse struct {
	Status        string `json:"status"`
	ContractID    string `json:"contract_id"`
	RPCURL        string `json:"rpc_url"`
	CurrentCursor uint32 `json:"current_cursor"`
	Uptime        string `json:"uptime"`
	TotalEvents   int    `json:"total_events"`
	Paused        bool   `json:"paused"`
}

// PauseRequest is the optional JSON payload for POST /admin/pause.
type PauseRequest struct {
	Paused *bool `json:"paused,omitempty"`
}

// PauseResponse represents the response from POST /admin/pause.
type PauseResponse struct {
	Status    string `json:"status"`
	Paused    bool   `json:"paused"`
	Timestamp int64  `json:"timestamp"`
}

// EscrowResponse represents detailed escrow state.
type EscrowResponse struct {
	EscrowID        string `json:"escrow_id"`
	ContractID      string `json:"contract_id"`
	Status          string `json:"status"`
	Amount          string `json:"amount"`
	Payer           string `json:"payer"`
	Beneficiary     string `json:"beneficiary"`
	ProfileHash     string `json:"profile_hash"`
	CreatedAtLedger uint32 `json:"created_at_ledger"`
}

// ErrorResponse represents standard error JSON.
type ErrorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

// NewServer creates a new HTTP API server instance.
// Admin endpoints remain disabled (fail-closed) unless ADMIN_API_KEY or SetAdminKey is configured.
func NewServer(contractID, rpcURL string, st store.IdempotencyStore) *Server {
	adminKey := strings.TrimSpace(os.Getenv("ADMIN_API_KEY"))

	s := &Server{
		contractID: contractID,
		rpcURL:     rpcURL,
		relayStore: st,
		startedAt:  time.Now(),
		adminKey:   adminKey,
		paused:     false,
		escrows:    make(map[string]EscrowResponse),
	}

	// Pre-seed default mock escrow for standard testing and demo
	s.RegisterEscrow(EscrowResponse{
		EscrowID:        "1",
		ContractID:      contractID,
		Status:          "funded",
		Amount:          "100.0000000",
		Payer:           "GBZXN7PIRZGNMHGA728KLMS729DNMC718290",
		Beneficiary:     "GD2C7N6B37L4Y3T5G6D7H8J9K0L1M2N3P4Q5R6S7",
		ProfileHash:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		CreatedAtLedger: 5000,
	})

	return s
}

// SetAdminKey configures the authorization secret for administrative endpoints.
func (s *Server) SetAdminKey(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.adminKey = key
}

// SetPaused updates the processing pause state.
func (s *Server) SetPaused(paused bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.paused = paused
}

// IsPaused reports whether processing is currently paused.
func (s *Server) IsPaused() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.paused
}

// RegisterEscrow registers an escrow record for query lookup.
func (s *Server) RegisterEscrow(escrow EscrowResponse) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.escrows[escrow.EscrowID] = escrow
}

// Handler returns the HTTP handler with all registered routes.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/status", s.handleStatus)
	mux.HandleFunc("/events", s.handleEvents)
	mux.HandleFunc("/admin/pause", s.handleAdminPause)
	mux.HandleFunc("/escrows/", s.handleEscrowByID)
	mux.HandleFunc("/openapi.json", s.handleOpenAPISpec)
	mux.HandleFunc("/swagger.json", s.handleOpenAPISpec)
	return mux
}

func (s *Server) checkAdminAuth(r *http.Request) bool {
	s.mu.RLock()
	expectedKey := s.adminKey
	s.mu.RUnlock()

	if expectedKey == "" {
		return false
	}

	// Check Authorization header (Bearer <token> or ApiKey <token>)
	authHeader := r.Header.Get("Authorization")
	if authHeader != "" {
		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) == 2 && (strings.EqualFold(parts[0], "bearer") || strings.EqualFold(parts[0], "apikey")) {
			provided := strings.TrimSpace(parts[1])
			if subtle.ConstantTimeCompare([]byte(provided), []byte(expectedKey)) == 1 {
				return true
			}
		}
	}

	// Check X-API-Key header
	if apiKey := r.Header.Get("X-API-Key"); apiKey != "" {
		provided := strings.TrimSpace(apiKey)
		if subtle.ConstantTimeCompare([]byte(provided), []byte(expectedKey)) == 1 {
			return true
		}
	}

	return false
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	cursor := uint32(0)
	if s.relayStore != nil {
		cursor = s.relayStore.GetCursor()
	}

	resp := HealthResponse{
		Status:        "ok",
		ContractID:    s.contractID,
		CurrentCursor: cursor,
		UptimeSeconds: int64(time.Since(s.startedAt).Seconds()),
		Timestamp:     time.Now().Unix(),
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	cursor := uint32(0)
	totalEvents := 0
	if s.relayStore != nil {
		cursor = s.relayStore.GetCursor()
		totalEvents = s.relayStore.Count()
	}

	paused := s.IsPaused()
	statusText := "running"
	if paused {
		statusText = "paused"
	}

	resp := StatusResponse{
		Status:        statusText,
		ContractID:    s.contractID,
		RPCURL:        s.rpcURL,
		CurrentCursor: cursor,
		Uptime:        time.Since(s.startedAt).Round(time.Second).String(),
		TotalEvents:   totalEvents,
		Paused:        paused,
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func (s *Server) handleAdminPause(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	if !s.checkAdminAuth(r) {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(ErrorResponse{
			Error:   "unauthorized",
			Message: "missing or invalid admin API key",
		})
		return
	}

	shouldPause := true
	if r.Body != nil && r.ContentLength > 0 {
		var req PauseRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err == nil && req.Paused != nil {
			shouldPause = *req.Paused
		}
	}

	s.SetPaused(shouldPause)

	statusText := "paused"
	if !shouldPause {
		statusText = "running"
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(PauseResponse{
		Status:    statusText,
		Paused:    shouldPause,
		Timestamp: time.Now().Unix(),
	})
}

func (s *Server) handleEscrowByID(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	id := strings.TrimPrefix(r.URL.Path, "/escrows/")
	id = strings.TrimSpace(id)

	if id == "" || strings.Contains(id, "/") {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(ErrorResponse{
			Error:   "bad_request",
			Message: "invalid escrow ID format",
		})
		return
	}

	s.mu.RLock()
	escrow, exists := s.escrows[id]
	s.mu.RUnlock()

	if !exists {
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(ErrorResponse{
			Error:   "not_found",
			Message: "escrow not found",
		})
		return
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(escrow)
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var events []store.EventRecord
	if s.relayStore != nil {
		events = s.relayStore.ListAll()
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"count":  len(events),
		"events": events,
	})
}

func (s *Server) handleOpenAPISpec(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(openAPISpec)
}
