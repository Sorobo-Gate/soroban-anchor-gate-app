package rpc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"log/slog"
	"time"
)

// EventFilter represents an RPC event filter.
type EventFilter struct {
	Type        string   `json:"type"`
	ContractIDs []string `json:"contractIds,omitempty"`
	Topics      [][]string `json:"topics,omitempty"`
}

// EventItem represents a single event item from RPC getEvents response.
type EventItem struct {
	ID                       string   `json:"id"`
	Type                     string   `json:"type"`
	Ledger                   uint32   `json:"ledger"`
	LedgerClosedAt           string   `json:"ledgerClosedAt"`
	ContractID               string   `json:"contractId"`
	Topic                    []string `json:"topic"`
	Value                    EventValue `json:"value"`
	InSuccessfulContractCall bool       `json:"inSuccessfulContractCall"`
}

// EventValue represents the value field of an event item.
type EventValue struct {
	XDR string      `json:"xdr"`
	Raw interface{} `json:"raw,omitempty"`
}

// GetEventsParams represents the parameters for getEvents RPC method.
type GetEventsParams struct {
	StartLedger uint32        `json:"startLedger"`
	Filters     []EventFilter `json:"filters"`
}

// RPCRequest is the JSON-RPC 2.0 request structure.
type RPCRequest struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      int         `json:"id"`
	Method  string      `json:"method"`
	Params  interface{} `json:"params"`
}

// RPCResponse is the JSON-RPC 2.0 response structure.
type RPCResponse struct {
	JSONRPC string    `json:"jsonrpc"`
	ID      int       `json:"id"`
	Result  result    `json:"result"`
	Error   *RPCError `json:"error,omitempty"`
}

type result struct {
	Events       []EventItem `json:"events"`
	LatestLedger uint32      `json:"latestLedger"`
}

// RPCError represents a JSON-RPC error.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// RPCQuorumClient multiplexes requests across primary and secondary RPC URLs.
// It detects ledger height lag (>5 ledgers behind) and triggers automatic failover.
type RPCQuorumClient struct {
	primaryURL   string
	secondaryURL string
	currentURL   string

	rpcClient *http.Client
	logger    *slog.Logger
}

// NewRPCQuorumClient creates a new RPCQuorumClient.
func NewRPCQuorumClient(primaryURL, secondaryURL string, logger *slog.Logger) *RPCQuorumClient {
	q := &RPCQuorumClient{
		primaryURL:   primaryURL,
		secondaryURL: secondaryURL,
		currentURL:   primaryURL,
		rpcClient:    &http.Client{Timeout: 10 * time.Second},
		logger:       logger,
	}
	return q
}

// URL returns the currently active RPC URL.
func (q *RPCQuorumClient) URL() string {
	return q.currentURL
}

// GetLatestLedger returns the latest ledger sequence from the active RPC URL.
func (q *RPCQuorumClient) GetLatestLedger(ctx context.Context) (uint32, error) {
	return q.doGetLatestLedger(q.currentURL, ctx)
}

// GetEvents queries events from the active RPC URL.
func (q *RPCQuorumClient) GetEvents(ctx context.Context, startLedger uint32, filters []EventFilter) ([]EventItem, uint32, error) {
	return q.doGetEvents(q.currentURL, ctx, startLedger, filters)
}

// doGetLatestLedger performs getLatestLedger RPC call.
func (q *RPCQuorumClient) doGetLatestLedger(url string, ctx context.Context) (uint32, error) {
	reqBody := RPCRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "getLatestLedger",
	}
	jsonBytes, err := json.Marshal(reqBody)
	if err != nil {
		return 0, fmt.Errorf("marshal error: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(jsonBytes))
	if err != nil {
		return 0, fmt.Errorf("create request error: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := q.rpcClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("RPC HTTP error: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, fmt.Errorf("read body error: %w", err)
	}
	var rpcResp RPCResponse
	if err := json.Unmarshal(body, &rpcResp); err != nil {
		return 0, fmt.Errorf("unmarshal error: %w", err)
	}
	if rpcResp.Error != nil {
		return 0, fmt.Errorf("RPC error: %d: %s", rpcResp.Error.Code, rpcResp.Error.Message)
	}
	return rpcResp.Result.LatestLedger, nil
}

// doGetEvents performs getEvents RPC call.
func (q *RPCQuorumClient) doGetEvents(url string, ctx context.Context, startLedger uint32, filters []EventFilter) ([]EventItem, uint32, error) {
	reqBody := RPCRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "getEvents",
		Params: GetEventsParams{
			StartLedger: startLedger,
			Filters:     filters,
		},
	}
	jsonBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, 0, fmt.Errorf("marshal error: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(jsonBytes))
	if err != nil {
		return nil, 0, fmt.Errorf("create request error: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := q.rpcClient.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("RPC HTTP error: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, 0, fmt.Errorf("read body error: %w", err)
	}
	var rpcResp RPCResponse
	if err := json.Unmarshal(body, &rpcResp); err != nil {
		return nil, 0, fmt.Errorf("unmarshal error: %w", err)
	}
	if rpcResp.Error != nil {
		return nil, 0, fmt.Errorf("RPC error: %d: %s", rpcResp.Error.Code, rpcResp.Error.Message)
	}
	return rpcResp.Result.Events, rpcResp.Result.LatestLedger, nil
}

// Failover checks if failover is needed and performs it if necessary.
// Returns the new active URL.
func (q *RPCQuorumClient) Failover(ctx context.Context) string {
	primaryLedger, err := q.doGetLatestLedger(q.primaryURL, ctx)
	if err != nil {
		q.logger.Warn("Primary RPC failed, failing over to secondary", "error", err)
		q.currentURL = q.secondaryURL
		return q.currentURL
	}

	secondaryLedger, err := q.doGetLatestLedger(q.secondaryURL, ctx)
	if err != nil {
		q.logger.Warn("Secondary RPC failed, keeping primary", "error", err)
		return q.currentURL
	}

	diff := int(primaryLedger) - int(secondaryLedger)
	q.logger.Info("RPC quorum probe", "primary", primaryLedger, "secondary", secondaryLedger, "diff", diff)

	if diff > 5 {
		q.logger.Warn("Secondary RPC lagging behind primary", "lag", diff, "threshold", 5)
		q.currentURL = q.secondaryURL
	} else if diff > 0 {
		q.logger.Info("Secondary caught up, failing over to primary", "lag", diff)
		q.currentURL = q.primaryURL
	} else {
		q.logger.Info("Secondary is ahead, using secondary", "lag", diff)
		q.currentURL = q.secondaryURL
	}
	return q.currentURL
}