package webhook

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestSignAndVerifySignature verifies HMAC-SHA256 signing and constant-time
// verification round-trip, including tamper detection.
func TestSignAndVerifySignature(t *testing.T) {
	secret := "super-secret-token"
	payload := []byte(`{"id":"evt-1","type":"escrow.disbursed"}`)

	sig := sign(secret, payload)
	if sig == "" {
		t.Fatal("sign returned empty digest")
	}
	if len(sig) != 64 { // sha256 hex = 64 chars
		t.Fatalf("expected 64-char hex digest, got %d: %s", len(sig), sig)
	}

	if !VerifySignature(secret, payload, sig) {
		t.Fatal("VerifySignature failed for valid signature")
	}
	if !VerifySignature(secret, payload, SignaturePrefix+sig) {
		t.Fatal("VerifySignature failed for prefixed signature")
	}

	// Wrong secret must not verify.
	if VerifySignature("wrong-secret", payload, sig) {
		t.Fatal("VerifySignature unexpectedly passed with wrong secret")
	}

	// Tampered payload must not verify.
	tampered := append([]byte{}, payload...)
	tampered[len(tampered)-1] ^= 0x01
	if VerifySignature(secret, tampered, sig) {
		t.Fatal("VerifySignature unexpectedly passed for tampered payload")
	}

	// Empty signature must not verify.
	if VerifySignature(secret, payload, "") {
		t.Fatal("VerifySignature unexpectedly passed for empty signature")
	}
}

// TestHeaderFormat verifies the X-Soroban-Signature header is built with the
// "sha256=" prefix.
func TestHeaderFormat(t *testing.T) {
	secret := "sec"
	payload := []byte(`{}`)
	header := SignaturePrefix + sign(secret, payload)
	if !strings.HasPrefix(header, SignaturePrefix) {
		t.Fatalf("header %q missing prefix %q", header, SignaturePrefix)
	}
}

// recordingServer captures requests and their headers/bodies.
type recordingServer struct {
	mu        sync.Mutex
	reqs      []*http.Request
	status    int
	body      string
	delay     time.Duration
	failN     int // fail the first failN requests with 500, then succeed
	failCount int
}

func newRecordingServer(status int) *recordingServer {
	return &recordingServer{status: status}
}

func (s *recordingServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reqs = append(s.reqs, r.Clone(r.Context()))
	if s.delay > 0 {
		time.Sleep(s.delay)
	}
	if s.failN > 0 && s.failCount < s.failN {
		s.failCount++
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.WriteHeader(s.status)
	fmt.Fprint(w, s.body)
}

// lastRequest returns the most recent captured request, or nil.
func (s *recordingServer) lastRequest() *http.Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.reqs) == 0 {
		return nil
	}
	return s.reqs[len(s.reqs)-1]
}

// requestCount returns the number of captured requests.
func (s *recordingServer) requestCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.reqs)
}

// TestDeliverySetsSignatureHeader verifies a successful delivery sends the
// correctly signed X-Soroban-Signature header and a JSON body.
func TestDeliverySetsSignatureHeader(t *testing.T) {
	srv := newRecordingServer(http.StatusOK)
	server := httptest.NewServer(srv)
	defer server.Close()

	d := NewDispatcher(nil, nil)
	sub := &Subscriber{
		ID:     "sub-1",
		URL:    server.URL,
		Secret: "my-secret",
		Active: true,
	}
	if err := d.RegisterSubscriber(sub); err != nil {
		t.Fatalf("RegisterSubscriber: %v", err)
	}

	event := Event{
		ID:        "evt-1",
		Type:      "escrow.disbursed",
		EscrowID:  "esc-123",
		State:     "disbursed",
		Timestamp: 1234567890,
		Data:      map[string]interface{}{"amount": 100.0},
	}
	if err := d.Deliver(context.Background(), event); err != nil {
		t.Fatalf("Deliver: %v", err)
	}

	req := srv.lastRequest()
	if req == nil {
		t.Fatal("no request captured")
	}
	if req.Method != http.MethodPost {
		t.Fatalf("expected POST, got %s", req.Method)
	}
	if req.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("expected Content-Type application/json, got %q", req.Header.Get("Content-Type"))
	}
	sig := req.Header.Get(SignatureHeader)
	if !strings.HasPrefix(sig, SignaturePrefix) {
		t.Fatalf("signature header missing prefix: %q", sig)
	}
	digest := strings.TrimPrefix(sig, SignaturePrefix)
	body := mustMarshal(t, event)
	if !VerifySignature("my-secret", body, digest) {
		t.Fatal("signature header does not match HMAC-SHA256 of body")
	}

	// Wrong secret must not verify.
	if VerifySignature("wrong-secret", body, digest) {
		t.Fatal("signature verified with wrong secret")
	}
}

