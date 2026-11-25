package tx

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNewSorobanRPCClientValidation(t *testing.T) {
	tests := []struct {
		name     string
		endpoint string
		wantErr  bool
	}{
		{name: "empty", endpoint: "", wantErr: true},
		{name: "no scheme", endpoint: "soroban-testnet.stellar.org", wantErr: true},
		{name: "unsupported scheme", endpoint: "ftp://example.com", wantErr: true},
		{name: "no host", endpoint: "https://", wantErr: true},
		{name: "valid https", endpoint: "https://soroban-testnet.stellar.org", wantErr: false},
		{name: "valid http", endpoint: "http://localhost:8000", wantErr: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client, err := NewSorobanRPCClient(tt.endpoint, nil)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected an error, got nil")
				}
				if client != nil {
					t.Fatal("expected no client on error")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if client == nil || client.httpClient == nil {
				t.Fatal("expected a configured client with a default HTTP client")
			}
		})
	}
}

func TestGetLatestLedger(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"sequence":5069983}}`))
	}))
	defer server.Close()

	client, err := NewSorobanRPCClient(server.URL, nil)
	if err != nil {
		t.Fatalf("NewSorobanRPCClient: %v", err)
	}
	sequence, err := client.GetLatestLedger(context.Background())
	if err != nil {
		t.Fatalf("GetLatestLedger: %v", err)
	}
	if sequence != 5069983 {
		t.Fatalf("sequence = %d, want 5069983", sequence)
	}
}

func TestGetLatestLedgerEmptySequence(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"sequence":0}}`))
	}))
	defer server.Close()

	client, _ := NewSorobanRPCClient(server.URL, nil)
	if _, err := client.GetLatestLedger(context.Background()); err == nil {
		t.Fatal("expected an error for an empty ledger sequence")
	}
}

func TestGetTransactionStatuses(t *testing.T) {
	tests := []struct {
		name       string
		response   string
		wantStatus InclusionStatus
		wantLedger uint32
		wantErr    bool
	}{
		{
			name:       "success",
			response:   `{"jsonrpc":"2.0","id":1,"result":{"status":"SUCCESS","ledger":5069983}}`,
			wantStatus: InclusionSuccess,
			wantLedger: 5069983,
		},
		{
			name:       "failed",
			response:   `{"jsonrpc":"2.0","id":1,"result":{"status":"FAILED","ledger":5069984}}`,
			wantStatus: InclusionFailed,
			wantLedger: 5069984,
		},
		{
			name:       "not found result",
			response:   `{"jsonrpc":"2.0","id":1,"result":{"status":"NOT_FOUND"}}`,
			wantStatus: InclusionNotFound,
		},
		{
			name:       "unknown status is pending",
			response:   `{"jsonrpc":"2.0","id":1,"result":{"status":""}}`,
			wantStatus: InclusionPending,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(tt.response))
			}))
			defer server.Close()

			client, _ := NewSorobanRPCClient(server.URL, nil)
			status, err := client.GetTransaction(context.Background(), hashA)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected an error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("GetTransaction: %v", err)
			}
			if status.Status != tt.wantStatus {
				t.Fatalf("status = %s, want %s", status.Status, tt.wantStatus)
			}
			if status.Ledger != tt.wantLedger {
				t.Fatalf("ledger = %d, want %d", status.Ledger, tt.wantLedger)
			}
		})
	}
}

func TestGetTransactionNotFoundRPCError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"transaction not found"}}`))
	}))
	defer server.Close()

	client, _ := NewSorobanRPCClient(server.URL, nil)
	status, err := client.GetTransaction(context.Background(), hashA)
	if err != nil {
		t.Fatalf("expected a not-found status rather than an error, got %v", err)
	}
	if status.Status != InclusionNotFound {
		t.Fatalf("status = %s, want %s", status.Status, InclusionNotFound)
	}
}

func TestGetTransactionOtherRPCError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"internal error"}}`))
	}))
	defer server.Close()

	client, _ := NewSorobanRPCClient(server.URL, nil)
	_, err := client.GetTransaction(context.Background(), hashA)
	if err == nil {
		t.Fatal("expected an RPC error")
	}
	var rpcErr *RPCError
	if !errors.As(err, &rpcErr) {
		t.Fatalf("expected *RPCError, got %T", err)
	}
	if rpcErr.Code != -32000 || rpcErr.Method != "getTransaction" {
		t.Fatalf("unexpected RPC error: %+v", rpcErr)
	}
	if !strings.Contains(rpcErr.Error(), "internal error") {
		t.Fatalf("error message missing RPC detail: %s", rpcErr.Error())
	}
}

func TestSendTransaction(t *testing.T) {
	tests := []struct {
		name       string
		response   string
		wantStatus SendStatus
		wantHash   string
	}{
		{
			name:       "pending",
			response:   `{"jsonrpc":"2.0","id":1,"result":{"status":"PENDING","hash":"` + hashA + `"}}`,
			wantStatus: SendPending,
			wantHash:   hashA,
		},
		{
			name:       "duplicate",
			response:   `{"jsonrpc":"2.0","id":1,"result":{"status":"DUPLICATE","hash":"` + hashA + `"}}`,
			wantStatus: SendDuplicate,
			wantHash:   hashA,
		},
		{
			name:       "error",
			response:   `{"jsonrpc":"2.0","id":1,"result":{"status":"ERROR","hash":"` + hashA + `","errorResultXdr":"AAAA"}}`,
			wantStatus: SendError,
			wantHash:   hashA,
		},
		{
			name:       "unknown status becomes retry",
			response:   `{"jsonrpc":"2.0","id":1,"result":{"status":"SOMETHING_NEW"}}`,
			wantStatus: SendTryAgainLater,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(tt.response))
			}))
			defer server.Close()

			client, _ := NewSorobanRPCClient(server.URL, nil)
			result, err := client.SendTransaction(context.Background(), "AAAA")
			if err != nil {
				t.Fatalf("SendTransaction: %v", err)
			}
			if result.Status != tt.wantStatus {
				t.Fatalf("status = %s, want %s", result.Status, tt.wantStatus)
			}
			if result.Hash != tt.wantHash {
				t.Fatalf("hash = %s, want %s", result.Hash, tt.wantHash)
			}
		})
	}
}

func TestSendTransactionRejectsEmptyEnvelope(t *testing.T) {
	client, _ := NewSorobanRPCClient("https://soroban-testnet.stellar.org", nil)
	if _, err := client.SendTransaction(context.Background(), "  "); err == nil {
		t.Fatal("expected an error for an empty envelope")
	}
}

func TestRPCTransportFailures(t *testing.T) {
	t.Run("http error status", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte("bad gateway"))
		}))
		defer server.Close()

		client, _ := NewSorobanRPCClient(server.URL, nil)
		if _, err := client.GetLatestLedger(context.Background()); err == nil {
			t.Fatal("expected an error for a non-2xx response")
		}
	})

	t.Run("malformed json", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{not json`))
		}))
		defer server.Close()

		client, _ := NewSorobanRPCClient(server.URL, nil)
		if _, err := client.GetLatestLedger(context.Background()); err == nil {
			t.Fatal("expected an error for a malformed JSON response")
		}
	})

	t.Run("missing result", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1}`))
		}))
		defer server.Close()

		client, _ := NewSorobanRPCClient(server.URL, nil)
		if _, err := client.GetLatestLedger(context.Background()); err == nil {
			t.Fatal("expected an error for a response without a result")
		}
	})
}
