// Package webhook implements authenticated webhook delivery for the Soroban
// Anchor Gate relay daemon.
//
// It provides a dispatcher that signs payloads with HMAC-SHA256 (carried in
// the X-Soroban-Signature: sha256=... header), retries failed deliveries with
// an exponential backoff policy (5 retries over 1 hour), and routes
// permanently failed deliveries to a dead-letter queue. Subscribers register
// webhook endpoints with secret tokens used to compute and verify signatures.
package webhook

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// SignatureHeader is the HTTP header name carrying the HMAC-SHA256 signature.
const SignatureHeader = "X-Soroban-Signature"

// SignaturePrefix prefixes the hex-encoded HMAC digest in the header value.
const SignaturePrefix = "sha256="

// DefaultMaxAttempts is the maximum number of delivery attempts (1 original +
// 5 retries) before a message is dead-lettered.
const DefaultMaxAttempts = 6

// DefaultBaseDelay is the initial delay between delivery attempts.
const DefaultBaseDelay = 1 * time.Minute

// DefaultMaxDelay caps the per-attempt backoff delay.
const DefaultMaxDelay = 16 * time.Minute

// DefaultDeadline bounds the total time spent retrying a single event.
const DefaultDeadline = 1 * time.Hour

// Subscriber is a registered webhook endpoint. The Secret token is shared
// between the relay and the subscriber and is used to compute/verify the
// HMAC-SHA256 signature of each delivered payload.
type Subscriber struct {
	ID        string    `json:"id"`
	URL       string    `json:"url"`
	Secret    string    `json:"secret"`
	Active    bool      `json:"active"`
	CreatedAt time.Time `json:"created_at"`
}

// Event is the payload delivered to webhook subscribers when an escrow state
// changes (Funded, Disbursed, Disputed, ...).
type Event struct {
	ID        string                 `json:"id"`
	Type      string                 `json:"type"` // e.g. "escrow.funded", "escrow.disbursed", "escrow.disputed"
	EscrowID  string                 `json:"escrow_id"`
	State     string                 `json:"state"`
	Timestamp int64                  `json:"timestamp"`
	Data      map[string]interface{} `json:"data,omitempty"`
}

// DeliveryStatus describes the lifecycle state of a delivery attempt.
type DeliveryStatus string

const (
	StatusPending    DeliveryStatus = "pending"
	StatusDelivered  DeliveryStatus = "delivered"
	StatusFailed     DeliveryStatus = "failed"
	StatusDeadLetter DeliveryStatus = "dead_lettered"
)

// DeliveryRecord tracks the outcome of delivering one event to one subscriber.
type DeliveryRecord struct {
	EventID      string         `json:"event_id"`
	SubscriberID string         `json:"subscriber_id"`
	Status       DeliveryStatus `json:"status"`
	Attempts     int            `json:"attempts"`
	LastError    string         `json:"last_error,omitempty"`
	LastAttempt  time.Time      `json:"last_attempt"`
	CreatedAt    time.Time      `json:"created_at"`
}

// DeadLetterEntry records a permanently failed delivery along with the
// original payload so it can be inspected and replayed later.
type DeadLetterEntry struct {
	Record   DeliveryRecord `json:"record"`
	Payload  []byte         `json:"payload"`
	FailedAt time.Time      `json:"failed_at"`
}

// BackoffPolicy computes the delay to wait before the next delivery attempt.
type BackoffPolicy interface {
	// NextAttempt returns the delay to wait before attempt number `attempt`
	// (1-based, where 1 is the first attempt). A return value of zero means
	// retry immediately.
	NextAttempt(attempt int) time.Duration
	// MaxAttempts returns the maximum number of delivery attempts allowed.
	MaxAttempts() int
}

// ExponentialBackoff implements an exponential backoff retry policy. The delay
// grows as baseDelay * 2^(attempt-1), capped at maxDelay, and the total number
// of attempts is bounded by maxAttempts.
//
// With the defaults (baseDelay=1m, maxDelay=16m, maxAttempts=6) the cumulative
// retry window stays under one hour, matching the "5 retries over 1 hour"
// requirement.
type ExponentialBackoff struct {
	baseDelay   time.Duration
	maxDelay    time.Duration
	maxAttempts int
}

// NewExponentialBackoff constructs an ExponentialBackoff with the given
// parameters. Non-positive baseDelay/maxDelay fall back to the package
// defaults; a non-positive maxAttempts falls back to DefaultMaxAttempts.
func NewExponentialBackoff(baseDelay, maxDelay time.Duration, maxAttempts int) *ExponentialBackoff {
	if baseDelay <= 0 {
		baseDelay = DefaultBaseDelay
	}
	if maxDelay <= 0 {
		maxDelay = DefaultMaxDelay
	}
	if maxAttempts <= 0 {
		maxAttempts = DefaultMaxAttempts
	}
	return &ExponentialBackoff{
		baseDelay:   baseDelay,
		maxDelay:    maxDelay,
		maxAttempts: maxAttempts,
	}
}

