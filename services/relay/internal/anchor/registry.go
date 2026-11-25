package anchor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/soroban-anchor-gate/relay/internal/signer"
	"github.com/soroban-anchor-gate/relay/internal/telemetry"
)

// Multi-tenant anchor registry errors.
var (
	// ErrAnchorNotRegistered is returned when an escrow targets a domain that
	// has no anchor configured on this relay.
	ErrAnchorNotRegistered = errors.New("anchor: target anchor is not registered")
	// ErrAnchorDisabled is returned when a registered anchor is turned off.
	ErrAnchorDisabled = errors.New("anchor: target anchor is disabled")
	// ErrDuplicateAnchor is returned when two configured anchors normalize to
	// the same domain. Duplicates would make routing ambiguous and could leak
	// one tenant's credentials to another tenant's endpoint.
	ErrDuplicateAnchor = errors.New("anchor: duplicate anchor domain")
	// ErrInvalidAnchorConfig is returned for malformed anchor configuration.
	ErrInvalidAnchorConfig = errors.New("anchor: invalid anchor configuration")
)

// AnchorConfig describes a single tenant anchor. Every credential is scoped to
// this anchor: a token minted or configured here is only ever attached to
// requests sent to this anchor's endpoints.
type AnchorConfig struct {
	// Domain is the anchor's home domain used for routing and metrics. The
	// configuration map key is used when Domain is empty.
	Domain string `json:"domain"`
	// HomeDomain is the SEP-10 home domain sent with challenge requests.
	HomeDomain string `json:"home_domain,omitempty"`
	// WebAuthEndpoint is the anchor's SEP-10 WEB_AUTH_ENDPOINT.
	WebAuthEndpoint string `json:"web_auth_endpoint,omitempty"`
	// TransferServer is the anchor's SEP-24 TRANSFER_SERVER_SEP0024.
	TransferServer string `json:"transfer_server,omitempty"`
	// QuoteServer is the anchor's SEP-38 ANCHOR_QUOTE_SERVER.
	QuoteServer string `json:"quote_server,omitempty"`
	// SigningKey is the anchor's SIGNING_KEY used to verify challenges.
	SigningKey string `json:"signing_key,omitempty"`
	// AuthKey is a pre-issued bearer credential for anchor API calls. It is
	// used when no SEP-10 endpoint is configured, and is never shared with
	// another anchor.
	AuthKey string `json:"auth_key,omitempty"`
	// ClientAccount is the Stellar account the relay authenticates as.
	ClientAccount string `json:"client_account,omitempty"`
	// NetworkPassphrase is the Stellar network the anchor settles on.
	NetworkPassphrase string `json:"network_passphrase,omitempty"`
	// RateLimit optionally overrides the anchor-wide rate limiter for this
	// tenant.
	RateLimit *LimitConfig `json:"rate_limit,omitempty"`
	// Disabled keeps the configuration in place while refusing to route.
	Disabled bool `json:"disabled,omitempty"`
}

// normalize validates the configuration and derives a canonical domain.
func (c AnchorConfig) normalize(name string) (AnchorConfig, error) {
	if strings.TrimSpace(c.Domain) == "" {
		c.Domain = name
	}
	c.Domain = normalizeDomain(c.Domain)
	if c.Domain == "" {
		return c, fmt.Errorf("%w: anchor %q has no domain", ErrInvalidAnchorConfig, name)
	}
	for _, r := range c.Domain {
		switch r {
		case ' ', '\t', '\r', '\n', '/', '\\', '?', '#':
			return c, fmt.Errorf("%w: anchor %q has an invalid domain %q", ErrInvalidAnchorConfig, name, c.Domain)
		}
	}

	if err := validateAnchorEndpoint("web_auth_endpoint", c.WebAuthEndpoint); err != nil {
		return c, fmt.Errorf("anchor %q: %w", name, err)
	}
	if err := validateAnchorEndpoint("transfer_server", c.TransferServer); err != nil {
		return c, fmt.Errorf("anchor %q: %w", name, err)
	}
	if err := validateAnchorEndpoint("quote_server", c.QuoteServer); err != nil {
		return c, fmt.Errorf("anchor %q: %w", name, err)
	}

	// Credentials end up in HTTP headers. Reject control characters so a
	// configuration value cannot inject additional headers.
	for field, value := range map[string]string{
		"auth_key":    c.AuthKey,
		"signing_key": c.SigningKey,
	} {
		if strings.ContainsAny(value, "\r\n\t ") {
			return c, fmt.Errorf("%w: anchor %q %s cannot contain whitespace or control characters", ErrInvalidAnchorConfig, name, field)
		}
	}

	if c.HomeDomain != "" {
		c.HomeDomain = normalizeDomain(c.HomeDomain)
	}
	c.WebAuthEndpoint = strings.TrimRight(c.WebAuthEndpoint, "/")
	c.TransferServer = strings.TrimRight(c.TransferServer, "/")
	c.QuoteServer = strings.TrimRight(c.QuoteServer, "/")

	return c, nil
}

