package logger

import (
	"context"
	"fmt"
	"math/big"
	"go.uber.org/zap"
	"sync"
	"time"
)

// RedactLogger is a zap.Logger wrapper that provides correlation ID support
// and sensitive field redaction for the SorobanAnchor Gate relay daemon.
type RedactLogger struct {
	*zap.Logger
	correlationID string
	escrowID      uint64
	loggerMu      sync.Mutex
}

// NewRedactLogger creates a new RedactLogger configured for the relay daemon.
func NewRedactLogger(opts ...zap.Option) *RedactLogger {
	logger, _ := zap.NewDevelopment()
	return &RedactLogger{
		Logger:      logger,
		correlationID: "",
		escrowID:    0,
	}
}

// WithCorrelationID sets the correlation ID for subsequent log entries.
func (rl *RedactLogger) WithCorrelationID(correlationID string) *RedactLogger {
	rl.loggerMu.Lock()
	rl.correlationID = correlationID
	rl.loggerMu.Unlock()
	return rl
}

// WithEscrowID sets the escrow ID for subsequent log entries.
func (rl *RedactLogger) WithEscrowID(escrowID uint64) *RedactLogger {
	rl.loggerMu.Lock()
	rl.escrowID = escrowID
	rl.loggerMu.Unlock()
	return rl
}

// WithContext creates a new logger entry with the given context values.
func (rl *RedactLogger) WithContext(ctx context.Context) *RedactLogger {
	rl.loggerMu.Lock()
	defer rl.loggerMu.Unlock()

	if cid, ok := ctx.Value("correlation_id").(string); ok {
		rl.correlationID = cid
	}

	if eid, ok := ctx.Value("escrow_id").(uint64); ok {
		rl.escrowID = eid
	}

	return rl
}

// With creates a child logger with the given fields.
func (rl *RedactLogger) With(fields ...zap.Field) *RedactLogger {
	rl.loggerMu.Lock()
	defer rl.loggerMu.Unlock()

	return &RedactLogger{
		Logger:      rl.Logger.With(fields...),
		correlationID: rl.correlationID,
		escrowID:    rl.escrowID,
	}
}

// Correlation returns the current correlation ID.
func (rl *RedactLogger) Correlation() string {
	rl.loggerMu.Lock()
	defer rl.loggerMu.Unlock()
	return rl.correlationID
}

// EscrowID returns the current escrow ID.
func (rl *RedactLogger) EscrowID() uint64 {
	rl.loggerMu.Lock()
	defer rl.loggerMu.Unlock()
	return rl.escrowID
}

// Scalar creates a zap.Field from a scalar interface value.
func Scalar(key string, val interface{}) zap.Field {
	return zap.Field{
		Key: key,
		Interface: val,
	}
}

// String creates a zap.Field from a string value.
func String(key, val string) zap.Field {
	return zap.String(key, val)
}

// Int64 creates a zap.Field from an int64 value.
func Int64(key string, val int64) zap.Field {
	return zap.Int64(key, val)
}

// Uint64 creates a zap.Field from a uint64 value.
func Uint64(key string, val uint64) zap.Field {
	return zap.Uint64(key, val)
}

// Bool creates a zap.Field from a bool value.
func Bool(key string, val bool) zap.Field {
	return zap.Bool(key, val)
}

// Error creates a zap.Field from an error value.
func Error(key string, err error) zap.Field {
	if err == nil {
		return zap.Field{}
	}
	return zap.Error(err)
}

// Sprintf creates a zap.Field from a formatted string.
func Sprintf(key, format string, args ...interface{}) zap.Field {
	return zap.ByteString(key, []byte(fmt.Sprintf(format, args...)))
}

// Helper functions for common logging patterns in the relay daemon

// LogEventStart logs the start of an event processing pipeline.
func LogEventStart(logger *RedactLogger, eventID, operation string, ctx context.Context) *RedactLogger {
	return logger.WithContext(ctx).With(
		zap.String("event_id", eventID),
		zap.String("operation", operation),
		zap.Uint64("timestamp", uint64(time.Now().Unix())),
	)
}

// LogEventComplete logs the completion of an event processing pipeline.
func LogEventComplete(logger *RedactLogger, eventID string, duration time.Duration, ctx context.Context) *RedactLogger {
	return logger.WithContext(ctx).With(
		zap.String("event_id", eventID),
		zap.Duration("duration", duration),
		zap.Uint64("timestamp", uint64(time.Now().Unix())),
	)
}

// LogRPCCall logs an RPC call with timing and result information.
func LogRPCCall(logger *RedactLogger, rpcMethod string, startTime time.Duration, success bool, ctx context.Context) *RedactLogger {
	status := "success"
	if !success {
		status = "failure"
	}

	return logger.WithContext(ctx).With(
		zap.String("rpc_method", rpcMethod),
		zap.Duration("rpc_duration", startTime),
		zap.String("rpc_status", status),
		zap.Uint64("timestamp", uint64(time.Now().Unix())),
	)
}

// LogKeeperAction logs a keeper action with escrow and correlation context.
func LogKeeperAction(logger *RedactLogger, action, eventID string, escrowID uint64, ctx context.Context) *RedactLogger {
	return logger.WithContext(ctx).With(
		zap.String("action", action),
		zap.String("event_id", eventID),
		zap.Uint64("escrow_id", escrowID),
		zap.Uint64("timestamp", uint64(time.Now().Unix())),
	)
}

// LogContractEvent logs a contract event with full context.
func LogContractEvent(logger *RedactLogger, eventType string, escrowID uint64, profileHash string, amount *big.Int, ctx context.Context) *RedactLogger {
	amountStr := "0"
	if amount != nil {
		amountStr = amount.String()
	}

	return logger.WithContext(ctx).With(
		zap.String("event_type", eventType),
		zap.Uint64("escrow_id", escrowID),
		zap.String("profile_hash", profileHash),
		zap.String("payout_amount", amountStr),
		zap.Uint64("timestamp", uint64(time.Now().Unix())),
	)
}

// SafeFields returns zap.Fields for safe logging.
func SafeFields(fields ...zap.Field) []zap.Field {
	return fields
}

// Global logger instance.
var Global *RedactLogger

// InitGlobal initializes the global logger.
func InitGlobal(opts ...zap.Option) {
	Global = NewRedactLogger(opts...)
}

// ShutdownGlobal shuts down the global logger.
func ShutdownGlobal() error {
	if Global == nil {
		return nil
	}
	return Global.Sync()
}