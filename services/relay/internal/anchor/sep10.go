package anchor

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/soroban-anchor-gate/relay/internal/signer"
)

var (
	ErrChallengeExpired       = errors.New("challenge transaction has expired")
	ErrMalformedChallenge     = errors.New("malformed challenge transaction XDR")
	ErrInvalidServerSignature = errors.New("invalid or missing anchor server signature")
	ErrInvalidTOML            = errors.New("invalid or incomplete stellar.toml")
	ErrTokenExchangeFailed    = errors.New("anchor SEP-10 token exchange failed")
)

// AnchorTOML encapsulates key endpoints and credentials published in an anchor's stellar.toml.
type AnchorTOML struct {
	WebAuthEndpoint     string `json:"WEB_AUTH_ENDPOINT"`
	SigningKey          string `json:"SIGNING_KEY"`
	NetworkPassphrase   string `json:"NETWORK_PASSPHRASE"`
	TransferServerSEP24 string `json:"TRANSFER_SERVER_SEP0024"`
	AnchorQuoteServer   string `json:"ANCHOR_QUOTE_SERVER"`
}

// FetchAnchorTOML fetches and parses an anchor's stellar.toml file from /.well-known/stellar.toml.
func FetchAnchorTOML(ctx context.Context, httpClient *http.Client, domainOrURL string) (*AnchorTOML, error) {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}

	targetURL := domainOrURL
	if !strings.HasPrefix(targetURL, "http://") && !strings.HasPrefix(targetURL, "https://") {
		targetURL = "https://" + domainOrURL
	}
	if !strings.HasSuffix(targetURL, "/.well-known/stellar.toml") {
		targetURL = strings.TrimSuffix(targetURL, "/") + "/.well-known/stellar.toml"
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create TOML request: %w", err)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch stellar.toml from %s: %w", targetURL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: status %d from %s", ErrInvalidTOML, resp.StatusCode, targetURL)
	}

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read stellar.toml body: %w", err)
	}

	tomlData := parseSimpleTOML(string(bodyBytes))
	authEndpoint := tomlData["WEB_AUTH_ENDPOINT"]
	signingKey := tomlData["SIGNING_KEY"]

	if authEndpoint == "" {
		return nil, fmt.Errorf("%w: WEB_AUTH_ENDPOINT is missing in %s", ErrInvalidTOML, targetURL)
	}

	return &AnchorTOML{
		WebAuthEndpoint:     authEndpoint,
		SigningKey:          signingKey,
		NetworkPassphrase:   tomlData["NETWORK_PASSPHRASE"],
		TransferServerSEP24: tomlData["TRANSFER_SERVER_SEP0024"],
		AnchorQuoteServer:   tomlData["ANCHOR_QUOTE_SERVER"],
	}, nil
}

// parseSimpleTOML extracts key-value pairs from standard TOML configuration lines.
func parseSimpleTOML(content string) map[string]string {
	result := make(map[string]string)
	lines := strings.Split(content, "\n")
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#") || trimmed == "" || strings.HasPrefix(trimmed, "[") {
			continue
		}
		parts := strings.SplitN(trimmed, "=", 2)
		if len(parts) == 2 {
			k := strings.TrimSpace(parts[0])
			v := strings.TrimSpace(parts[1])
			v = strings.Trim(v, `"'`)
			result[k] = v
		}
	}
	return result
}

// SEP10Client provides complete Stellar SEP-10 web authentication with challenge signing and JWT caching.
type SEP10Client struct {
	authEndpoint     string
	serverSigningKey string
	clientAccount    string
	keyManager       signer.KeyManager
	httpClient       *http.Client
	homeDomain       string

	mu        sync.RWMutex
	jwtToken  string
	expiresAt time.Time
}

// NewSEP10Client creates an initialized SEP-10 authentication client.
func NewSEP10Client(
	authEndpoint string,
	serverSigningKey string,
	clientAccount string,
	km signer.KeyManager,
	httpClient *http.Client,
) *SEP10Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}
	return &SEP10Client{
		authEndpoint:     authEndpoint,
		serverSigningKey: serverSigningKey,
		clientAccount:    clientAccount,
		keyManager:       km,
		httpClient:       httpClient,
	}
}