// NextAttempt returns the exponential backoff delay for the given attempt.
func (b *ExponentialBackoff) NextAttempt(attempt int) time.Duration {
	if attempt <= 1 {
		return 0
	}
	// delay = baseDelay * 2^(attempt-2) because attempt 1 is the first try.
	delay := b.baseDelay
	for i := 2; i < attempt; i++ {
		delay *= 2
		if delay >= b.maxDelay {
			delay = b.maxDelay
			break
		}
	}
	if delay > b.maxDelay {
		delay = b.maxDelay
	}
	return delay
}

// MaxAttempts returns the maximum number of delivery attempts allowed.
func (b *ExponentialBackoff) MaxAttempts() int {
	return b.maxAttempts
}

// DeadLetterHandler is invoked when a delivery exhausts all retries and is
// moved to the dead-letter queue.
type DeadLetterHandler func(entry DeadLetterEntry)

// Dispatcher delivers events to registered webhook subscribers with HMAC-SHA256
// authentication, exponential backoff retries, and dead-lettering.
type Dispatcher struct {
	subscribers  map[string]*Subscriber
	mu           sync.RWMutex
	httpClient   *http.Client
	backoff      BackoffPolicy
	deadLetter   []DeadLetterEntry
	dlMu         sync.Mutex
	onDeadLetter DeadLetterHandler
}

// NewDispatcher creates a Dispatcher with the given HTTP client and backoff
// policy. A nil httpClient uses http.DefaultClient; a nil backoff uses the
// package default exponential backoff.
func NewDispatcher(httpClient *http.Client, backoff BackoffPolicy) *Dispatcher {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	if backoff == nil {
		backoff = NewExponentialBackoff(DefaultBaseDelay, DefaultMaxDelay, DefaultMaxAttempts)
	}
	return &Dispatcher{
		subscribers: make(map[string]*Subscriber),
		httpClient:  httpClient,
		backoff:     backoff,
	}
}

// OnDeadLetter sets an optional handler invoked whenever a delivery is
// dead-lettered after exhausting all retries.
func (d *Dispatcher) OnDeadLetter(handler DeadLetterHandler) {
	d.mu.Lock()
	d.onDeadLetter = handler
	d.mu.Unlock()
}

// RegisterSubscriber registers (or updates) a webhook subscriber. An empty ID
// returns an error; an empty secret or URL returns an error.
func (d *Dispatcher) RegisterSubscriber(sub *Subscriber) error {
	if sub == nil {
		return fmt.Errorf("subscriber cannot be nil")
	}
	if strings.TrimSpace(sub.ID) == "" {
		return fmt.Errorf("subscriber id cannot be empty")
	}
	if strings.TrimSpace(sub.URL) == "" {
		return fmt.Errorf("subscriber url cannot be empty")
	}
	if strings.TrimSpace(sub.Secret) == "" {
		return fmt.Errorf("subscriber secret cannot be empty")
	}
	if sub.CreatedAt.IsZero() {
		sub.CreatedAt = time.Now().UTC()
	}

	d.mu.Lock()
	d.subscribers[sub.ID] = sub
	d.mu.Unlock()
	return nil
}

// UnregisterSubscriber removes a subscriber by ID. It returns an error if no
// subscriber with that ID exists.
func (d *Dispatcher) UnregisterSubscriber(id string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, exists := d.subscribers[id]; !exists {
		return fmt.Errorf("subscriber %s not found", id)
	}
	delete(d.subscribers, id)
	return nil
}

// GetSubscriber returns the subscriber with the given ID, or nil if none is
// registered. The returned pointer is a copy to avoid callers mutating
// internal state.
func (d *Dispatcher) GetSubscriber(id string) *Subscriber {
	d.mu.RLock()
	defer d.mu.RUnlock()
	sub, ok := d.subscribers[id]
	if !ok {
		return nil
	}
	copy := *sub
	return &copy
}

// ListSubscribers returns all registered subscribers (active and inactive).
func (d *Dispatcher) ListSubscribers() []*Subscriber {
	d.mu.RLock()
	defer d.mu.RUnlock()
	list := make([]*Subscriber, 0, len(d.subscribers))
	for _, sub := range d.subscribers {
		copy := *sub
		list = append(list, &copy)
	}
	return list
}

// DeadLetter returns a snapshot of all dead-lettered deliveries.
func (d *Dispatcher) DeadLetter() []DeadLetterEntry {
	d.dlMu.Lock()
	defer d.dlMu.Unlock()
	out := make([]DeadLetterEntry, 0, len(d.deadLetter))
	for _, entry := range d.deadLetter {
		out = append(out, entry)
	}
	return out
}

