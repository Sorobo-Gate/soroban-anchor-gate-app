package anchor

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// mockAnchor is a SEP-38 quote server that records the bearer token and the
// number of requests it received.
type mockAnchor struct {
	server *httptest.Server

	mu       sync.Mutex
	quoteID  string
	requests int
	tokens   []string
	paths    []string
}

func newMockAnchor(t *testing.T, quoteID string) *mockAnchor {
	t.Helper()

	anchor := &mockAnchor{quoteID: quoteID}
	anchor.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		anchor.mu.Lock()
		anchor.requests++
		anchor.tokens = append(anchor.tokens, r.Header.Get("Authorization"))
		anchor.paths = append(anchor.paths, r.URL.Path)
		anchor.mu.Unlock()

		if r.Method != http.MethodPost || r.URL.Path != "/quote" {
			http.Error(w, `{"error":"unexpected endpoint"}`, http.StatusNotFound)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"id":           anchor.quoteID,
			"expires_at":   time.Now().Add(2 * time.Minute).UTC().Format(time.RFC3339),
			"price":        "1.01",
			"total_price":  "1.01",
			"sell_asset":   "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
			"sell_amount":  "10.00",
			"buy_asset":    "BRL",
			"buy_amount":   "10.10",
			"request_path": r.URL.Path,
		})
	}))
	t.Cleanup(anchor.server.Close)
	return anchor
}

func (m *mockAnchor) snapshot() (requests int, tokens []string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.requests, append([]string(nil), m.tokens...)
}

func testQuoteRequest() QuoteRequest {
	return QuoteRequest{
		SellAsset:  "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
		BuyAsset:   "BRL",
		SellAmount: "10.00",
	}
}

func newTwoAnchorRegistry(t *testing.T) (*Registry, *mockAnchor, *mockAnchor) {
	t.Helper()

	anchorA := newMockAnchor(t, "quote-a")
	anchorB := newMockAnchor(t, "quote-b")

	registry, err := NewRegistry(RegistryConfig{
		Anchors: map[string]AnchorConfig{
			"anclap": {
				Domain:      "anchor-a.test",
				QuoteServer: anchorA.server.URL,
				AuthKey:     "tenant-a-secret",
			},
			"moneygram": {
				Domain:      "anchor-b.test",
				QuoteServer: anchorB.server.URL,
				AuthKey:     "tenant-b-secret",
			},
		},
	})
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}
	return registry, anchorA, anchorB
}

func TestNewRegistry_RejectsInvalidConfiguration(t *testing.T) {
	cases := map[string]RegistryConfig{
		"no anchors": {},
		"missing domain": {
			Anchors: map[string]AnchorConfig{"": {QuoteServer: "https://anchor.test"}},
		},
		"non http endpoint": {
			Anchors: map[string]AnchorConfig{
				"anchor.test": {Domain: "anchor.test", QuoteServer: "ftp://anchor.test/quote"},
			},
		},
		"embedded credentials": {
			Anchors: map[string]AnchorConfig{
				"anchor.test": {Domain: "anchor.test", QuoteServer: "https://user:pass@anchor.test/quote"},
			},
		},
		"header injection in auth key": {
			Anchors: map[string]AnchorConfig{
				"anchor.test": {Domain: "anchor.test", AuthKey: "secret\r\nX-Injected: 1"},
			},
		},
		"duplicate domains": {
			Anchors: map[string]AnchorConfig{
				"primary":   {Domain: "Anclap.com", AuthKey: "a"},
				"secondary": {Domain: "https://anclap.com/sep38", AuthKey: "b"},
			},
		},
	}

	for name, cfg := range cases {
		if _, err := NewRegistry(cfg); err == nil {
			t.Fatalf("%s: expected configuration error", name)
		}
	}
}

func TestRegistry_RoutesByEscrowTargetDomain(t *testing.T) {
	registry, anchorA, anchorB := newTwoAnchorRegistry(t)
	ctx := context.Background()

	clientA, err := registry.QuoteClientFor(EscrowTarget{EscrowID: 1001, AnchorDomain: "anchor-a.test"})
	if err != nil {
		t.Fatalf("route anchor A: %v", err)
	}
	quoteA, err := clientA.CreateQuote(ctx, testQuoteRequest())
	if err != nil {
		t.Fatalf("create quote against anchor A: %v", err)
	}
	if quoteA.ID != "quote-a" {
		t.Fatalf("expected anchor A's quote, got %q", quoteA.ID)
	}

	clientB, err := registry.QuoteClientFor(EscrowTarget{EscrowID: 1002, AnchorDomain: "anchor-b.test"})
	if err != nil {
		t.Fatalf("route anchor B: %v", err)
	}
	quoteB, err := clientB.CreateQuote(ctx, testQuoteRequest())
	if err != nil {
		t.Fatalf("create quote against anchor B: %v", err)
	}
	if quoteB.ID != "quote-b" {
		t.Fatalf("expected anchor B's quote, got %q", quoteB.ID)
	}

	requestsA, tokensA := anchorA.snapshot()
	requestsB, tokensB := anchorB.snapshot()
	if requestsA != 1 || requestsB != 1 {
		t.Fatalf("expected one request per anchor, got A=%d B=%d", requestsA, requestsB)
	}
	if len(tokensA) != 1 || tokensA[0] != "Bearer tenant-a-secret" {
		t.Fatalf("anchor A received unexpected tokens %v", tokensA)
	}
	if len(tokensB) != 1 || tokensB[0] != "Bearer tenant-b-secret" {
		t.Fatalf("anchor B received unexpected tokens %v", tokensB)
	}
}