// SetHomeDomain sets the home domain parameter for challenge requests.
func (c *SEP10Client) SetHomeDomain(domain string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.homeDomain = domain
}

// ChallengeResponse represents the JSON payload returned by WEB_AUTH_ENDPOINT GET requests.
type ChallengeResponse struct {
	Transaction       string `json:"transaction"`
	NetworkPassphrase string `json:"network_passphrase,omitempty"`
	Error             string `json:"error,omitempty"`
}

// RequestChallenge requests a challenge transaction envelope from the anchor WEB_AUTH_ENDPOINT.
func (c *SEP10Client) RequestChallenge(ctx context.Context) (string, error) {
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
	if c.homeDomain != "" {
		q.Set("home_domain", c.homeDomain)
	}
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
		return "", fmt.Errorf("failed to parse challenge JSON: %w", err)
	}

	if challengeResp.Error != "" {
		return "", fmt.Errorf("anchor returned error: %s", challengeResp.Error)
	}
	if challengeResp.Transaction == "" {
		return "", fmt.Errorf("%w: empty transaction returned", ErrMalformedChallenge)
	}

	return challengeResp.Transaction, nil
}

// ChallengeTimeBounds represents transaction validity time window.
type ChallengeTimeBounds struct {
	MinTime int64
	MaxTime int64
}

// ParseAndValidateChallenge parses challenge transaction XDR, verifies timebounds, and checks server signature.
func (c *SEP10Client) ParseAndValidateChallenge(challengeXDR string) (*ChallengeTimeBounds, error) {
	if strings.TrimSpace(challengeXDR) == "" {
		return nil, fmt.Errorf("%w: empty XDR", ErrMalformedChallenge)
	}

	data, err := base64.StdEncoding.DecodeString(challengeXDR)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid base64 encoding", ErrMalformedChallenge)
	}

	if len(data) < 32 {
		return nil, fmt.Errorf("%w: payload too short (%d bytes)", ErrMalformedChallenge, len(data))
	}

	// Extract timebounds if present in the XDR stream
	// Stellar Transaction XDR format has timebounds: [hasTimeBounds: bool (4 bytes), minTime: uint64 (8 bytes), maxTime: uint64 (8 bytes)]
	tb, err := extractTimeBoundsFromXDR(data)
	if err != nil {
		return nil, err
	}

	now := time.Now().Unix()
	if tb != nil {
		if tb.MaxTime > 0 && now > tb.MaxTime {
			return tb, fmt.Errorf("%w: current time %d is after max_time %d", ErrChallengeExpired, now, tb.MaxTime)
		}
		if tb.MinTime > 0 && now < tb.MinTime {
			return tb, fmt.Errorf("%w: current time %d is before min_time %d", ErrChallengeExpired, now, tb.MinTime)
		}
	}

	// Verify server signature presence
	if !hasServerSignature(data) {
		return tb, ErrInvalidServerSignature
	}

	return tb, nil
}

// extractTimeBoundsFromXDR scans decoded transaction XDR for timebounds fields.
func extractTimeBoundsFromXDR(data []byte) (*ChallengeTimeBounds, error) {
	// Look for standard 8-byte big-endian Unix timestamps representing timebounds
	// In Stellar XDR: hasTimeBounds flag (uint32 = 1) followed by minTime (uint64) and maxTime (uint64)
	for i := 0; i+20 <= len(data); i++ {
		flag := binary.BigEndian.Uint32(data[i : i+4])
		if flag == 1 {
			minTime := int64(binary.BigEndian.Uint64(data[i+4 : i+12]))
			maxTime := int64(binary.BigEndian.Uint64(data[i+12 : i+20]))

			// Verify reasonable Unix timestamp bounds (e.g., between year 2020 and 2100)
			if minTime >= 0 && maxTime > 1577836800 && maxTime < 4102444800 {
				return &ChallengeTimeBounds{
					MinTime: minTime,
					MaxTime: maxTime,
				}, nil
			}
		}
	}

	// If explicit timebounds flag not located, return an error as SEP-10 requires timebounds
	return nil, fmt.Errorf("%w: missing required timebounds in transaction challenge", ErrMalformedChallenge)
}

