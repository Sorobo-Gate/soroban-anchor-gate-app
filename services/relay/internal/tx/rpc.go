package tx

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// maxRPCResponseBytes bounds every Soroban RPC response body so a misbehaving
// node cannot exhaust relay memory.
const maxRPCResponseBytes = 2 << 20 // 2 MiB

// RPCError is a JSON-RPC error returned by the Soroban RPC endpoint.
type RPCError struct {
	// Method is the JSON-RPC method that failed.
	Method string
	// Code is the JSON-RPC error code.
	Code int
	// Message is the JSON-RPC error message.
	Message string
}

// Error implements the error interface.
func (e *RPCError) Error() string {
	return fmt.Sprintf("tx: soroban rpc %s failed with code %d: %s", e.Method, e.Code, e.Message)
}

// SorobanRPCClient is a minimal Soroban RPC client implementing the Client
// interface with only the three methods fee bumping requires. It depends only
// on the standard library, in line with the relay's dependency policy.
type SorobanRPCClient struct {
	endpoint   string
	httpClient *http.Client
}

// NewSorobanRPCClient validates endpoint and returns an RPC client. A default
// client with a 10 second timeout is used when httpClient is nil.
func NewSorobanRPCClient(endpoint string, httpClient *http.Client) (*SorobanRPCClient, error) {
	trimmed := strings.TrimSpace(endpoint)
	if trimmed == "" {
		return nil, errors.New("tx: soroban rpc endpoint must not be empty")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return nil, fmt.Errorf("tx: invalid soroban rpc endpoint: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("tx: soroban rpc endpoint must be http(s), got scheme %q", parsed.Scheme)
	}
	if parsed.Host == "" {
		return nil, errors.New("tx: soroban rpc endpoint must include a host")
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	return &SorobanRPCClient{endpoint: trimmed, httpClient: httpClient}, nil
}

// rpcEnvelope is the JSON-RPC 2.0 response envelope.
type rpcEnvelope struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// GetLatestLedger returns the latest closed ledger sequence known to the node.
func (c *SorobanRPCClient) GetLatestLedger(ctx context.Context) (uint32, error) {
	var result struct {
		Sequence uint32 `json:"sequence"`
	}
	if err := c.call(ctx, "getLatestLedger", nil, &result); err != nil {
		return 0, err
	}
	if result.Sequence == 0 {
		return 0, errors.New("tx: getLatestLedger returned an empty ledger sequence")
	}
	return result.Sequence, nil
}

// GetTransaction looks up a transaction hash and maps the RPC status onto an
// InclusionStatus. A transaction the network has never seen is reported as
// InclusionNotFound rather than an error.
func (c *SorobanRPCClient) GetTransaction(ctx context.Context, hash string) (TransactionStatus, error) {
	trimmed := strings.TrimSpace(hash)
	if trimmed == "" {
		return TransactionStatus{}, errors.New("tx: transaction hash must not be empty")
	}

	params := struct {
		Hash string `json:"hash"`
	}{Hash: trimmed}

	var result struct {
		Status   string `json:"status"`
		Ledger   uint32 `json:"ledger"`
		Envelope string `json:"envelopeXdr"`
	}
	if err := c.call(ctx, "getTransaction", params, &result); err != nil {
		var rpcErr *RPCError
		if errors.As(err, &rpcErr) && strings.Contains(strings.ToLower(rpcErr.Message), "not found") {
			return TransactionStatus{Hash: trimmed, Status: InclusionNotFound}, nil
		}
		return TransactionStatus{}, err
	}

	status := InclusionPending
	switch strings.ToUpper(strings.TrimSpace(result.Status)) {
	case "SUCCESS":
		status = InclusionSuccess
	case "FAILED":
		status = InclusionFailed
	case "NOT_FOUND":
		status = InclusionNotFound
	}

	return TransactionStatus{
		Hash:   trimmed,
		Status: status,
		Ledger: result.Ledger,
	}, nil
}

// SendTransaction submits a base64 TransactionEnvelope. RPC rejections are
// surfaced as SendError results; only transport and decode failures return an
// error.
func (c *SorobanRPCClient) SendTransaction(ctx context.Context, envelopeXDR string) (SendResult, error) {
	if strings.TrimSpace(envelopeXDR) == "" {
		return SendResult{}, errors.New("tx: transaction envelope XDR must not be empty")
	}

	params := struct {
		Transaction string `json:"transaction"`
	}{Transaction: envelopeXDR}

	var result struct {
		Status         string `json:"status"`
		Hash           string `json:"hash"`
		ErrorResultXDR string `json:"errorResultXdr"`
	}
	if err := c.call(ctx, "sendTransaction", params, &result); err != nil {
		return SendResult{}, err
	}

	status := SendStatus(strings.ToUpper(strings.TrimSpace(result.Status)))
	switch status {
	case SendPending, SendDuplicate, SendTryAgainLater, SendError:
	default:
		status = SendTryAgainLater
	}

	return SendResult{
		Hash:           strings.ToLower(strings.TrimSpace(result.Hash)),
		Status:         status,
		ErrorResultXDR: result.ErrorResultXDR,
	}, nil
}

// call performs a single JSON-RPC request and unmarshals the result into out.
func (c *SorobanRPCClient) call(ctx context.Context, method string, params interface{}, out interface{}) error {
	request := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  method,
	}
	if params != nil {
		request["params"] = params
	}

	body, err := json.Marshal(request)
	if err != nil {
		return fmt.Errorf("tx: failed to encode %s request: %w", method, err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("tx: failed to build %s request: %w", method, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("tx: %s request failed: %w", method, err)
	}
	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxRPCResponseBytes))
	if err != nil {
		return fmt.Errorf("tx: failed to read %s response: %w", method, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("tx: %s returned HTTP %d: %s", method, resp.StatusCode, strings.TrimSpace(string(raw)))
	}

	var envelope rpcEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("tx: failed to decode %s response: %w", method, err)
	}
	if envelope.Error != nil {
		return &RPCError{Method: method, Code: envelope.Error.Code, Message: envelope.Error.Message}
	}
	if out == nil {
		return nil
	}
	if len(envelope.Result) == 0 {
		return fmt.Errorf("tx: %s response did not include a result", method)
	}
	if err := json.Unmarshal(envelope.Result, out); err != nil {
		return fmt.Errorf("tx: failed to decode %s result: %w", method, err)
	}
	return nil
}