func validateAnchorEndpoint(field, raw string) error {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("%w: %s is not a valid URL: %v", ErrInvalidAnchorConfig, field, err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("%w: %s must be http(s), got scheme %q", ErrInvalidAnchorConfig, field, parsed.Scheme)
	}
	if parsed.Host == "" {
		return fmt.Errorf("%w: %s must include a host", ErrInvalidAnchorConfig, field)
	}
	if parsed.User != nil {
		return fmt.Errorf("%w: %s must not embed credentials", ErrInvalidAnchorConfig, field)
	}
	return nil
}

// Anchor is a single tenant's isolated credential and endpoint bundle.
//
// Every client is built lazily, once, and closes over this anchor's own
// credentials, so a token issued for one anchor can never be attached to
// another anchor's requests even when both are served by the same registry.
type Anchor struct {
	cfg      AnchorConfig
	domain   string
	registry *Registry

	mu    sync.Mutex
	sep10 *SEP10Client
	sep24 *SEP24Client
	sep38 *SEP38Client
}

// Domain returns the canonical anchor domain used for routing.
func (a *Anchor) Domain() string { return a.domain }

// Config returns a copy of the anchor configuration with credentials removed,
// so it is safe to log or expose through diagnostics.
func (a *Anchor) Config() AnchorConfig {
	cfg := a.cfg
	cfg.AuthKey = ""
	cfg.SigningKey = ""
	return cfg
}

// authToken resolves the bearer token for this anchor only. SEP-10 is preferred
// when a web auth endpoint and a signer are configured; otherwise the static
// auth key is used.
func (a *Anchor) authToken(ctx context.Context) (string, error) {
	if a.cfg.WebAuthEndpoint != "" && a.registry != nil && a.registry.keyManager != nil {
		client, err := a.AuthClient()
		if err != nil {
			return "", err
		}
		return client.GetValidToken(ctx)
	}
	if a.cfg.AuthKey != "" {
		return a.cfg.AuthKey, nil
	}
	return "", nil
}

// AuthClient returns the anchor's SEP-10 client.
func (a *Anchor) AuthClient() (*SEP10Client, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.sep10 != nil {
		return a.sep10, nil
	}
	if a.cfg.WebAuthEndpoint == "" {
		return nil, fmt.Errorf("%w: anchor %q has no web auth endpoint", ErrInvalidAnchorConfig, a.domain)
	}

	client := NewSEP10Client(
		a.cfg.WebAuthEndpoint,
		a.cfg.SigningKey,
		a.cfg.ClientAccount,
		a.registry.keyManager,
		a.registry.httpClientFor(a.cfg),
	)
	if a.cfg.HomeDomain != "" {
		client.SetHomeDomain(a.cfg.HomeDomain)
	}
	a.sep10 = client
	return client, nil
}

// QuoteClient returns the anchor's SEP-38 quote client.
func (a *Anchor) QuoteClient() (*SEP38Client, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.sep38 != nil {
		return a.sep38, nil
	}
	if a.cfg.QuoteServer == "" {
		return nil, fmt.Errorf("%w: anchor %q has no quote server", ErrInvalidAnchorConfig, a.domain)
	}

	client, err := NewSEP38Client(SEP38Config{
		QuoteServer:   a.cfg.QuoteServer,
		AnchorDomain:  a.domain,
		HTTPClient:    a.registry.httpClientFor(a.cfg),
		TokenProvider: a.authToken,
		Metrics:       a.registry.metrics,
	})
	if err != nil {
		return nil, fmt.Errorf("anchor %q: %w", a.domain, err)
	}
	a.sep38 = client
	return client, nil
}

