package listener

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// MemoHashSize is the exact byte length of a Stellar MEMO_HASH / MEMO_RETURN
// payload and of the on-chain profile_hash commitment.
const MemoHashSize = 32

// maxMemoTextSize is the maximum length of a Stellar MEMO_TEXT value (28 bytes).
const maxMemoTextSize = 28

// Sentinel errors returned by the memo parser and validator. Callers should use
// errors.Is so that added context does not break classification.
var (
	// ErrMemoMissing indicates that no transaction memo was supplied.
	ErrMemoMissing = errors.New("transaction memo is missing")
	// ErrInvalidMemoXDR indicates that the memo payload is not a valid XDR Memo union.
	ErrInvalidMemoXDR = errors.New("invalid memo XDR")
	// ErrMemoNotHash indicates that the memo parsed successfully but is not a hash memo.
	ErrMemoNotHash = errors.New("transaction memo is not a 32-byte hash memo")
	// ErrInvalidProfileHash indicates that the profile_hash commitment is malformed.
	ErrInvalidProfileHash = errors.New("invalid profile_hash commitment")
	// ErrMemoMismatch indicates that the memo hash does not match the profile_hash
	// commitment and the transaction must be rejected.
	ErrMemoMismatch = errors.New("memo hash does not match profile_hash commitment")
)

// MemoType mirrors the discriminator of the Stellar XDR Memo union.
type MemoType uint32

const (
	MemoTypeNone   MemoType = 0
	MemoTypeText   MemoType = 1
	MemoTypeID     MemoType = 2
	MemoTypeHash   MemoType = 3
	MemoTypeReturn MemoType = 4
)

// String returns the canonical name of the memo type.
func (t MemoType) String() string {
	switch t {
	case MemoTypeNone:
		return "none"
	case MemoTypeText:
		return "text"
	case MemoTypeID:
		return "id"
	case MemoTypeHash:
		return "hash"
	case MemoTypeReturn:
		return "return"
	default:
		return fmt.Sprintf("unknown(%d)", uint32(t))
	}
}

// Memo is the decoded form of a Stellar transaction memo as carried by the
// `memo` field of a payment transaction envelope.
type Memo struct {
	Type MemoType
	Text string
	ID   uint64
	Hash [MemoHashSize]byte
}

// IsHash reports whether the memo carries a 32-byte hash commitment.
func (m Memo) IsHash() bool {
	return m.Type == MemoTypeHash || m.Type == MemoTypeReturn
}

// MemoMatch is the result of comparing a transaction memo against the expected
// profile_hash commitment.
type MemoMatch struct {
	Matched        bool
	Memo           Memo
	MemoHash       [MemoHashSize]byte
	ProfileHash    [MemoHashSize]byte
	MemoHashHex    string
	ProfileHashHex string
}

// MemoAuditRecord captures a rejected transaction for audit review.
type MemoAuditRecord struct {
	MemoType       string    `json:"memo_type"`
	MemoHashHex    string    `json:"memo_hash_hex"`
	ProfileHashHex string    `json:"profile_hash_hex"`
	Reason         string    `json:"reason"`
	FlaggedAt      time.Time `json:"flagged_at"`
}

// MemoAuditSink records mismatched transactions that require audit review.
// Implementations must be safe for concurrent use.
type MemoAuditSink interface {
	FlagMemoMismatch(record MemoAuditRecord)
}

// LogMemoAuditSink flags mismatches through structured logging.
type LogMemoAuditSink struct {
	Logger *slog.Logger
}

// FlagMemoMismatch emits a warning that can be routed to the audit pipeline.
func (s LogMemoAuditSink) FlagMemoMismatch(record MemoAuditRecord) {
	logger := s.Logger
	if logger == nil {
		logger = slog.Default()
	}
	logger.Warn("transaction memo flagged for audit review",
		"reason", record.Reason,
		"memo_type", record.MemoType,
		"memo_hash", record.MemoHashHex,
		"profile_hash", record.ProfileHashHex,
		"flagged_at", record.FlaggedAt,
	)
}

// InMemoryMemoAuditSink keeps flagged records in memory. It is intended for
// tests and short-lived audit surfaces.
type InMemoryMemoAuditSink struct {
	mu      sync.Mutex
	records []MemoAuditRecord
}