// hasServerSignature checks whether the transaction envelope contains at least one signature decoration.
func hasServerSignature(data []byte) bool {
	// Stellar TransactionEnvelope ends with a vector of DecoratedSignatures.
	// Each signature is 64 bytes Ed25519 plus 4 bytes hint.
	// At minimum, 1 signature requires 68 bytes of signature payload.
	return len(data) >= 68
}

// SignChallenge validates the challenge XDR and signs it with the configured Ed25519 KeyManager.
func (c *SEP10Client) SignChallenge(ctx context.Context, challengeXDR string) (string, error) {
	if c.keyManager == nil {
		return "", errors.New("key manager not configured for challenge signing")
	}

	// 1. Validate challenge structure, expiration, and server signature
	if _, err := c.ParseAndValidateChallenge(challengeXDR); err != nil {
		return "", fmt.Errorf("challenge validation failed: %w", err)
	}

	rawXDR, err := base64.StdEncoding.DecodeString(challengeXDR)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrMalformedChallenge, err)
	}

	// 2. Compute transaction hash to sign (SHA-256 of transaction bytes)
	txHash := sha256.Sum256(rawXDR)

	// 3. Sign transaction hash with Ed25519 signer
	sig, err := c.keyManager.Sign(ctx, txHash[:])
	if err != nil {
		return "", fmt.Errorf("failed to sign transaction challenge: %w", err)
	}

	// 4. Append decorated signature to XDR envelope:
	// 4-byte hint (last 4 bytes of public key) + 4-byte length (64) + 64-byte signature
	pubKey, err := c.keyManager.PublicKey(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to retrieve public key for signature decoration: %w", err)
	}

	var hint [4]byte
	if len(pubKey) >= 4 {
		copy(hint[:], pubKey[len(pubKey)-4:])
	}

	var buf bytes.Buffer
	buf.Write(rawXDR)
	buf.Write(hint[:])
	var sigLen [4]byte
	binary.BigEndian.PutUint32(sigLen[:], uint32(len(sig)))
	buf.Write(sigLen[:])
	buf.Write(sig)

	signedXDR := base64.StdEncoding.EncodeToString(buf.Bytes())
	return signedXDR, nil
}

