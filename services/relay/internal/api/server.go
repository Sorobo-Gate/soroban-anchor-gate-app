package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/soroban-anchor-gate/relay/internal/store"
)

// Server provides an HTTP REST API for relay monitoring, health, and event queries.
type Server struct {
	contractID string
	rpcURL     string
	relayStore store.IdempotencyStore
	startedAt  time.Time
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
}

// NewServer creates a new HTTP API server instance.
func NewServer(contractID, rpcURL string, st store.IdempotencyStore) *Server {
	return &Server{
		contractID: contractID,
		rpcURL:     rpcURL,
		relayStore: st,
		startedAt:  time.Now(),
	}
}

// Handler returns the HTTP handler with all registered routes.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/status", s.handleStatus)
	mux.HandleFunc("/events", s.handleEvents)
	return mux
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
	json.NewEncoder(w).Encode(resp)
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

	resp := StatusResponse{
		Status:        "running",
		ContractID:    s.contractID,
		RPCURL:        s.rpcURL,
		CurrentCursor: cursor,
		Uptime:        time.Since(s.startedAt).Round(time.Second).String(),
		TotalEvents:   totalEvents,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
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
	json.NewEncoder(w).Encode(map[string]interface{}{
		"count":  len(events),
		"events": events,
	})
}