func TestRegistry_CredentialsNeverCrossTenants(t *testing.T) {
	registry, anchorA, anchorB := newTwoAnchorRegistry(t)
	ctx := context.Background()

	// Interleave lookups to prove the registry keeps no shared token state.
	for i := 0; i < 5; i++ {
		clientA, err := registry.QuoteClientFor(EscrowTarget{EscrowID: uint64(i), AnchorDomain: "anchor-a.test"})
		if err != nil {
			t.Fatalf("route anchor A: %v", err)
		}
		if _, err := clientA.CreateQuote(ctx, testQuoteRequest()); err != nil {
			t.Fatalf("quote A: %v", err)
		}

		clientB, err := registry.QuoteClientFor(EscrowTarget{EscrowID: uint64(i), AnchorDomain: "anchor-b.test"})
		if err != nil {
			t.Fatalf("route anchor B: %v", err)
		}
		if _, err := clientB.CreateQuote(ctx, testQuoteRequest()); err != nil {
			t.Fatalf("quote B: %v", err)
		}
	}

	_, tokensA := anchorA.snapshot()
	_, tokensB := anchorB.snapshot()
	for _, token := range tokensA {
		if token != "Bearer tenant-a-secret" {
			t.Fatalf("anchor A received another tenant's credential %q", token)
		}
	}
	for _, token := range tokensB {
		if token != "Bearer tenant-b-secret" {
			t.Fatalf("anchor B received another tenant's credential %q", token)
		}
	}
}

func TestRegistry_ReturnsDistinctClientsPerAnchor(t *testing.T) {
	registry, _, _ := newTwoAnchorRegistry(t)

	anchorA, err := registry.Resolve("anchor-a.test")
	if err != nil {
		t.Fatalf("resolve A: %v", err)
	}
	anchorB, err := registry.Resolve("anchor-b.test")
	if err != nil {
		t.Fatalf("resolve B: %v", err)
	}
	if anchorA == anchorB {
		t.Fatalf("registry returned the same anchor for two domains")
	}

	clientA1, err := anchorA.QuoteClient()
	if err != nil {
		t.Fatalf("client A: %v", err)
	}
	clientA2, err := anchorA.QuoteClient()
	if err != nil {
		t.Fatalf("client A again: %v", err)
	}
	clientB, err := anchorB.QuoteClient()
	if err != nil {
		t.Fatalf("client B: %v", err)
	}
	if clientA1 != clientA2 {
		t.Fatalf("each anchor should cache its own client")
	}
	if clientA1 == clientB {
		t.Fatalf("anchors must not share SEP-38 clients")
	}
}

func TestRegistry_ResolveNormalizesDomains(t *testing.T) {
	registry, _, _ := newTwoAnchorRegistry(t)

	for _, domain := range []string{
		"anchor-a.test",
		"ANCHOR-A.TEST",
		"https://anchor-a.test/sep38?x=1",
		"anchor-a.test:443",
		"  anchor-a.test  ",
	} {
		anchor, err := registry.Resolve(domain)
		if err != nil {
			t.Fatalf("resolve %q: %v", domain, err)
		}
		if anchor.Domain() != "anchor-a.test" {
			t.Fatalf("resolve %q returned domain %q", domain, anchor.Domain())
		}
	}
}