// FlagMemoMismatch appends a record for later inspection.
func (s *InMemoryMemoAuditSink) FlagMemoMismatch(record MemoAuditRecord) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.records = append(s.records, record)
}

// Records returns a copy of the flagged records.
func (s *InMemoryMemoAuditSink) Records() []MemoAuditRecord {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]MemoAuditRecord, len(s.records))
	copy(out, s.records)
	return out
}

// MemoValidator validates payment transaction memos against a profile_hash
// commitment and flags mismatches for audit review.
type MemoValidator struct {
	sink   MemoAuditSink
	logger *slog.Logger
}

// NewMemoValidator creates a validator. When sink is nil, mismatches are
// flagged through logger (or slog.Default when logger is nil as well).
func NewMemoValidator(sink MemoAuditSink, logger *slog.Logger) *MemoValidator {
	return &MemoValidator{sink: sink, logger: logger}
}

// ValidatePaymentMemo parses a base64-encoded transaction memo, requires it to
// be a 32-byte hash memo, and compares it with the expected profile_hash.
// Mismatched memos are rejected with ErrMemoMismatch and flagged for audit.
func (v *MemoValidator) ValidatePaymentMemo(memoXDR, profileHashHex string) (MemoMatch, error) {
	memo, err := ParseMemoXDR(memoXDR)
	if err != nil {
		return MemoMatch{}, err
	}

	if !memo.IsHash() {
		return MemoMatch{}, fmt.Errorf("%w: got %s memo", ErrMemoNotHash, memo.Type)
	}

	profileHash, err := ParseProfileHashHex(profileHashHex)
	if err != nil {
		return MemoMatch{}, err
	}

	result := MemoMatch{
		Memo:           memo,
		MemoHash:       memo.Hash,
		ProfileHash:    profileHash,
		MemoHashHex:    FormatProfileHash(memo.Hash),
		ProfileHashHex: FormatProfileHash(profileHash),
		Matched:        subtle.ConstantTimeCompare(memo.Hash[:], profileHash[:]) == 1,
	}

	if !result.Matched {
		v.flag(MemoAuditRecord{
			MemoType:       memo.Type.String(),
			MemoHashHex:    result.MemoHashHex,
			ProfileHashHex: result.ProfileHashHex,
			Reason:         ErrMemoMismatch.Error(),
			FlaggedAt:      time.Now().UTC(),
		})
		return result, fmt.Errorf("%w: memo %s profile_hash %s", ErrMemoMismatch, result.MemoHashHex, result.ProfileHashHex)
	}

	return result, nil
}

func (v *MemoValidator) flag(record MemoAuditRecord) {
	if v == nil {
		return
	}
	sink := v.sink
	if sink == nil {
		sink = LogMemoAuditSink{Logger: v.logger}
	}
	sink.FlagMemoMismatch(record)
}

// ValidatePaymentMemo validates a payment memo using a default validator that
// logs mismatches to slog.Default.
func ValidatePaymentMemo(memoXDR, profileHashHex string) (MemoMatch, error) {
	return NewMemoValidator(nil, nil).ValidatePaymentMemo(memoXDR, profileHashHex)
}

// ParseMemoXDR decodes the base64 `memo` field of a payment transaction.
func ParseMemoXDR(encoded string) (Memo, error) {
	trimmed := strings.TrimSpace(encoded)
	if trimmed == "" {
		return Memo{}, ErrMemoMissing
	}

	raw, err := base64.StdEncoding.DecodeString(trimmed)
	if err != nil {
		return Memo{}, fmt.Errorf("%w: base64 decode: %v", ErrInvalidMemoXDR, err)
	}

	return ParseMemo(raw)
}