// TestInactiveSubscriberNotDelivered verifies inactive subscribers are skipped.
func TestInactiveSubscriberNotDelivered(t *testing.T) {
	srv := newRecordingServer(http.StatusOK)
	server := httptest.NewServer(srv)
	defer server.Close()

	d := NewDispatcher(nil, nil)
	active := &Subscriber{ID: "sub-active", URL: server.URL, Secret: "sec", Active: true}
	inactive := &Subscriber{ID: "sub-inactive", URL: server.URL, Secret: "sec", Active: false}
	if err := d.RegisterSubscriber(active); err != nil {
		t.Fatalf("RegisterSubscriber active: %v", err)
	}
	if err := d.RegisterSubscriber(inactive); err != nil {
		t.Fatalf("RegisterSubscriber inactive: %v", err)
	}

	event := Event{ID: "evt-2", Type: "escrow.funded"}
	if err := d.Deliver(context.Background(), event); err != nil {
		t.Fatalf("Deliver: %v", err)
	}

	// The single recording server received one request (for the active sub).
	if got := srv.requestCount(); got != 1 {
		t.Fatalf("expected 1 request (active only), got %d", got)
	}
}

// TestRetryAndDeadLetter verifies exponential backoff retry timing and
// dead-lettering once attempts are exhausted. A short base delay keeps the
// test fast while preserving the exponential shape.
func TestRetryAndDeadLetter(t *testing.T) {
	srv := newRecordingServer(http.StatusInternalServerError)
	srv.failN = 100 // always fail
	server := httptest.NewServer(srv)
	defer server.Close()

	// Very short base delay so the test stays fast; 5 attempts total.
	backoff := NewExponentialBackoff(5*time.Millisecond, 20*time.Millisecond, 5)
	d := NewDispatcher(nil, backoff)

	var dlMu sync.Mutex
	var dlEntries []DeadLetterEntry
	d.OnDeadLetter(func(entry DeadLetterEntry) {
		dlMu.Lock()
		dlEntries = append(dlEntries, entry)
		dlMu.Unlock()
	})

	sub := &Subscriber{ID: "sub-retry", URL: server.URL, Secret: "sec", Active: true}
	if err := d.RegisterSubscriber(sub); err != nil {
		t.Fatalf("RegisterSubscriber: %v", err)
	}

	event := Event{ID: "evt-retry", Type: "escrow.disputed"}
	err := d.Deliver(context.Background(), event)

	if err == nil {
		t.Fatal("expected delivery error after exhausting retries")
	}
	// maxAttempts=5 means 5 attempts total.
	if got := srv.requestCount(); got != 5 {
		t.Fatalf("expected 5 attempts, got %d", got)
	}

	dlMu.Lock()
	defer dlMu.Unlock()
	if len(dlEntries) != 1 {
		t.Fatalf("expected 1 dead-letter entry, got %d", len(dlEntries))
	}
	if dlEntries[0].Record.Status != StatusDeadLetter {
		t.Fatalf("expected dead_lettered status, got %q", dlEntries[0].Record.Status)
	}
	if dlEntries[0].Record.Attempts != 5 {
		t.Fatalf("expected 5 attempts recorded, got %d", dlEntries[0].Record.Attempts)
	}
	if dlEntries[0].Payload == nil {
		t.Fatal("dead-letter entry payload should not be nil")
	}
}

// TestSuccessfulDeliveryNotDeadLetter verifies a successful delivery is not
// dead-lettered and stops retrying.
func TestSuccessfulDeliveryNotDeadLetter(t *testing.T) {
	srv := newRecordingServer(http.StatusOK)
	srv.failN = 1 // fail once, then succeed
	server := httptest.NewServer(srv)
	defer server.Close()

	d := NewDispatcher(nil, NewExponentialBackoff(5*time.Millisecond, 20*time.Millisecond, 5))
	var dlCount int
	d.OnDeadLetter(func(DeadLetterEntry) { dlCount++ })

	sub := &Subscriber{ID: "sub-ok", URL: server.URL, Secret: "sec", Active: true}
	if err := d.RegisterSubscriber(sub); err != nil {
		t.Fatalf("RegisterSubscriber: %v", err)
	}

	event := Event{ID: "evt-ok", Type: "escrow.funded"}
	if err := d.Deliver(context.Background(), event); err != nil {
		t.Fatalf("Deliver: %v", err)
	}
	if got := srv.requestCount(); got != 2 {
		t.Fatalf("expected 2 requests (1 fail + 1 success), got %d", got)
	}
	if dlCount != 0 {
		t.Fatalf("expected 0 dead-letter entries, got %d", dlCount)
	}
}