// InteractiveClient returns the anchor's SEP-24 interactive flow client.
func (a *Anchor) InteractiveClient() (*SEP24Client, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.sep24 != nil {
		return a.sep24, nil
	}
	if a.cfg.TransferServer == "" {
		return nil, fmt.Errorf("%w: anchor %q has no transfer server", ErrInvalidAnchorConfig, a.domain)
	}

	var escrows EscrowStore
	if a.registry != nil {
		escrows = a.registry.escrowStore
	}
	client, err := NewSEP24Client(SEP24Config{
		TransferServer: a.cfg.TransferServer,
		AnchorDomain:   a.domain,
		HTTPClient:     a.registry.httpClientFor(a.cfg),
		TokenProvider:  a.authToken,
		EscrowStore:    escrows,
		Metrics:        a.registry.metrics,
	})
	if err != nil {
		return nil, fmt.Errorf("anchor %q: %w", a.domain, err)
	}
	a.sep24 = client
	return client, nil
}

// RegistryConfig is the top level multi-anchor configuration.
//
// The JSON form is what operators deploy:
//
//	{
//	  "anchors": {
//	    "anclap": {
//	      "domain": "anclap.com",
//	      "web_auth_endpoint": "https://anclap.com/auth",
//	      "transfer_server": "https://anclap.com/sep24",
//	      "quote_server": "https://anclap.com/sep38",
//	      "auth_key": "tenant-a-secret"
//	    },
//	    "moneygram": { "domain": "moneygram.com", "...": "..." }
//	  }
//	}
type RegistryConfig struct {
	Anchors map[string]AnchorConfig `json:"anchors"`

	// Runtime dependencies. Never serialized.
	HTTPClient  *http.Client       `json:"-"`
	EscrowStore EscrowStore        `json:"-"`
	Limiter     *Limiter           `json:"-"`
	KeyManager  signer.KeyManager  `json:"-"`
	Metrics     *telemetry.Metrics `json:"-"`
}

// EscrowTarget identifies the anchor an escrow must be routed to. Its anchor
// domain comes from the on-chain escrow record, so routing is driven by the
// escrow itself rather than by a global default.
type EscrowTarget struct {
	EscrowID     uint64 `json:"escrow_id"`
	AnchorDomain string `json:"anchor_domain"`
}

// Registry routes anchor operations to per-tenant clients by domain.
type Registry struct {
	mu      sync.RWMutex
	anchors map[string]*Anchor
	domains []string

	httpClient  *http.Client
	escrowStore EscrowStore
	limiter     *Limiter
	keyManager  signer.KeyManager
	metrics     *telemetry.Metrics
}

// NewRegistry validates the configuration and builds an isolated anchor
// registry.
func NewRegistry(cfg RegistryConfig) (*Registry, error) {
	if len(cfg.Anchors) == 0 {
		return nil, fmt.Errorf("%w: at least one anchor must be configured", ErrInvalidAnchorConfig)
	}

	registry := &Registry{
		anchors:     make(map[string]*Anchor, len(cfg.Anchors)),
		httpClient:  cfg.HTTPClient,
		escrowStore: cfg.EscrowStore,
		limiter:     cfg.Limiter,
		keyManager:  cfg.KeyManager,
		metrics:     cfg.Metrics,
	}
	if registry.httpClient == nil {
		registry.httpClient = &http.Client{Timeout: 15 * time.Second}
	}

	names := make([]string, 0, len(cfg.Anchors))
	for name := range cfg.Anchors {
		names = append(names, name)
	}
	sort.Strings(names)

	limitCfg := DefaultConfig()
	hasCustomLimits := false

	for _, name := range names {
		normalized, err := cfg.Anchors[name].normalize(name)
		if err != nil {
			return nil, err
		}
		if _, duplicate := registry.anchors[normalized.Domain]; duplicate {
			return nil, fmt.Errorf("%w: %q", ErrDuplicateAnchor, normalized.Domain)
		}
		registry.anchors[normalized.Domain] = &Anchor{
			cfg:      normalized,
			domain:   normalized.Domain,
			registry: registry,
		}
		registry.domains = append(registry.domains, normalized.Domain)

		if normalized.RateLimit != nil {
			limitCfg.Anchors[normalized.Domain] = *normalized.RateLimit
			hasCustomLimits = true
		}
	}

	if registry.limiter == nil && hasCustomLimits {
		registry.limiter = NewLimiter(limitCfg)
	}

	return registry, nil
}