// Deliver delivers an event to every active subscriber. Delivery to each
// subscriber runs concurrently. It returns an aggregate error describing any
// subscriber that could not be delivered to (even after retries); individual
// failures are also recorded in the dead-letter queue.
//
// A nil context causes delivery to use context.Background.
func (d *Dispatcher) Deliver(ctx context.Context, event Event) error {
	if ctx == nil {
		ctx = context.Background()
	}

	payload, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event %s: %w", event.ID, err)
	}

	d.mu.RLock()
	subs := make([]*Subscriber, 0, len(d.subscribers))
	for _, sub := range d.subscribers {
		if sub.Active {
			subs = append(subs, sub)
		}
	}
	d.mu.RUnlock()

	if len(subs) == 0 {
		return nil
	}

	var (
		wg   sync.WaitGroup
		mu   sync.Mutex
		errs []error
	)
	for _, sub := range subs {
		wg.Add(1)
		go func(s *Subscriber) {
			defer wg.Done()
			if err := d.deliverWithRetry(ctx, s, payload, event.ID); err != nil {
				mu.Lock()
				errs = append(errs, fmt.Errorf("subscriber %s (%s): %w", s.ID, s.URL, err))
				mu.Unlock()
			}
		}(sub)
	}
	wg.Wait()

	if len(errs) > 0 {
		return &MultiError{Errors: errs}
	}
	return nil
}

// deliverWithRetry delivers a payload to a single subscriber, retrying with
// exponential backoff until success or until attempts are exhausted, in which
// case the delivery is dead-lettered.
func (d *Dispatcher) deliverWithRetry(ctx context.Context, sub *Subscriber, payload []byte, eventID string) error {
	var lastErr error
	record := DeliveryRecord{
		EventID:      eventID,
		SubscriberID: sub.ID,
		Status:       StatusPending,
		CreatedAt:    time.Now().UTC(),
	}

	maxAttempts := d.backoff.MaxAttempts()
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if attempt > 1 {
			delay := d.backoff.NextAttempt(attempt)
			if err := d.sleep(ctx, delay); err != nil {
				record.Status = StatusFailed
				record.LastError = err.Error()
				record.LastAttempt = time.Now().UTC()
				record.Attempts = attempt - 1
				return err
			}
		}

		record.Attempts = attempt
		record.LastAttempt = time.Now().UTC()
		err := d.deliverOnce(ctx, sub, payload)
		if err == nil {
			record.Status = StatusDelivered
			record.LastError = ""
			return nil
		}
		lastErr = err
		record.LastError = err.Error()
	}

	// Exhausted all retries: dead-letter the delivery.
	record.Status = StatusDeadLetter
	entry := DeadLetterEntry{
		Record:   record,
		Payload:  payload,
		FailedAt: time.Now().UTC(),
	}
	d.dlMu.Lock()
	d.deadLetter = append(d.deadLetter, entry)
	d.dlMu.Unlock()

	d.mu.RLock()
	handler := d.onDeadLetter
	d.mu.RUnlock()
	if handler != nil {
		handler(entry)
	}

	if lastErr == nil {
		lastErr = fmt.Errorf("delivery exhausted after %d attempts", maxAttempts)
	}
	return lastErr
}

// deliverOnce performs a single signed HTTP POST delivery attempt.
func (d *Dispatcher) deliverOnce(ctx context.Context, sub *Subscriber, payload []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, sub.URL, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(SignatureHeader, SignaturePrefix+sign(sub.Secret, payload))

	resp, err := d.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body) // nolint:errcheck

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("delivery rejected with status %d", resp.StatusCode)
	}
	return nil
}

// sign computes the HMAC-SHA256 of payload using secret and returns the
// lowercase hex digest.
func sign(secret string, payload []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(payload) // nolint:errcheck
	return hex.EncodeToString(mac.Sum(nil))
}

// VerifySignature validates that the given signature header matches an
// HMAC-SHA256 of payload computed with secret. It returns true when the header
// has the form "sha256=<hex>" (or is a bare hex digest) and the digest matches
// using constant-time comparison.
func VerifySignature(secret string, payload []byte, signature string) bool {
	expected := sign(secret, payload)
	// Strip the "sha256=" prefix if the caller passed a full header value.
	signature = strings.TrimPrefix(signature, SignaturePrefix)
	return hmac.Equal([]byte(signature), []byte(expected))
}

// sleep waits for delay, returning early if ctx is cancelled.
func (d *Dispatcher) sleep(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// MultiError aggregates multiple delivery errors into a single error.
type MultiError struct {
	Errors []error
}

// Error formats the aggregated errors.
func (m *MultiError) Error() string {
	if len(m.Errors) == 0 {
		return "no errors"
	}
	msg := "webhook delivery failed for "
	for i, err := range m.Errors {
		if i > 0 {
			msg += "; "
		}
		msg += err.Error()
	}
	return msg
}
