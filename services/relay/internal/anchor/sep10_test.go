package anchor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/soroban-anchor-gate/relay/internal/signer"
)

func TestSEP10_ValidChallengeAndTokenExchange(t *testing.T) {
	keyMgr, err := signer.GenerateEphemeralKeyManager()
	if err != nil {
		t.Fatalf("failed to create ephemeral key manager: %v", err)
	}

	validMinTime := time.Now().Add(-5 * time.Minute).Unix()
	validMaxTime := time.Now().Add(15 * time.Minute).Unix()
	mockChallengeXDR := BuildMockChallengeXDR(validMinTime, validMaxTime)

	expectedTokenExpiry := time.Now().Add(2 * time.Hour)
	mockJWT := BuildMockJWT(expectedTokenExpiry)

	var authCalls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&authCalls, 1)

		if r.Method == http.MethodGet {
			account := r.URL.Query().Get("account")
			if account != "GCLIENTRELAYACCOUNT123" {
				http.Error(w, `{"error":"unknown account"}`, http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(ChallengeResponse{
				Transaction: mockChallengeXDR,
			})
			return
		}

		if r.Method == http.MethodPost {
			var req map[string]string
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
				return
			}
			signedXDR := req["transaction"]
			if signedXDR == "" {
				http.Error(w, `{"error":"missing transaction"}`, http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{
				"token": mockJWT,
			})
			return
		}

		http.Error(w, "not allowed", http.StatusMethodNotAllowed)
	}))
	defer server.Close()

	client := NewSEP10Client(
		server.URL,
		"GSERVERANCHOR123",
		"GCLIENTRELAYACCOUNT123",
		keyMgr,
		server.Client(),
	)

	ctx := context.Background()

	// 1. Initial authentication
	token, err := client.Authenticate(ctx)
	if err != nil {
		t.Fatalf("Authenticate() failed: %v", err)
	}
	if token != mockJWT {
		t.Fatalf("expected token %s, got %s", mockJWT, token)
	}

	// 2. Cached retrieval should NOT invoke HTTP calls
	cachedToken, err := client.GetValidToken(ctx)
	if err != nil {
		t.Fatalf("GetValidToken() failed: %v", err)
	}
	if cachedToken != mockJWT {
		t.Fatalf("expected cached token %s, got %s", mockJWT, cachedToken)
	}
	if atomic.LoadInt32(&authCalls) != 2 { // 1 GET + 1 POST
		t.Fatalf("expected 2 HTTP calls (GET+POST), got %d", atomic.LoadInt32(&authCalls))
	}
}

func TestSEP10_AutomaticRenewalFiveMinutesPriorToExpiry(t *testing.T) {
	keyMgr, err := signer.GenerateEphemeralKeyManager()
	if err != nil {
		t.Fatalf("failed to create key manager: %v", err)
	}

	validMinTime := time.Now().Add(-5 * time.Minute).Unix()
	validMaxTime := time.Now().Add(15 * time.Minute).Unix()
	mockChallengeXDR := BuildMockChallengeXDR(validMinTime, validMaxTime)

	var requestCount int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requestCount, 1)
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(ChallengeResponse{Transaction: mockChallengeXDR})
			return
		}
		// Return fresh token valid for 1 hour
		freshJWT := BuildMockJWT(time.Now().Add(1 * time.Hour))
		_ = json.NewEncoder(w).Encode(map[string]string{"token": freshJWT})
	}))
	defer server.Close()

	client := NewSEP10Client(
		server.URL,
		"GSERVERANCHOR123",
		"GCLIENTRELAYACCOUNT123",
		keyMgr,
		server.Client(),
	)

	ctx := context.Background()

	// Case 1: Token expiring in 10 minutes (margin > 5 min): should return cached token without renewal
	client.mu.Lock()
	client.jwtToken = "cached_token_valid_10_min"
	client.expiresAt = time.Now().Add(10 * time.Minute)
	client.mu.Unlock()

	tok, err := client.GetValidToken(ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tok != "cached_token_valid_10_min" {
		t.Fatalf("expected cached token, got: %s", tok)
	}
	if atomic.LoadInt32(&requestCount) != 0 {
		t.Fatalf("expected 0 HTTP calls, got %d", atomic.LoadInt32(&requestCount))
	}

	// Case 2: Token expiring in 4 minutes (margin < 5 min): must trigger automatic renewal
	client.mu.Lock()
	client.jwtToken = "cached_token_expiring_soon"
	client.expiresAt = time.Now().Add(4 * time.Minute)
	client.mu.Unlock()

	renewedTok, err := client.GetValidToken(ctx)
	if err != nil {
		t.Fatalf("GetValidToken renewal failed: %v", err)
	}
	if renewedTok == "cached_token_expiring_soon" {
		t.Fatal("expected fresh renewed token, but got old expiring token")
	}
	if atomic.LoadInt32(&requestCount) != 2 { // 1 GET + 1 POST
		t.Fatalf("expected 2 HTTP calls for automatic renewal, got %d", atomic.LoadInt32(&requestCount))
	}
}