// ParseRegistryConfig decodes a multi-anchor JSON document.
func ParseRegistryConfig(data []byte) (RegistryConfig, error) {
	var cfg RegistryConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return RegistryConfig{}, fmt.Errorf("%w: failed to parse anchors JSON: %v", ErrInvalidAnchorConfig, err)
	}
	return cfg, nil
}

// LoadRegistryConfig reads a multi-anchor JSON document from disk.
func LoadRegistryConfig(path string) (RegistryConfig, error) {
	if strings.TrimSpace(path) == "" {
		return RegistryConfig{}, fmt.Errorf("%w: configuration path is required", ErrInvalidAnchorConfig)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return RegistryConfig{}, fmt.Errorf("%w: failed to read %s: %v", ErrInvalidAnchorConfig, path, err)
	}
	return ParseRegistryConfig(data)
}

// httpClientFor builds a per-anchor HTTP client. The transport is shared (so
// connection pools are reused), but the token provider injected into each
// client's SEP-10/SEP-24/SEP-38 wrapper is bound to that anchor alone.
func (r *Registry) httpClientFor(cfg AnchorConfig) *http.Client {
	base := r.httpClient
	if base == nil {
		base = &http.Client{Timeout: 15 * time.Second}
	}

	transport := base.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	client := &http.Client{
		Transport:     transport,
		Timeout:       base.Timeout,
		CheckRedirect: base.CheckRedirect,
		Jar:           base.Jar,
	}

	limiter := r.limiter
	if cfg.RateLimit != nil {
		limiter = NewLimiter(Config{
			DefaultRPS:   cfg.RateLimit.RPS,
			DefaultBurst: cfg.RateLimit.Burst,
			Anchors:      map[string]LimitConfig{cfg.Domain: *cfg.RateLimit},
		})
	}
	if limiter != nil {
		client = limiter.WrapClient(client)
	}
	return client
}

// Resolve returns the anchor registered for a domain. Domains are normalized,
// so "https://Anclap.com/path" and "anclap.com:443" both resolve to anclap.com.
func (r *Registry) Resolve(domain string) (*Anchor, error) {
	normalized := normalizeDomain(domain)
	if normalized == "" {
		return nil, fmt.Errorf("%w: target anchor domain is required", ErrAnchorNotRegistered)
	}

	r.mu.RLock()
	anchor, ok := r.anchors[normalized]
	r.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrAnchorNotRegistered, normalized)
	}
	if anchor.cfg.Disabled {
		return nil, fmt.Errorf("%w: %q", ErrAnchorDisabled, normalized)
	}
	return anchor, nil
}

// Route resolves the anchor an escrow is destined for.
func (r *Registry) Route(target EscrowTarget) (*Anchor, error) {
	anchor, err := r.Resolve(target.AnchorDomain)
	if err != nil {
		return nil, fmt.Errorf("anchor: route escrow %d: %w", target.EscrowID, err)
	}
	return anchor, nil
}

// QuoteClientFor returns the SEP-38 client of the anchor an escrow targets.
func (r *Registry) QuoteClientFor(target EscrowTarget) (*SEP38Client, error) {
	anchor, err := r.Route(target)
	if err != nil {
		return nil, err
	}
	return anchor.QuoteClient()
}

// InteractiveClientFor returns the SEP-24 client of the anchor an escrow
// targets.
func (r *Registry) InteractiveClientFor(target EscrowTarget) (*SEP24Client, error) {
	anchor, err := r.Route(target)
	if err != nil {
		return nil, err
	}
	return anchor.InteractiveClient()
}

// Domains returns the registered anchor domains in stable order.
func (r *Registry) Domains() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	domains := make([]string, len(r.domains))
	copy(domains, r.domains)
	return domains
}

// Len returns the number of registered anchors.
func (r *Registry) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.domains)
}

// Anchors returns a redacted configuration snapshot for diagnostics.
func (r *Registry) Anchors() []AnchorConfig {
	r.mu.RLock()
	defer r.mu.RUnlock()

	configs := make([]AnchorConfig, 0, len(r.domains))
	for _, domain := range r.domains {
		configs = append(configs, r.anchors[domain].Config())
	}
	return configs
}
