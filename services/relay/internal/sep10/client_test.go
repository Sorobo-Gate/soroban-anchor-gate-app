package sep10

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSEP10_SuccessfulHandshake(t *testing.T) {
	mockChallengeXDR := "AAAAAGNoYWxsZW5nZV94ZHJfc2FtcGxl"
	mockSignedXDR := "AAAAAHNpZ25lZF9jaGFsbGVuZ2VfeGRy"
	expectedJWT := "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.testpayload.signature"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			account := r.URL.Query().Get("account")
			if account != "GCHIAK3LLDWJ5N4Z4TH6GHCH2LQX5SUL2WEU42I324CFXGDUWXMNNSDZ" {
				http.Error(w, `{"error":"invalid account"}`, http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(ChallengeResponse{
				Transaction: mockChallengeXDR,
			})
			return
		}

		if r.Method == http.MethodPost {
			var req map[string]string
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, `{"error":"malformed body"}`, http.StatusBadRequest)
				return
			}
			if req["transaction"] != mockSignedXDR {
				http.Error(w, `{"error":"invalid signature"}`, http.StatusForbidden)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(TokenResponse{
				Token: expectedJWT,
			})
			return
		}

		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}))
	defer server.Close()

	signer := func(challengeXDR string) (string, error) {
		if challengeXDR != mockChallengeXDR {
			t.Fatalf("unexpected challenge XDR received by signer: %s", challengeXDR)
		}
		return mockSignedXDR, nil
	}

	client := NewAuthClient(
		server.URL,
		"GCHIAK3LLDWJ5N4Z4TH6GHCH2LQX5SUL2WEU42I324CFXGDUWXMNNSDZ",
		signer,
		server.Client(),
	)

	ctx := context.Background()

	// 1. Initial authentication
	token, err := client.Authenticate(ctx)
	if err != nil {
		t.Fatalf("expected successful authentication, got: %v", err)
	}
	if token != expectedJWT {
		t.Fatalf("expected token %s, got %s", expectedJWT, token)
	}

	// 2. Cached token retrieval
	cachedToken, err := client.GetValidToken(ctx)
	if err != nil {
		t.Fatalf("expected valid cached token, got: %v", err)
	}
	if cachedToken != expectedJWT {
		t.Fatalf("expected cached token %s, got %s", expectedJWT, cachedToken)
	}
}

func TestSEP10_ChallengeRequestError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"account not found on ledger"}`, http.StatusNotFound)
	}))
	defer server.Close()

	client := NewAuthClient(
		server.URL,
		"GUNKNOWNACCOUNT",
		func(string) (string, error) { return "signed", nil },
		server.Client(),
	)

	_, err := client.Authenticate(context.Background())
	if err == nil {
		t.Fatal("expected error from failed challenge request, got nil")
	}
}

func TestSEP10_TokenExchangeRejected(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			json.NewEncoder(w).Encode(ChallengeResponse{
				Transaction: "mock_challenge",
			})
			return
		}
		http.Error(w, `{"error":"invalid challenge signature"}`, http.StatusForbidden)
	}))
	defer server.Close()

	client := NewAuthClient(
		server.URL,
		"GTESTACCOUNT",
		func(string) (string, error) { return "bad_signature", nil },
		server.Client(),
	)

	_, err := client.Authenticate(context.Background())
	if err == nil {
		t.Fatal("expected error from rejected token exchange, got nil")
	}
}

func TestSEP10_ExpiredTokenTriggersReauth(t *testing.T) {
	callCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		if r.Method == http.MethodGet {
			json.NewEncoder(w).Encode(ChallengeResponse{
				Transaction: "mock_challenge",
			})
			return
		}
		json.NewEncoder(w).Encode(TokenResponse{
			Token: "new_jwt_token",
		})
	}))
	defer server.Close()

	client := NewAuthClient(
		server.URL,
		"GTESTACCOUNT",
		func(string) (string, error) { return "mock_signed", nil },
		server.Client(),
	)

	// Simulate expired token in cache
	client.jwtToken = "old_expired_token"
	client.expiresAt = time.Now().Add(-10 * time.Minute)

	token, err := client.GetValidToken(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token != "new_jwt_token" {
		t.Fatalf("expected new token, got: %s", token)
	}
	if callCount < 2 {
		t.Fatalf("expected re-authentication HTTP calls, got count %d", callCount)
	}
}