// ParseMemo decodes a raw XDR Memo union.
func ParseMemo(raw []byte) (Memo, error) {
	if len(raw) < 4 {
		return Memo{}, fmt.Errorf("%w: payload too short: %d bytes", ErrInvalidMemoXDR, len(raw))
	}

	memoType := MemoType(binary.BigEndian.Uint32(raw[:4]))
	body := raw[4:]

	switch memoType {
	case MemoTypeNone:
		if len(body) != 0 {
			return Memo{}, fmt.Errorf("%w: none memo carries %d trailing bytes", ErrInvalidMemoXDR, len(body))
		}
		return Memo{Type: memoType}, nil

	case MemoTypeText:
		if len(body) < 4 {
			return Memo{}, fmt.Errorf("%w: text memo length header truncated", ErrInvalidMemoXDR)
		}

		textLen := int(binary.BigEndian.Uint32(body[:4]))
		if textLen > maxMemoTextSize {
			return Memo{}, fmt.Errorf("%w: text memo exceeds %d bytes: got %d", ErrInvalidMemoXDR, maxMemoTextSize, textLen)
		}

		paddedLen := (textLen + 3) &^ 3
		if len(body) != 4+paddedLen {
			return Memo{}, fmt.Errorf("%w: text memo length mismatch: declared %d bytes (%d padded), body has %d", ErrInvalidMemoXDR, textLen, paddedLen, len(body))
		}

		textBytes := body[4 : 4+textLen]
		for _, pad := range body[4+textLen:] {
			if pad != 0 {
				return Memo{}, fmt.Errorf("%w: text memo padding must be zero", ErrInvalidMemoXDR)
			}
		}

		if !utf8.Valid(textBytes) {
			return Memo{}, fmt.Errorf("%w: text memo is not valid UTF-8", ErrInvalidMemoXDR)
		}

		return Memo{Type: memoType, Text: string(textBytes)}, nil

	case MemoTypeID:
		if len(body) != 8 {
			return Memo{}, fmt.Errorf("%w: id memo must be 8 bytes, got %d", ErrInvalidMemoXDR, len(body))
		}
		return Memo{Type: memoType, ID: binary.BigEndian.Uint64(body)}, nil

	case MemoTypeHash, MemoTypeReturn:
		if len(body) != MemoHashSize {
			return Memo{}, fmt.Errorf("%w: %s memo must be exactly %d bytes, got %d", ErrInvalidMemoXDR, memoType, MemoHashSize, len(body))
		}
		var hash [MemoHashSize]byte
		copy(hash[:], body)
		return Memo{Type: memoType, Hash: hash}, nil

	default:
		return Memo{}, fmt.Errorf("%w: unsupported memo type %d", ErrInvalidMemoXDR, uint32(memoType))
	}
}

// ParsePaymentMemoHash parses the base64 `memo` field of a payment transaction
// and returns its 32-byte hash, rejecting every non-hash memo type.
func ParsePaymentMemoHash(memoXDR string) ([MemoHashSize]byte, error) {
	memo, err := ParseMemoXDR(memoXDR)
	if err != nil {
		return [MemoHashSize]byte{}, err
	}

	if !memo.IsHash() {
		return [MemoHashSize]byte{}, fmt.Errorf("%w: got %s memo", ErrMemoNotHash, memo.Type)
	}

	return memo.Hash, nil
}

// ComputeProfileHash derives the 32-byte profile_hash commitment from raw
// routing information. It mirrors the contract client SDK: SHA-256 over the
// trimmed routing information.
func ComputeProfileHash(routingInfo string) ([MemoHashSize]byte, error) {
	trimmed := strings.TrimSpace(routingInfo)
	if trimmed == "" {
		return [MemoHashSize]byte{}, fmt.Errorf("%w: routing information is empty", ErrInvalidProfileHash)
	}
	return sha256.Sum256([]byte(trimmed)), nil
}

// ParseProfileHashHex decodes a 64-character hexadecimal profile_hash.
func ParseProfileHashHex(hashHex string) ([MemoHashSize]byte, error) {
	trimmed := strings.TrimSpace(hashHex)
	if len(trimmed) != MemoHashSize*2 {
		return [MemoHashSize]byte{}, fmt.Errorf("%w: expected %d hex characters, got %d", ErrInvalidProfileHash, MemoHashSize*2, len(trimmed))
	}

	raw, err := hex.DecodeString(trimmed)
	if err != nil {
		return [MemoHashSize]byte{}, fmt.Errorf("%w: %v", ErrInvalidProfileHash, err)
	}

	var hash [MemoHashSize]byte
	copy(hash[:], raw)
	return hash, nil
}

// FormatProfileHash renders a 32-byte hash as lowercase hexadecimal.
func FormatProfileHash(hash [MemoHashSize]byte) string {
	return hex.EncodeToString(hash[:])
}