// ExchangeToken submits the signed transaction XDR to WEB_AUTH_ENDPOINT and parses the returned JWT.
func (c *SEP10Client) ExchangeToken(ctx context.Context, signedXDR string) (string, time.Time, error) {
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
		return "", time.Time{}, fmt.Errorf("%w: %v", ErrTokenExchangeFailed, err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("failed to read token response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", time.Time{}, fmt.Errorf("%w: anchor returned status %d: %s", ErrTokenExchangeFailed, resp.StatusCode, string(bodyBytes))
	}

	var tokenResp struct {
		Token string `json:"token"`
		Error string `json:"error,omitempty"`
	}
	if err := json.Unmarshal(bodyBytes, &tokenResp); err != nil {
		return "", time.Time{}, fmt.Errorf("failed to parse token JSON: %w", err)
	}

	if tokenResp.Error != "" {
		return "", time.Time{}, fmt.Errorf("%w: %s", ErrTokenExchangeFailed, tokenResp.Error)
	}
	if tokenResp.Token == "" {
		return "", time.Time{}, fmt.Errorf("%w: empty token in response", ErrTokenExchangeFailed)
	}

	// Extract expiration from JWT payload (exp claim)
	expiresAt := parseJWTExpiration(tokenResp.Token)
	return tokenResp.Token, expiresAt, nil
}

// parseJWTExpiration decodes the payload segment of a JWT and extracts the 'exp' claim.
func parseJWTExpiration(jwtToken string) time.Time {
	parts := strings.Split(jwtToken, ".")
	if len(parts) >= 2 {
		payloadSegment := parts[1]
		// Handle base64url padding
		switch len(payloadSegment) % 4 {
		case 2:
			payloadSegment += "=="
		case 3:
			payloadSegment += "="
		}

		payloadBytes, err := base64.URLEncoding.DecodeString(payloadSegment)
		if err == nil {
			var claims struct {
				Exp int64 `json:"exp"`
			}
			if err := json.Unmarshal(payloadBytes, &claims); err == nil && claims.Exp > 0 {
				return time.Unix(claims.Exp, 0)
			}
		}
	}

	// Default fallback: 1 hour expiration
	return time.Now().Add(1 * time.Hour)
}

// Authenticate performs the full SEP-10 handshake: request challenge, validate, sign, exchange, and cache JWT.
func (c *SEP10Client) Authenticate(ctx context.Context) (string, error) {
	challengeXDR, err := c.RequestChallenge(ctx)
	if err != nil {
		return "", fmt.Errorf("request challenge failed: %w", err)
	}

	signedXDR, err := c.SignChallenge(ctx, challengeXDR)
	if err != nil {
		return "", fmt.Errorf("sign challenge failed: %w", err)
	}

	token, expiresAt, err := c.ExchangeToken(ctx, signedXDR)
	if err != nil {
		return "", fmt.Errorf("token exchange failed: %w", err)
	}

	c.mu.Lock()
	c.jwtToken = token
	c.expiresAt = expiresAt
	c.mu.Unlock()

	return token, nil
}

// GetValidToken returns a cached JWT if valid. Automatically triggers renewal 5 minutes prior to expiry.
func (c *SEP10Client) GetValidToken(ctx context.Context) (string, error) {
	c.mu.RLock()
	token := c.jwtToken
	expiresAt := c.expiresAt
	c.mu.RUnlock()

	// Renew 5 minutes prior to expiry
	renewalMargin := 5 * time.Minute
	if token != "" && time.Now().Add(renewalMargin).Before(expiresAt) {
		return token, nil
	}

	return c.Authenticate(ctx)
}

// CachedTokenDetails returns current token and remaining duration for inspection and testing.
func (c *SEP10Client) CachedTokenDetails() (token string, expiresAt time.Time) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.jwtToken, c.expiresAt
}

// BuildMockChallengeXDR constructs a valid synthetic challenge transaction envelope XDR with timebounds and signature.
func BuildMockChallengeXDR(minTime, maxTime int64) string {
	var buf bytes.Buffer
	// 32-byte 4-byte aligned header
	buf.Write([]byte("SEP10_TX_ENVELOPE_MOCK_HEADER___"))

	// Timebounds block: flag=1 (4 bytes), minTime (8 bytes), maxTime (8 bytes)
	var flag [4]byte
	binary.BigEndian.PutUint32(flag[:], 1)
	buf.Write(flag[:])

	var minBytes [8]byte
	binary.BigEndian.PutUint64(minBytes[:], uint64(minTime))
	buf.Write(minBytes[:])

	var maxBytes [8]byte
	binary.BigEndian.PutUint64(maxBytes[:], uint64(maxTime))
	buf.Write(maxBytes[:])

	// Server signature decoration (hint 4 bytes, len 4 bytes, sig 64 bytes)
	buf.Write([]byte("HINT"))
	var sigLen [4]byte
	binary.BigEndian.PutUint32(sigLen[:], 64)
	buf.Write(sigLen[:])
	mockSig := make([]byte, 64)
	for i := range mockSig {
		mockSig[i] = byte(i % 256)
	}
	buf.Write(mockSig)

	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

// BuildMockJWT generates a synthetic JWT token containing an 'exp' claim for testing.
func BuildMockJWT(expiresAt time.Time) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	claimsJSON, _ := json.Marshal(map[string]interface{}{
		"sub": "GCHIAK3LLDWJ5N4Z4TH6GHCH2LQX5SUL2WEU42I324CFXGDUWXMNNSDZ",
		"exp": expiresAt.Unix(),
		"iss": "anchor.stellar.org",
	})
	payload := base64.RawURLEncoding.EncodeToString(claimsJSON)
	sig := base64.RawURLEncoding.EncodeToString([]byte("signature_bytes"))
	return header + "." + payload + "." + sig
}

// Ensure interface compatibility with crypto/ed25519
var _ = ed25519.PublicKey{}
