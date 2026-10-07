package listener

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"strconv"
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

				if err := s.store.RecordObserved(payload.EventID); err != nil {
					s.logger.Debug("Event already observed", "event_id", payload.EventID, "error", err)
				}

				if err := s.store.ClaimForProcessing(payload.EventID); err != nil {
					s.logger.Warn("Failed to claim event for processing", "event_id", payload.EventID, "error", err)
					continue
				}

				select {
				case eventChan <- payload:
					s.logger.Info("Disbursed event claimed and emitted to processing channel", "event_id", payload.EventID, "escrow_id", payload.EscrowID, "amount", payload.PayoutAmount.String())
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
					Topics: [][]string{
						{"AAAADwAAAAlkaXNidXJzZWQAAAA=", "*"},
					},
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

	if !item.InSuccessfulContractCall {
		return EventPayload{}, fmt.Errorf("event from failed contract call")
	}

	if len(item.Topic) < 2 {
		return EventPayload{}, fmt.Errorf("insufficient event topics: expected at least symbol and escrow_id, got %d", len(item.Topic))
	}

	// 1. Topic 0: symbol "disbursed"
	sym, err := decodeSymbolTopic(item.Topic[0])
	if err != nil {
		return EventPayload{}, fmt.Errorf("failed to decode topic symbol: %w", err)
	}
	if sym != "disbursed" {
		return EventPayload{}, fmt.Errorf("event topic symbol mismatch: expected 'disbursed', got '%s'", sym)
	}

	// 2. Topic 1: escrow_id (u64)
	escrowID, err := decodeEscrowIDTopic(item.Topic[1])
	if err != nil {
		return EventPayload{}, fmt.Errorf("failed to decode escrow ID: %w", err)
	}

	// 3. Value: ScVal tuple (profile_hash: BytesN<32>, payout_amount: i128)
	if item.Value.XDR == "" {
		return EventPayload{}, fmt.Errorf("missing value XDR payload in event item")
	}

	valBytes, err := base64.StdEncoding.DecodeString(item.Value.XDR)
	if err != nil {
		return EventPayload{}, fmt.Errorf("invalid base64 in value XDR: %w", err)
	}

	profileHashHex, payoutAmount, err := decodeDisbursedValueXDR(valBytes)
	if err != nil {
		return EventPayload{}, fmt.Errorf("malformed disbursed value XDR: %w", err)
	}

	if len(profileHashHex) != 64 {
		return EventPayload{}, fmt.Errorf("invalid profile hash length: expected 64 hex chars (32 bytes), got %d", len(profileHashHex))
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

func decodeSymbolTopic(topicStr string) (string, error) {
	if topicStr == "disbursed" {
		return "disbursed", nil
	}

	data, err := base64.StdEncoding.DecodeString(topicStr)
	if err != nil {
		return topicStr, nil
	}

	if len(data) < 8 {
		return "", fmt.Errorf("symbol XDR too short: %d bytes", len(data))
	}

	discriminator := binary.BigEndian.Uint32(data[0:4])
	if discriminator != 15 && discriminator != 14 { // ScvSymbol = 15, ScvString = 14
		return "", fmt.Errorf("unexpected discriminator for symbol: %d", discriminator)
	}

	strLen := int(binary.BigEndian.Uint32(data[4:8]))
	if len(data) < 8+strLen {
		return "", fmt.Errorf("symbol XDR string truncated: declared %d, available %d", strLen, len(data)-8)
	}

	return string(data[8 : 8+strLen]), nil
}

func decodeEscrowIDTopic(topicStr string) (uint64, error) {
	data, err := base64.StdEncoding.DecodeString(topicStr)
	if err != nil || len(data) < 4 {
		// Fallback to plain decimal string parsing
		val, parseErr := strconv.ParseUint(topicStr, 10, 64)
		if parseErr != nil {
			return 0, fmt.Errorf("invalid escrow_id topic format: %w", parseErr)
		}
		return val, nil
	}

	discriminator := binary.BigEndian.Uint32(data[0:4])
	switch discriminator {
	case 5: // ScvU64
		if len(data) < 12 {
			return 0, fmt.Errorf("truncated ScvU64 topic: %d bytes", len(data))
		}
		return binary.BigEndian.Uint64(data[4:12]), nil
	case 3: // ScvU32
		if len(data) < 8 {
			return 0, fmt.Errorf("truncated ScvU32 topic: %d bytes", len(data))
		}
		return uint64(binary.BigEndian.Uint32(data[4:8])), nil
	default:
		// Attempt numeric parse on string
		val, parseErr := strconv.ParseUint(topicStr, 10, 64)
		if parseErr == nil {
			return val, nil
		}
		return 0, fmt.Errorf("unsupported ScVal discriminator for escrow_id: %d", discriminator)
	}
}

func decodeDisbursedValueXDR(data []byte) (string, *big.Int, error) {
	// Must be ScvVec (discriminator 16) with 2 elements: [BytesN<32>, i128]
	if len(data) < 12 {
		return "", nil, fmt.Errorf("XDR payload too short: %d bytes", len(data))
	}

	discriminator := binary.BigEndian.Uint32(data[0:4])
	if discriminator != 16 {
		return "", nil, fmt.Errorf("expected ScvVec discriminator (16), got %d", discriminator)
	}

	hasVec := binary.BigEndian.Uint32(data[4:8])
	if hasVec == 0 {
		return "", nil, fmt.Errorf("empty ScvVec payload")
	}

	numElements := binary.BigEndian.Uint32(data[8:12])
	if numElements != 2 {
		return "", nil, fmt.Errorf("expected 2 elements in disbursed tuple, got %d", numElements)
	}

	offset := 12
	// Element 0: BytesN<32> (ScvBytes, discriminator 13)
	if len(data) < offset+8 {
		return "", nil, fmt.Errorf("truncated ScvBytes header")
	}

	elem0Disc := binary.BigEndian.Uint32(data[offset : offset+4])
	if elem0Disc != 13 {
		return "", nil, fmt.Errorf("expected ScvBytes discriminator (13) for profile_hash, got %d", elem0Disc)
	}
	offset += 4

	bytesLen := int(binary.BigEndian.Uint32(data[offset : offset+4]))
	offset += 4

	if bytesLen != 32 {
		return "", nil, fmt.Errorf("expected exactly 32 bytes for profile_hash, got %d", bytesLen)
	}

	if len(data) < offset+bytesLen {
		return "", nil, fmt.Errorf("truncated profile_hash bytes: expected %d, got %d", bytesLen, len(data)-offset)
	}

	profileHash := hex.EncodeToString(data[offset : offset+bytesLen])
	offset += bytesLen
	// XDR 4-byte padding
	if rem := bytesLen % 4; rem != 0 {
		offset += (4 - rem)
	}

	// Element 1: i128 (ScvI128, discriminator 10) or u128 (discriminator 9)
	if len(data) < offset+4 {
		return "", nil, fmt.Errorf("truncated ScvI128 header")
	}

	elem1Disc := binary.BigEndian.Uint32(data[offset : offset+4])
	offset += 4

	if elem1Disc != 10 && elem1Disc != 9 {
		return "", nil, fmt.Errorf("expected ScvI128 (10) or ScvU128 (9) for payout_amount, got %d", elem1Disc)
	}

	if len(data) < offset+16 {
		return "", nil, fmt.Errorf("truncated 128-bit integer bytes: expected 16, got %d", len(data)-offset)
	}

	intBytes := data[offset : offset+16]

	// Check sign bit for ScvI128
	if elem1Disc == 10 && (intBytes[0]&0x80) != 0 {
		return "", nil, fmt.Errorf("payout amount is negative (two's complement sign bit set)")
	}

	payoutAmount := new(big.Int).SetBytes(intBytes)
	return profileHash, payoutAmount, nil
}