func TestRegistry_RejectsUnknownAndDisabledAnchors(t *testing.T) {
	registry, err := NewRegistry(RegistryConfig{
		Anchors: map[string]AnchorConfig{
			"live.test": {Domain: "live.test", QuoteServer: "https://live.test/quote", AuthKey: "live"},
			"off.test":  {Domain: "off.test", QuoteServer: "https://off.test/quote", Disabled: true},
		},
	})
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}

	if _, err := registry.Resolve("unknown.test"); !errors.Is(err, ErrAnchorNotRegistered) {
		t.Fatalf("expected ErrAnchorNotRegistered, got %v", err)
	}
	if _, err := registry.Resolve(""); !errors.Is(err, ErrAnchorNotRegistered) {
		t.Fatalf("expected ErrAnchorNotRegistered for empty domain, got %v", err)
	}
	if _, err := registry.Resolve("off.test"); !errors.Is(err, ErrAnchorDisabled) {
		t.Fatalf("expected ErrAnchorDisabled, got %v", err)
	}
	if _, err := registry.Route(EscrowTarget{EscrowID: 7, AnchorDomain: "unknown.test"}); err == nil {
		t.Fatalf("expected routing failure for an unregistered anchor")
	} else if !errors.Is(err, ErrAnchorNotRegistered) {
		t.Fatalf("expected ErrAnchorNotRegistered, got %v", err)
	}
}

func TestRegistry_MissingTenantEndpointIsAnError(t *testing.T) {
	registry, err := NewRegistry(RegistryConfig{
		Anchors: map[string]AnchorConfig{
			"quote-only.test": {Domain: "quote-only.test", QuoteServer: "https://quote-only.test/sep38"},
		},
	})
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}

	anchor, err := registry.Resolve("quote-only.test")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if _, err := anchor.InteractiveClient(); !errors.Is(err, ErrInvalidAnchorConfig) {
		t.Fatalf("expected ErrInvalidAnchorConfig for a missing transfer server, got %v", err)
	}
	if _, err := anchor.AuthClient(); !errors.Is(err, ErrInvalidAnchorConfig) {
		t.Fatalf("expected ErrInvalidAnchorConfig for a missing auth endpoint, got %v", err)
	}
}

func TestAnchor_ConfigRedactsCredentials(t *testing.T) {
	registry, _, _ := newTwoAnchorRegistry(t)
	anchor, err := registry.Resolve("anchor-a.test")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}

	cfg := anchor.Config()
	if cfg.AuthKey != "" {
		t.Fatalf("auth key must not be exposed through Config()")
	}
	if cfg.Domain != "anchor-a.test" {
		t.Fatalf("unexpected domain %q", cfg.Domain)
	}

	for _, exposed := range registry.Anchors() {
		if exposed.AuthKey != "" || exposed.SigningKey != "" {
			t.Fatalf("registry snapshot leaked credentials: %+v", exposed)
		}
	}
}

func TestRegistry_ExposesSortedDomains(t *testing.T) {
	registry, err := NewRegistry(RegistryConfig{
		Anchors: map[string]AnchorConfig{
			"zulu":  {Domain: "zulu.test", QuoteServer: "https://zulu.test/q"},
			"alpha": {Domain: "alpha.test", QuoteServer: "https://alpha.test/q"},
		},
	})
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}

	domains := registry.Domains()
	if len(domains) != 2 || domains[0] != "alpha.test" || domains[1] != "zulu.test" {
		t.Fatalf("unexpected domain order %v", domains)
	}
	if registry.Len() != 2 {
		t.Fatalf("unexpected registry length %d", registry.Len())
	}

	domains[0] = "mutated"
	if registry.Domains()[0] != "alpha.test" {
		t.Fatalf("Domains must return a copy")
	}
}

func TestRegistry_DomainDefaultsToConfigKey(t *testing.T) {
	registry, err := NewRegistry(RegistryConfig{
		Anchors: map[string]AnchorConfig{
			"Anclap.com": {QuoteServer: "https://anclap.com/sep38"},
		},
	})
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}
	if _, err := registry.Resolve("anclap.com"); err != nil {
		t.Fatalf("expected the map key to be used as the domain: %v", err)
	}
}

func TestRegistry_LoadsConfigFromDisk(t *testing.T) {
	path := filepath.Join(t.TempDir(), "anchors.json")
	payload := `{
	  "anchors": {
	    "anclap": {
	      "domain": "anclap.com",
	      "web_auth_endpoint": "https://anclap.com/auth",
	      "transfer_server": "https://anclap.com/sep24",
	      "quote_server": "https://anclap.com/sep38",
	      "auth_key": "anclap-tenant-key"
	    }
	  }
	}`
	if err := os.WriteFile(path, []byte(payload), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := LoadRegistryConfig(path)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	registry, err := NewRegistry(cfg)
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}

	anchor, err := registry.Resolve("anclap.com")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if anchor.Config().QuoteServer != "https://anclap.com/sep38" {
		t.Fatalf("unexpected quote server %q", anchor.Config().QuoteServer)
	}
}

func TestLoadRegistryConfig_Errors(t *testing.T) {
	if _, err := LoadRegistryConfig(""); err == nil {
		t.Fatalf("expected error for an empty path")
	}
	if _, err := LoadRegistryConfig(filepath.Join(t.TempDir(), "missing.json")); err == nil {
		t.Fatalf("expected error for a missing file")
	}

	path := filepath.Join(t.TempDir(), "broken.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if _, err := LoadRegistryConfig(path); err == nil {
		t.Fatalf("expected error for malformed JSON")
	}
}