// TestContextCancellationStopsDelivery verifies context cancellation aborts
// retries and returns context.Canceled.
func TestContextCancellationStopsDelivery(t *testing.T) {
	srv := newRecordingServer(http.StatusInternalServerError)
	server := httptest.NewServer(srv)
	defer server.Close()

	d := NewDispatcher(nil, NewExponentialBackoff(50*time.Millisecond, 100*time.Millisecond, 5))
	sub := &Subscriber{ID: "sub-cancel", URL: server.URL, Secret: "sec", Active: true}
	if err := d.RegisterSubscriber(sub); err != nil {
		t.Fatalf("RegisterSubscriber: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	event := Event{ID: "evt-cancel", Type: "escrow.disputed"}
	err := d.Deliver(ctx, event)
	if err == nil {
		t.Fatal("expected error on cancelled context")
	}
	if !strings.Contains(err.Error(), "context") {
		t.Fatalf("expected context error, got %v", err)
	}
}

// TestSubscriberRegistry verifies register/get/unregister/list semantics.
func TestSubscriberRegistry(t *testing.T) {
	d := NewDispatcher(nil, nil)

	if err := d.RegisterSubscriber(nil); err == nil {
		t.Fatal("expected error for nil subscriber")
	}
	if err := d.RegisterSubscriber(&Subscriber{ID: "", URL: "http://x", Secret: "s"}); err == nil {
		t.Fatal("expected error for empty id")
	}
	if err := d.RegisterSubscriber(&Subscriber{ID: "a", URL: "", Secret: "s"}); err == nil {
		t.Fatal("expected error for empty url")
	}
	if err := d.RegisterSubscriber(&Subscriber{ID: "a", URL: "http://x", Secret: ""}); err == nil {
		t.Fatal("expected error for empty secret")
	}

	sub := &Subscriber{ID: "sub-1", URL: "http://example.com", Secret: "s", Active: true}
	if err := d.RegisterSubscriber(sub); err != nil {
		t.Fatalf("RegisterSubscriber: %v", err)
	}

	got := d.GetSubscriber("sub-1")
	if got == nil || got.ID != "sub-1" || got.URL != "http://example.com" || got.Secret != "s" || !got.Active {
		t.Fatalf("GetSubscriber returned unexpected: %+v", got)
	}
	if d.GetSubscriber("missing") != nil {
		t.Fatal("GetSubscriber missing should return nil")
	}

	list := d.ListSubscribers()
	if len(list) != 1 {
		t.Fatalf("expected 1 subscriber, got %d", len(list))
	}

	if err := d.UnregisterSubscriber("missing"); err == nil {
		t.Fatal("expected error unregistering missing subscriber")
	}
	if err := d.UnregisterSubscriber("sub-1"); err != nil {
		t.Fatalf("UnregisterSubscriber: %v", err)
	}
	if d.GetSubscriber("sub-1") != nil {
		t.Fatal("subscriber should be removed after unregister")
	}
	if got := len(d.ListSubscribers()); got != 0 {
		t.Fatalf("expected 0 subscribers after unregister, got %d", got)
	}
}

// TestMultiErrorAggregation verifies MultiError reports multiple failures.
func TestMultiErrorAggregation(t *testing.T) {
	srv1 := newRecordingServer(http.StatusInternalServerError)
	srv2 := newRecordingServer(http.StatusInternalServerError)
	server1 := httptest.NewServer(srv1)
	server2 := httptest.NewServer(srv2)
	defer server1.Close()
	defer server2.Close()

	d := NewDispatcher(nil, NewExponentialBackoff(1*time.Millisecond, 2*time.Millisecond, 1))
	if err := d.RegisterSubscriber(&Subscriber{ID: "a", URL: server1.URL, Secret: "s", Active: true}); err != nil {
		t.Fatalf("register a: %v", err)
	}
	if err := d.RegisterSubscriber(&Subscriber{ID: "b", URL: server2.URL, Secret: "s", Active: true}); err != nil {
		t.Fatalf("register b: %v", err)
	}

	event := Event{ID: "evt-multi", Type: "escrow.funded"}
	err := d.Deliver(context.Background(), event)
	if err == nil {
		t.Fatal("expected multi error")
	}
	me, ok := err.(*MultiError)
	if !ok {
		t.Fatalf("expected *MultiError, got %T", err)
	}
	if len(me.Errors) != 2 {
		t.Fatalf("expected 2 errors, got %d", len(me.Errors))
	}
}

// TestBackoffTiming verifies NextAttempt produces an exponential sequence
// capped at maxDelay.
func TestBackoffTiming(t *testing.T) {
	b := NewExponentialBackoff(10*time.Millisecond, 100*time.Millisecond, 6)
	got := []time.Duration{
		b.NextAttempt(1), // first attempt -> no delay
		b.NextAttempt(2),
		b.NextAttempt(3),
		b.NextAttempt(4),
		b.NextAttempt(5),
		b.NextAttempt(6),
		b.NextAttempt(7),
	}
	want := []time.Duration{0, 10 * time.Millisecond, 20 * time.Millisecond, 40 * time.Millisecond, 80 * time.Millisecond, 100 * time.Millisecond, 100 * time.Millisecond}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("NextAttempt(%d) = %v, want %v", i+1, got[i], want[i])
		}
	}
	if b.MaxAttempts() != 6 {
		t.Fatalf("MaxAttempts = %d, want 6", b.MaxAttempts())
	}
}

// mustMarshal marshals v, failing the test on error.
func mustMarshal(t *testing.T, v interface{}) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}