func TestSEP10_ExpiredChallengeTransaction(t *testing.T) {
	keyMgr, err := signer.GenerateEphemeralKeyManager()
	if err != nil {
		t.Fatalf("failed to create key manager: %v", err)
	}

	// MaxTime set 10 minutes in the past
	expiredMinTime := time.Now().Add(-30 * time.Minute).Unix()
	expiredMaxTime := time.Now().Add(-10 * time.Minute).Unix()
	expiredChallengeXDR := BuildMockChallengeXDR(expiredMinTime, expiredMaxTime)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ChallengeResponse{
			Transaction: expiredChallengeXDR,
		})
	}))
	defer server.Close()

	client := NewSEP10Client(
		server.URL,
		"GSERVERANCHOR123",
		"GCLIENTRELAYACCOUNT123",
		keyMgr,
		server.Client(),
	)

	_, err = client.Authenticate(context.Background())
	if err == nil {
		t.Fatal("expected error for expired challenge transaction, got nil")
	}
	if !errors.Is(err, ErrChallengeExpired) && !strings.Contains(err.Error(), "expired") {
		t.Fatalf("expected ErrChallengeExpired, got: %v", err)
	}
}

func TestSEP10_MalformedChallengeTransaction(t *testing.T) {
	keyMgr, err := signer.GenerateEphemeralKeyManager()
	if err != nil {
		t.Fatalf("failed to create key manager: %v", err)
	}

	client := NewSEP10Client(
		"http://localhost:8080",
		"GSERVERANCHOR123",
		"GCLIENTRELAYACCOUNT123",
		keyMgr,
		nil,
	)

	// Subtest 1: Invalid Base64
	_, err = client.ParseAndValidateChallenge("not_valid_base64!!!")
	if err == nil || !errors.Is(err, ErrMalformedChallenge) {
		t.Fatalf("expected ErrMalformedChallenge for invalid base64, got %v", err)
	}

	// Subtest 2: Truncated payload
	_, err = client.ParseAndValidateChallenge("AAAA")
	if err == nil || !errors.Is(err, ErrMalformedChallenge) {
		t.Fatalf("expected ErrMalformedChallenge for truncated payload, got %v", err)
	}
}

func TestSEP10_FetchAnchorTOML(t *testing.T) {
	mockTOML := `
# Stellar Anchor Configuration
NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"
SIGNING_KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
WEB_AUTH_ENDPOINT = "https://anchor.example.com/auth"
TRANSFER_SERVER_SEP0024 = "https://anchor.example.com/sep24"
ANCHOR_QUOTE_SERVER = "https://anchor.example.com/sep38"
`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/.well-known/stellar.toml" {
			w.Header().Set("Content-Type", "text/plain")
			fmt.Fprint(w, mockTOML)
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	toml, err := FetchAnchorTOML(context.Background(), server.Client(), server.URL)
	if err != nil {
		t.Fatalf("FetchAnchorTOML failed: %v", err)
	}

	if toml.WebAuthEndpoint != "https://anchor.example.com/auth" {
		t.Errorf("unexpected WebAuthEndpoint: %s", toml.WebAuthEndpoint)
	}
	if toml.SigningKey != "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" {
		t.Errorf("unexpected SigningKey: %s", toml.SigningKey)
	}
	if toml.NetworkPassphrase != "Test SDF Network ; September 2015" {
		t.Errorf("unexpected NetworkPassphrase: %s", toml.NetworkPassphrase)
	}
	if toml.TransferServerSEP24 != "https://anchor.example.com/sep24" {
		t.Errorf("unexpected TransferServerSEP24: %s", toml.TransferServerSEP24)
	}
}