func TestParseRegistryConfig_RejectsMalformedJSON(t *testing.T) {
	if _, err := ParseRegistryConfig([]byte(`[]`)); !errors.Is(err, ErrInvalidAnchorConfig) {
		t.Fatalf("expected ErrInvalidAnchorConfig, got %v", err)
	}
}

func TestRegistry_ConcurrentRouting(t *testing.T) {
	registry, anchorA, anchorB := newTwoAnchorRegistry(t)
	ctx := context.Background()

	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			domain := "anchor-a.test"
			if worker%2 == 0 {
				domain = "anchor-b.test"
			}
			client, err := registry.QuoteClientFor(EscrowTarget{EscrowID: uint64(worker), AnchorDomain: domain})
			if err != nil {
				errs <- err
				return
			}
			if _, err := client.CreateQuote(ctx, testQuoteRequest()); err != nil {
				errs <- err
				return
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent routing: %v", err)
	}

	requestsA, tokensA := anchorA.snapshot()
	requestsB, tokensB := anchorB.snapshot()
	if requestsA == 0 || requestsB == 0 {
		t.Fatalf("expected both anchors to receive traffic, got A=%d B=%d", requestsA, requestsB)
	}
	for _, token := range tokensA {
		if token != "Bearer tenant-a-secret" {
			t.Fatalf("cross-tenant token on anchor A: %q", token)
		}
	}
	for _, token := range tokensB {
		if token != "Bearer tenant-b-secret" {
			t.Fatalf("cross-tenant token on anchor B: %q", token)
		}
	}
}

func TestRegistry_PerTenantRateLimit(t *testing.T) {
	anchorA := newMockAnchor(t, "quote-a")
	registry, err := NewRegistry(RegistryConfig{
		Anchors: map[string]AnchorConfig{
			"limited.test": {
				Domain:      "limited.test",
				QuoteServer: anchorA.server.URL,
				AuthKey:     "limited-key",
				RateLimit:   &LimitConfig{RPS: 1000, Burst: 5},
			},
		},
	})
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}

	anchor, err := registry.Resolve("limited.test")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	client, err := anchor.QuoteClient()
	if err != nil {
		t.Fatalf("quote client: %v", err)
	}
	if client.AnchorDomain() != "limited.test" {
		t.Fatalf("unexpected client domain %q", client.AnchorDomain())
	}

	if _, err := client.CreateQuote(context.Background(), testQuoteRequest()); err != nil {
		t.Fatalf("create quote: %v", err)
	}
	if requests, _ := anchorA.snapshot(); requests != 1 {
		t.Fatalf("expected the rate limited client to reach the anchor once, got %d", requests)
	}
}

func TestAnchor_AuthTokenUsesOwnCredentialsOnly(t *testing.T) {
	registry, _, _ := newTwoAnchorRegistry(t)

	anchorA, err := registry.Resolve("anchor-a.test")
	if err != nil {
		t.Fatalf("resolve A: %v", err)
	}
	anchorB, err := registry.Resolve("anchor-b.test")
	if err != nil {
		t.Fatalf("resolve B: %v", err)
	}

	tokenA, err := anchorA.authToken(context.Background())
	if err != nil {
		t.Fatalf("token A: %v", err)
	}
	tokenB, err := anchorB.authToken(context.Background())
	if err != nil {
		t.Fatalf("token B: %v", err)
	}
	if tokenA != "tenant-a-secret" || tokenB != "tenant-b-secret" || tokenA == tokenB {
		t.Fatalf("unexpected per-tenant tokens %q / %q", tokenA, tokenB)
	}
}

func TestAnchor_MissingAuthKeyYieldsEmptyToken(t *testing.T) {
	registry, err := NewRegistry(RegistryConfig{
		Anchors: map[string]AnchorConfig{
			"public.test": {Domain: "public.test", QuoteServer: "https://public.test/quote"},
		},
	})
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}
	anchor, err := registry.Resolve("public.test")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}

	token, err := anchor.authToken(context.Background())
	if err != nil {
		t.Fatalf("auth token: %v", err)
	}
	if token != "" {
		t.Fatalf("expected no token for an unauthenticated anchor, got %q", token)
	}
}

func TestRegistry_EscrowTargetJSON(t *testing.T) {
	target := EscrowTarget{EscrowID: 42, AnchorDomain: "anclap.com"}
	encoded, err := json.Marshal(target)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(encoded), `"anchor_domain":"anclap.com"`) {
		t.Fatalf("unexpected JSON %s", encoded)
	}
}
