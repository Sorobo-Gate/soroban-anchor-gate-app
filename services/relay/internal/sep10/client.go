package sep10

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// ChallengeSigner defines the function signature for signing a challenge transaction XDR.
type ChallengeSigner func(challengeXDR string) (signedXDR string, err error)

// AuthClient manages programmatic SEP-10 authentication handshakes and JWT caching.
type AuthClient struct {
	authEndpoint  string
	clientAccount string
	signer        ChallengeSigner
	httpClient    *http.Client

	mu        sync.RWMutex
	jwtToken  string
	expiresAt time.Time
}

// ChallengeResponse holds the JSON response returned by the anchor's SEP-10 auth endpoint.
type ChallengeResponse struct {
	Transaction string `json:"transaction"`
	NetworkPass string `json:"network_passphrase,omitempty"`
	Error       string `json:"error,omitempty"`
}

// TokenResponse holds the JWT token returned by the anchor upon successful challenge submission.
type TokenResponse struct {
	Token string `json:"token"`
	Error string `json:"error,omitempty"`
}

// NewAuthClient creates a new SEP-10 authentication client.
func NewAuthClient(authEndpoint, clientAccount string, signer ChallengeSigner, client *http.Client) *AuthClient {
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	return &AuthClient{
		authEndpoint:  authEndpoint,
		clientAccount: clientAccount,
		signer:        signer,
		httpClient:    client,
	}
}

// RequestChallenge requests a challenge transaction XDR from the anchor SEP-10 auth endpoint.
func (c *AuthClient) RequestChallenge(ctx context.Context) (string, error) {
	if c.authEndpoint == "" {
		return "", errors.New("auth endpoint URL cannot be empty")
	}
	if c.clientAccount == "" {
		return "", errors.New("client account cannot be empty")
	}

	reqURL, err := url.Parse(c.authEndpoint)
	if err != nil {
		return "", fmt.Errorf("invalid auth endpoint URL: %w", err)
	}

	q := reqURL.Query()
	q.Set("account", c.clientAccount)
	reqURL.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL.String(), nil)
	if err != nil {
		return "", fmt.Errorf("failed to create challenge request: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("challenge request failed: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("failed to read challenge response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("anchor auth endpoint returned status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	var challengeResp ChallengeResponse
	if err := json.Unmarshal(bodyBytes, &challengeResp); err != nil {
		return "", fmt.Errorf("failed to parse challenge response JSON: %w", err)
	}

	if challengeResp.Error != "" {
		return "", fmt.Errorf("anchor returned error: %s", challengeResp.Error)
	}
	if challengeResp.Transaction == "" {
		return "", errors.New("anchor returned empty transaction challenge XDR")
	}

	return challengeResp.Transaction, nil
}

// SubmitSignedChallenge submits the signed transaction XDR to exchange for a JWT.
func (c *AuthClient) SubmitSignedChallenge(ctx context.Context, signedXDR string) (string, time.Time, error) {
	if signedXDR == "" {
		return "", time.Time{}, errors.New("signed challenge XDR cannot be empty")
	}

	payload := map[string]string{"transaction": signedXDR}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("failed to encode challenge payload: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.authEndpoint, bytes.NewReader(body))
	if err != nil {
		return "", time.Time{}, fmt.Errorf("failed to create submission request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("challenge submission failed: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("failed to read token response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", time.Time{}, fmt.Errorf("token exchange returned status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	var tokenResp TokenResponse
	if err := json.Unmarshal(bodyBytes, &tokenResp); err != nil {
		return "", time.Time{}, fmt.Errorf("failed to parse token response JSON: %w", err)
	}

	if tokenResp.Error != "" {
		return "", time.Time{}, fmt.Errorf("anchor returned error: %s", tokenResp.Error)
	}
	if tokenResp.Token == "" {
		return "", time.Time{}, errors.New("anchor returned empty JWT token")
	}

	// Standard SEP-10 JWTs are valid for 24 hours; default cache TTL to 1 hour or until expiration
	expiresAt := time.Now().Add(1 * time.Hour)
	return tokenResp.Token, expiresAt, nil
}

// Authenticate performs the full SEP-10 handshake: request challenge, sign, submit, and cache token.
func (c *AuthClient) Authenticate(ctx context.Context) (string, error) {
	if c.signer == nil {
		return "", errors.New("challenge signer function not configured")
	}

	challengeXDR, err := c.RequestChallenge(ctx)
	if err != nil {
		return "", fmt.Errorf("SEP-10 challenge request failed: %w", err)
	}

	signedXDR, err := c.signer(challengeXDR)
	if err != nil {
		return "", fmt.Errorf("failed to sign SEP-10 challenge: %w", err)
	}

	token, expiresAt, err := c.SubmitSignedChallenge(ctx, signedXDR)
	if err != nil {
		return "", fmt.Errorf("SEP-10 token exchange failed: %w", err)
	}

	c.mu.Lock()
	c.jwtToken = token
	c.expiresAt = expiresAt
	c.mu.Unlock()

	return token, nil
}

// GetValidToken returns the cached JWT token if valid (with 60s margin), or performs authentication.
func (c *AuthClient) GetValidToken(ctx context.Context) (string, error) {
	c.mu.RLock()
	token := c.jwtToken
	expiresAt := c.expiresAt
	c.mu.RUnlock()

	if token != "" && time.Now().Add(60*time.Second).Before(expiresAt) {
		return token, nil
	}

	return c.Authenticate(ctx)
}
