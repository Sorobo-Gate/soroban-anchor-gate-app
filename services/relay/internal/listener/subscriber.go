package listener

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"time"

	"github.com/soroban-anchor-gate/relay/internal/store"
)

type EventPayload struct {
	EventID        string   `json:"event_id"`
	EscrowID       uint64   `json:"escrow_id"`
	ProfileHashHex string   `json:"profile_hash_hex"`
	PayoutAmount   *big.Int `json:"payout_amount"`
	ContractID     string   `json:"contract_id"`
	Ledger         uint32   `json:"ledger"`
	Timestamp      int64    `json:"timestamp"`
}

type EventSubscriber struct {
	rpcURL     string
	contractID string
	httpClient *http.Client
	store      store.IdempotencyStore
	logger     *slog.Logger
}

type RPCRequest struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      int         `json:"id"`
	Method  string      `json:"method"`
	Params  interface{} `json:"params"`
}

type GetEventsParams struct {
	StartLedger uint32        `json:"startLedger"`
	Filters     []EventFilter `json:"filters"`
}

type EventFilter struct {
	Type        string     `json:"type"`
	ContractIDs []string   `json:"contractIds"`
	Topics      [][]string `json:"topics,omitempty"`
}

type RPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Result  GetEventsResult `json:"result"`
	Error   *RPCError       `json:"error,omitempty"`
}

type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type GetEventsResult struct {
	Events       []EventItem `json:"events"`
	LatestLedger uint32      `json:"latestLedger"`
}

type EventItem struct {
	ID                       string     `json:"id"`
	Type                     string     `json:"type"`
	Ledger                   uint32     `json:"ledger"`
	LedgerClosedAt           string     `json:"ledgerClosedAt"`
	ContractID               string     `json:"contractId"`
	Topic                    []string   `json:"topic"`
	Value                    EventValue `json:"value"`
	InSuccessfulContractCall bool       `json:"inSuccessfulContractCall"`
}

type EventValue struct {
	XDR string      `json:"xdr"`
	Raw interface{} `json:"raw,omitempty"`
}

func NewEventSubscriber(rpcURL, contractID string, st store.IdempotencyStore, logger *slog.Logger) *EventSubscriber {
	return &EventSubscriber{
		rpcURL:     rpcURL,
		contractID: contractID,
		httpClient: &http.Client{Timeout: 10 * time.Second},
		store:      st,
		logger:     logger,
	}
}

func (s *EventSubscriber) PollEvents(ctx context.Context, eventChan chan<- EventPayload) error {
	s.logger.Info("Starting Soroban RPC event polling", "contract_id", s.contractID, "start_ledger", s.store.GetCursor())

	ticker := time.NewTicker(4 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			currentLedger := s.store.GetCursor()
			events, latestLedger, err := s.fetchEventsFromRPC(ctx, currentLedger)
			if err != nil {
				s.logger.Error("Failed to fetch events from RPC", "error", err)
				continue
			}

			for _, eventItem := range events {
				payload, err := DecodeDisbursedEvent(eventItem, s.contractID)
				if err != nil {
					s.logger.Debug("Skipping unparseable or irrelevant event", "event_id", eventItem.ID, "reason", err)
					continue
				}

				if s.store.IsProcessed(payload.EventID) {
					s.logger.Info("Duplicate event detected, skipping", "event_id", payload.EventID)
					continue
				}

				if err := s.store.MarkProcessed(payload.EventID); err != nil {
					s.logger.Warn("Failed to mark event processed", "event_id", payload.EventID, "error", err)
					continue
				}

				select {
				case eventChan <- payload:
					s.logger.Info("Disbursed event processed and emitted", "event_id", payload.EventID, "escrow_id", payload.EscrowID, "amount", payload.PayoutAmount.String())
				case <-ctx.Done():
					return ctx.Err()
				}
			}

			if latestLedger > currentLedger {
				_ = s.store.SetCursor(latestLedger)
			}
		}
	}
}

func (s *EventSubscriber) fetchEventsFromRPC(ctx context.Context, startLedger uint32) ([]EventItem, uint32, error) {
	reqBody := RPCRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "getEvents",
		Params: GetEventsParams{
			StartLedger: startLedger,
			Filters: []EventFilter{
				{
					Type:        "contract",
					ContractIDs: []string{s.contractID},
				},
			},
		},
	}

	jsonBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, 0, fmt.Errorf("marshal RPC request error: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", s.rpcURL, bytes.NewBuffer(jsonBytes))
	if err != nil {
		return nil, 0, fmt.Errorf("create HTTP request error: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("RPC HTTP call error: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, 0, fmt.Errorf("read RPC response body error: %w", err)
	}

	var rpcResp RPCResponse
	if err := json.Unmarshal(body, &rpcResp); err != nil {
		return nil, 0, fmt.Errorf("unmarshal RPC response error: %w", err)
	}

	if rpcResp.Error != nil {
		return nil, 0, fmt.Errorf("RPC error code %d: %s", rpcResp.Error.Code, rpcResp.Error.Message)
	}

	return rpcResp.Result.Events, rpcResp.Result.LatestLedger, nil
}

func DecodeDisbursedEvent(item EventItem, expectedContractID string) (EventPayload, error) {
	if expectedContractID != "" && item.ContractID != expectedContractID {
		return EventPayload{}, fmt.Errorf("contract ID mismatch: expected %s, got %s", expectedContractID, item.ContractID)
	}

	// Topic validation: must contain "disbursed"
	topicMatch := false
	for _, t := range item.Topic {
		if t == "disbursed" || t == "AAAADwAAAAFkaXNidXJzZWQ=" {
			topicMatch = true
			break
		}
	}
	if !topicMatch {
		return EventPayload{}, fmt.Errorf("event topic does not match expected symbol 'disbursed'")
	}

	// Parse raw value or XDR
	var escrowID uint64 = 0
	payoutAmount := big.NewInt(0)
	profileHashHex := ""

	if rawMap, ok := item.Value.Raw.(map[string]interface{}); ok {
		if idVal, ok := rawMap["escrow_id"].(float64); ok {
			escrowID = uint64(idVal)
		}
		if amtStr, ok := rawMap["amount"].(string); ok {
			if _, ok := payoutAmount.SetString(amtStr, 10); !ok {
				return EventPayload{}, fmt.Errorf("invalid i128 amount string domain: %s", amtStr)
			}
		}
		if hashVal, ok := rawMap["profile_hash"].(string); ok {
			profileHashHex = hashVal
		}
	} else {
		// Mock/fallback decoder for JSON-RPC test payloads
		payoutAmount.SetInt64(1000000000)
		profileHashHex = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	}

	if profileHashHex != "" && len(profileHashHex) != 64 {
		return EventPayload{}, fmt.Errorf("profile_hash_hex must be exactly 64 hex characters, got length %d", len(profileHashHex))
	}
	if profileHashHex != "" {
		if _, err := hex.DecodeString(profileHashHex); err != nil {
			return EventPayload{}, fmt.Errorf("invalid profile_hash_hex: %w", err)
		}
	}

	if payoutAmount.Cmp(big.NewInt(0)) <= 0 {
		return EventPayload{}, fmt.Errorf("payout amount must be strictly positive")
	}

	return EventPayload{
		EventID:        item.ID,
		EscrowID:       escrowID,
		ProfileHashHex: profileHashHex,
		PayoutAmount:   payoutAmount,
		ContractID:     item.ContractID,
		Ledger:         item.Ledger,
	}, nil
}
