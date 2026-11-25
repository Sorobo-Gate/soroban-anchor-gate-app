package listener

import (
	"context"
	"fmt"
	"math"
	"math/rand"
	"sync"
	"time"
)

// ConnectionState represents the lifecycle state of the RPC listener connection.
type ConnectionState string

const (
	StateDisconnected ConnectionState = "DISCONNECTED"
	StateConnecting   ConnectionState = "CONNECTING"
	StateConnected    ConnectionState = "CONNECTED"
	StateReconnecting ConnectionState = "RECONNECTING"
	StateBackfilling  ConnectionState = "BACKFILLING"
)

// BackoffConfig configures the exponential backoff with jitter algorithm.
type BackoffConfig struct {
	InitialInterval time.Duration // Default: 1s
	MaxInterval     time.Duration // Default: 60s
	Multiplier      float64       // Default: 2.0
	JitterFactor    float64       // Default: 0.2 (+/- 20%)
}

// DefaultBackoffConfig returns the standard production backoff configuration.
func DefaultBackoffConfig() BackoffConfig {
	return BackoffConfig{
		InitialInterval: 1 * time.Second,
		MaxInterval:     60 * time.Second,
		Multiplier:      2.0,
		JitterFactor:    0.2,
	}
}

// ReconnectStateMachine manages connection transitions and backoff calculations.
type ReconnectStateMachine struct {
	mu           sync.RWMutex
	state        ConnectionState
	config       BackoffConfig
	attempts     int
	lastError    error
	onTransition func(oldState, newState ConnectionState)
	randSource   *rand.Rand
}

// NewReconnectStateMachine creates a state machine configured with backoff parameters.
func NewReconnectStateMachine(cfg BackoffConfig) *ReconnectStateMachine {
	if cfg.InitialInterval <= 0 {
		cfg.InitialInterval = 1 * time.Second
	}
	if cfg.MaxInterval <= 0 {
		cfg.MaxInterval = 60 * time.Second
	}
	if cfg.Multiplier <= 1.0 {
		cfg.Multiplier = 2.0
	}
	if cfg.JitterFactor <= 0 {
		cfg.JitterFactor = 0.2
	}

	return &ReconnectStateMachine{
		state:      StateDisconnected,
		config:     cfg,
		randSource: rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

// State returns the current connection state.
func (sm *ReconnectStateMachine) State() ConnectionState {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.state
}

// Transition moves the state machine to a new state and invokes registered hooks.
func (sm *ReconnectStateMachine) Transition(newState ConnectionState) {
	sm.mu.Lock()
	oldState := sm.state
	if oldState == newState {
		sm.mu.Unlock()
		return
	}
	sm.state = newState
	hook := sm.onTransition
	sm.mu.Unlock()

	if hook != nil {
		hook(oldState, newState)
	}
}

// SetOnTransition registers a callback invoked whenever the connection state transitions.
func (sm *ReconnectStateMachine) SetOnTransition(fn func(oldState, newState ConnectionState)) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.onTransition = fn
}

// Attempts returns the count of consecutive failed connection attempts.
func (sm *ReconnectStateMachine) Attempts() int {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.attempts
}

// LastError returns the most recent connection failure error.
func (sm *ReconnectStateMachine) LastError() error {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.lastError
}

// RecordFailure registers a disconnection or RPC failure, increments attempts, and calculates the next backoff.
func (sm *ReconnectStateMachine) RecordFailure(err error) time.Duration {
	sm.mu.Lock()
	sm.attempts++
	sm.lastError = err
	attempt := sm.attempts
	sm.mu.Unlock()

	sm.Transition(StateReconnecting)
	return sm.CalculateBackoff(attempt)
}

// RecordSuccess resets failure attempts and transitions state to Connected.
func (sm *ReconnectStateMachine) RecordSuccess() {
	sm.mu.Lock()
	sm.attempts = 0
	sm.lastError = nil
	sm.mu.Unlock()

	sm.Transition(StateConnected)
}

// CalculateBackoff computes the exponential backoff duration with jitter for a given attempt index (1-based).
// Formula: base = min(MaxInterval, InitialInterval * (Multiplier ^ (attempt - 1)))
// Jitter: +/- (base * JitterFactor * rand[-1.0, 1.0])
func (sm *ReconnectStateMachine) CalculateBackoff(attempt int) time.Duration {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if attempt <= 1 {
		return sm.applyJitter(sm.config.InitialInterval)
	}

	mult := math.Pow(sm.config.Multiplier, float64(attempt-1))
	baseSec := sm.config.InitialInterval.Seconds() * mult
	maxSec := sm.config.MaxInterval.Seconds()

	if baseSec > maxSec || math.IsInf(baseSec, 0) {
		baseSec = maxSec
	}

	baseDuration := time.Duration(baseSec * float64(time.Second))
	return sm.applyJitter(baseDuration)
}

func (sm *ReconnectStateMachine) applyJitter(base time.Duration) time.Duration {
	if sm.config.JitterFactor <= 0 {
		return base
	}

	// Jitter range: [-JitterFactor, +JitterFactor]
	jitterPercent := (sm.randSource.Float64()*2.0 - 1.0) * sm.config.JitterFactor
	jitterDelta := float64(base) * jitterPercent

	result := time.Duration(float64(base) + jitterDelta)
	if result < 0 {
		result = 0
	}
	return result
}

// WaitForBackoff blocks until the backoff duration elapses or the context is cancelled.
func (sm *ReconnectStateMachine) WaitForBackoff(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// Config returns the active backoff configuration.
func (sm *ReconnectStateMachine) Config() BackoffConfig {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.config
}

// String returns a human-readable summary of the state machine status.
func (sm *ReconnectStateMachine) String() string {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return fmt.Sprintf("State: %s, Attempts: %d, LastErr: %v", sm.state, sm.attempts, sm.lastError)
}
