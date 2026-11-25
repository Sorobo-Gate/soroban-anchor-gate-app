package listener

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func memoBody(memoType MemoType, body []byte) []byte {
	out := make([]byte, 4+len(body))
	binary.BigEndian.PutUint32(out[:4], uint32(memoType))
	copy(out[4:], body)
	return out
}

func memoBase64(t *testing.T, memoType MemoType, body []byte) string {
	t.Helper()
	return base64.StdEncoding.EncodeToString(memoBody(memoType, body))
}

func memoBase64Text(t *testing.T, text string) string {
	t.Helper()
	paddedLen := (len(text) + 3) &^ 3
	body := make([]byte, 4+paddedLen)
	binary.BigEndian.PutUint32(body[:4], uint32(len(text)))
	copy(body[4:], text)
	return memoBase64(t, MemoTypeText, body)
}

func testHash(seed byte) [MemoHashSize]byte {
	var hash [MemoHashSize]byte
	for i := range hash {
		hash[i] = seed + byte(i)
	}
	return hash
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestParseMemoXDR_HashMemo(t *testing.T) {
	want := testHash(0x10)
	memo, err := ParseMemoXDR(memoBase64(t, MemoTypeHash, want[:]))
	if err != nil {
		t.Fatalf("unexpected error parsing hash memo: %v", err)
	}

	if memo.Type != MemoTypeHash {
		t.Fatalf("expected memo type hash, got %s", memo.Type)
	}
	if !memo.IsHash() {
		t.Fatal("expected hash memo to report IsHash true")
	}
	if !bytes.Equal(memo.Hash[:], want[:]) {
		t.Fatalf("expected hash %x, got %x", want, memo.Hash)
	}
	if len(memo.Hash) != MemoHashSize {
		t.Fatalf("expected %d-byte hash, got %d", MemoHashSize, len(memo.Hash))
	}
}

func TestParseMemoXDR_ReturnMemo(t *testing.T) {
	want := testHash(0x40)
	memo, err := ParseMemoXDR(memoBase64(t, MemoTypeReturn, want[:]))
	if err != nil {
		t.Fatalf("unexpected error parsing return memo: %v", err)
	}

	if memo.Type != MemoTypeReturn {
		t.Fatalf("expected memo type return, got %s", memo.Type)
	}
	if !memo.IsHash() {
		t.Fatal("expected MEMO_RETURN to be treated as a hash memo")
	}
	if !bytes.Equal(memo.Hash[:], want[:]) {
		t.Fatalf("expected hash %x, got %x", want, memo.Hash)
	}
}

func TestParseMemoXDR_TextMemo(t *testing.T) {
	// 14 bytes: 2 bytes of zero XDR padding.
	text := "anchor-ref-123"
	memo, err := ParseMemoXDR(memoBase64Text(t, text))
	if err != nil {
		t.Fatalf("unexpected error parsing text memo: %v", err)
	}

	if memo.Type != MemoTypeText {
		t.Fatalf("expected memo type text, got %s", memo.Type)
	}
	if memo.Text != text {
		t.Fatalf("expected text %q, got %q", text, memo.Text)
	}
	if memo.IsHash() {
		t.Fatal("expected text memo to report IsHash false")
	}
}

func TestParseMemoXDR_TextMemoMaxLength(t *testing.T) {
	text := strings.Repeat("a", maxMemoTextSize)
	memo, err := ParseMemoXDR(memoBase64Text(t, text))
	if err != nil {
		t.Fatalf("unexpected error parsing maximum-length text memo: %v", err)
	}
	if memo.Text != text {
		t.Fatalf("expected text %q, got %q", text, memo.Text)
	}
}

func TestParseMemoXDR_TextMemoTooLong(t *testing.T) {
	text := strings.Repeat("a", maxMemoTextSize+1)
	_, err := ParseMemoXDR(memoBase64Text(t, text))
	if err == nil {
		t.Fatal("expected error for text memo longer than 28 bytes")
	}
	if !errors.Is(err, ErrInvalidMemoXDR) {
		t.Fatalf("expected ErrInvalidMemoXDR, got %v", err)
	}
}

func TestParseMemoXDR_TextMemoNonZeroPadding(t *testing.T) {
	body := make([]byte, 4+8)
	binary.BigEndian.PutUint32(body[:4], 5)
	copy(body[4:], []byte("hello"))
	body[9] = 0xff // padding byte must be zero

	_, err := ParseMemo(memoBody(MemoTypeText, body))
	if err == nil {
		t.Fatal("expected error for non-zero text memo padding")
	}
	if !errors.Is(err, ErrInvalidMemoXDR) {
		t.Fatalf("expected ErrInvalidMemoXDR, got %v", err)
	}
}

func TestParseMemoXDR_TextMemoInvalidUTF8(t *testing.T) {
	body := []byte{0x00, 0x00, 0x00, 0x02, 0xff, 0xfe, 0x00, 0x00}
	_, err := ParseMemo(memoBody(MemoTypeText, body))
	if err == nil {
		t.Fatal("expected error for invalid UTF-8 text memo")
	}
	if !errors.Is(err, ErrInvalidMemoXDR) {
		t.Fatalf("expected ErrInvalidMemoXDR, got %v", err)
	}
}

func TestParseMemoXDR_IDMemo(t *testing.T) {
	body := make([]byte, 8)
	binary.BigEndian.PutUint64(body, 9_876_543_210)

	memo, err := ParseMemo(memoBody(MemoTypeID, body))
	if err != nil {
		t.Fatalf("unexpected error parsing id memo: %v", err)
	}
	if memo.Type != MemoTypeID {
		t.Fatalf("expected memo type id, got %s", memo.Type)
	}
	if memo.ID != 9_876_543_210 {
		t.Fatalf("expected id 9876543210, got %d", memo.ID)
	}
}

func TestParseMemoXDR_IDMemoWrongLength(t *testing.T) {
	_, err := ParseMemo(memoBody(MemoTypeID, make([]byte, 7)))
	if err == nil {
		t.Fatal("expected error for truncated id memo")
	}
	if !errors.Is(err, ErrInvalidMemoXDR) {
		t.Fatalf("expected ErrInvalidMemoXDR, got %v", err)
	}
}

func TestParseMemoXDR_NoneMemo(t *testing.T) {
	memo, err := ParseMemoXDR(memoBase64(t, MemoTypeNone, nil))
	if err != nil {
		t.Fatalf("unexpected error parsing none memo: %v", err)
	}
	if memo.Type != MemoTypeNone {
		t.Fatalf("expected memo type none, got %s", memo.Type)
	}
}

func TestParseMemoXDR_NoneMemoTrailingBytes(t *testing.T) {
	_, err := ParseMemo(memoBody(MemoTypeNone, []byte{0x00}))
	if err == nil {
		t.Fatal("expected error for none memo with trailing bytes")
	}
	if !errors.Is(err, ErrInvalidMemoXDR) {
		t.Fatalf("expected ErrInvalidMemoXDR, got %v", err)
	}
}

func TestParseMemoXDR_MissingMemo(t *testing.T) {
	for _, encoded := range []string{"", "   "} {
		_, err := ParseMemoXDR(encoded)
		if !errors.Is(err, ErrMemoMissing) {
			t.Fatalf("expected ErrMemoMissing for %q, got %v", encoded, err)
		}
	}
}

func TestParseMemoXDR_InvalidBase64(t *testing.T) {
	_, err := ParseMemoXDR("!!!not-base64!!!")
	if err == nil {
		t.Fatal("expected error for invalid base64")
	}
	if !errors.Is(err, ErrInvalidMemoXDR) {
		t.Fatalf("expected ErrInvalidMemoXDR, got %v", err)
	}
}

func TestParseMemoXDR_ShortPayload(t *testing.T) {
	_, err := ParseMemoXDR(base64.StdEncoding.EncodeToString([]byte{0x00, 0x00, 0x00}))
	if err == nil {
		t.Fatal("expected error for a 3-byte memo payload")
	}
	if !errors.Is(err, ErrInvalidMemoXDR) {
		t.Fatalf("expected ErrInvalidMemoXDR, got %v", err)
	}
}

func TestParseMemoXDR_TruncatedHash(t *testing.T) {
	_, err := ParseMemo(memoBody(MemoTypeHash, make([]byte, MemoHashSize-1)))
	if err == nil {
		t.Fatal("expected error for a 31-byte hash memo")
	}
	if !errors.Is(err, ErrInvalidMemoXDR) {
		t.Fatalf("expected ErrInvalidMemoXDR, got %v", err)
	}
}

func TestParseMemoXDR_HashTrailingBytes(t *testing.T) {
	body := make([]byte, MemoHashSize+1)
	_, err := ParseMemo(memoBody(MemoTypeHash, body))
	if err == nil {
		t.Fatal("expected error for a hash memo with trailing bytes")
	}
	if !errors.Is(err, ErrInvalidMemoXDR) {
		t.Fatalf("expected ErrInvalidMemoXDR, got %v", err)
	}
}

func TestParseMemoXDR_UnsupportedType(t *testing.T) {
	_, err := ParseMemo(memoBody(MemoType(99), nil))
	if err == nil {
		t.Fatal("expected error for unsupported memo type")
	}
	if !errors.Is(err, ErrInvalidMemoXDR) {
		t.Fatalf("expected ErrInvalidMemoXDR, got %v", err)
	}
	if !strings.Contains(err.Error(), "99") {
		t.Fatalf("expected error to name the unsupported type, got %v", err)
	}
}

func TestParsePaymentMemoHash_Valid(t *testing.T) {
	want := testHash(0x20)
	got, err := ParsePaymentMemoHash(memoBase64(t, MemoTypeHash, want[:]))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !bytes.Equal(got[:], want[:]) {
		t.Fatalf("expected hash %x, got %x", want, got)
	}
}

func TestParsePaymentMemoHash_RejectsNonHashMemo(t *testing.T) {
	encoded := memoBase64Text(t, "memo-text")

	if _, err := ParsePaymentMemoHash(encoded); !errors.Is(err, ErrMemoNotHash) {
		t.Fatalf("expected ErrMemoNotHash, got %v", err)
	}
}

func TestParsePaymentMemoHash_PropagatesParseErrors(t *testing.T) {
	if _, err := ParsePaymentMemoHash(""); !errors.Is(err, ErrMemoMissing) {
		t.Fatalf("expected ErrMemoMissing, got %v", err)
	}
	if _, err := ParsePaymentMemoHash("!!!bad!!!"); !errors.Is(err, ErrInvalidMemoXDR) {
		t.Fatalf("expected ErrInvalidMemoXDR, got %v", err)
	}
}

func TestParseProfileHashHex_Valid(t *testing.T) {
	want := testHash(0x30)
	got, err := ParseProfileHashHex(strings.ToUpper(FormatProfileHash(want)))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != want {
		t.Fatalf("expected hash %x, got %x", want, got)
	}
	if formatted := FormatProfileHash(got); formatted != strings.ToLower(FormatProfileHash(want)) {
		t.Fatalf("expected lowercase formatting, got %q", formatted)
	}
}

func TestParseProfileHashHex_Invalid(t *testing.T) {
	cases := map[string]string{
		"empty":         "",
		"short":         "abcd",
		"long":          strings.Repeat("a", 66),
		"non-hex":       strings.Repeat("z", 64),
		"odd-length":    strings.Repeat("a", 63),
		"whitespace":    " " + strings.Repeat("a", 64) + " trailing",
		"invalid-byte":  strings.Repeat("a", 64) + "\xff",
		"mixed-content": "0x" + strings.Repeat("a", 62),
	}

	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseProfileHashHex(input); !errors.Is(err, ErrInvalidProfileHash) {
				t.Fatalf("expected ErrInvalidProfileHash, got %v", err)
			}
		})
	}
}

func TestComputeProfileHash_Deterministic(t *testing.T) {
	routing := "IBAN: DE89370400440532013000"
	first, err := ComputeProfileHash(routing)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	second, err := ComputeProfileHash("  " + routing + "  ")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if first != second {
		t.Fatal("expected trimmed routing information to produce a stable hash")
	}

	want := sha256.Sum256([]byte(routing))
	if first != want {
		t.Fatalf("expected SHA-256 %x, got %x", want, first)
	}
}

func TestComputeProfileHash_RejectsEmptyRoutingInformation(t *testing.T) {
	for _, routing := range []string{"", "   "} {
		if _, err := ComputeProfileHash(routing); !errors.Is(err, ErrInvalidProfileHash) {
			t.Fatalf("expected ErrInvalidProfileHash for %q, got %v", routing, err)
		}
	}
}

func TestMemoValidator_MatchingMemo(t *testing.T) {
	profileHash := sha256.Sum256([]byte("IBAN: DE89370400440532013000"))
	sink := &InMemoryMemoAuditSink{}
	validator := NewMemoValidator(sink, discardLogger())

	result, err := validator.ValidatePaymentMemo(
		memoBase64(t, MemoTypeHash, profileHash[:]),
		FormatProfileHash(profileHash),
	)
	if err != nil {
		t.Fatalf("unexpected error validating matching memo: %v", err)
	}
	if !result.Matched {
		t.Fatal("expected memo to match profile_hash")
	}
	if result.MemoHash != result.ProfileHash {
		t.Fatal("expected memo hash and profile hash to be equal")
	}
	if result.MemoHashHex != FormatProfileHash(profileHash) {
		t.Fatalf("unexpected memo hash hex %q", result.MemoHashHex)
	}
	if records := sink.Records(); len(records) != 0 {
		t.Fatalf("expected no audit records, got %d", len(records))
	}
}

func TestMemoValidator_MismatchFlaggedForAudit(t *testing.T) {
	expected := sha256.Sum256([]byte("IBAN: DE89370400440532013000"))
	actual := sha256.Sum256([]byte("IBAN: DE89370400440532013001"))

	sink := &InMemoryMemoAuditSink{}
	validator := NewMemoValidator(sink, discardLogger())

	result, err := validator.ValidatePaymentMemo(
		memoBase64(t, MemoTypeHash, actual[:]),
		FormatProfileHash(expected),
	)
	if err == nil {
		t.Fatal("expected mismatched memo to be rejected")
	}
	if !errors.Is(err, ErrMemoMismatch) {
		t.Fatalf("expected ErrMemoMismatch, got %v", err)
	}
	if result.Matched {
		t.Fatal("expected result to report a mismatch")
	}

	records := sink.Records()
	if len(records) != 1 {
		t.Fatalf("expected exactly one audit record, got %d", len(records))
	}

	record := records[0]
	if record.MemoType != MemoTypeHash.String() {
		t.Fatalf("expected memo type %q, got %q", MemoTypeHash.String(), record.MemoType)
	}
	if record.MemoHashHex != FormatProfileHash(actual) {
		t.Fatalf("expected memo hash %q, got %q", FormatProfileHash(actual), record.MemoHashHex)
	}
	if record.ProfileHashHex != FormatProfileHash(expected) {
		t.Fatalf("expected profile hash %q, got %q", FormatProfileHash(expected), record.ProfileHashHex)
	}
	if record.Reason != ErrMemoMismatch.Error() {
		t.Fatalf("unexpected audit reason %q", record.Reason)
	}
	if record.FlaggedAt.IsZero() {
		t.Fatal("expected audit record to carry a flag timestamp")
	}
	if !record.FlaggedAt.Before(time.Now().Add(time.Second)) {
		t.Fatalf("unexpected flag timestamp %v", record.FlaggedAt)
	}
}

func TestMemoValidator_ReturnMemoMatches(t *testing.T) {
	profileHash := sha256.Sum256([]byte("routing"))
	sink := &InMemoryMemoAuditSink{}
	validator := NewMemoValidator(sink, discardLogger())

	if _, err := validator.ValidatePaymentMemo(
		memoBase64(t, MemoTypeReturn, profileHash[:]),
		FormatProfileHash(profileHash),
	); err != nil {
		t.Fatalf("expected MEMO_RETURN to validate as a hash memo: %v", err)
	}
	if records := sink.Records(); len(records) != 0 {
		t.Fatalf("expected no audit records, got %d", len(records))
	}
}

func TestMemoValidator_RejectsNonHashMemo(t *testing.T) {
	sink := &InMemoryMemoAuditSink{}
	validator := NewMemoValidator(sink, discardLogger())

	_, err := validator.ValidatePaymentMemo(
		memoBase64Text(t, "memo-text"),
		FormatProfileHash(testHash(0x50)),
	)
	if !errors.Is(err, ErrMemoNotHash) {
		t.Fatalf("expected ErrMemoNotHash, got %v", err)
	}
	if records := sink.Records(); len(records) != 0 {
		t.Fatalf("expected no audit records for a non-hash memo, got %d", len(records))
	}
}

func TestMemoValidator_RejectsInvalidProfileHash(t *testing.T) {
	sink := &InMemoryMemoAuditSink{}
	validator := NewMemoValidator(sink, discardLogger())

	memoHash := testHash(0x60)
	_, err := validator.ValidatePaymentMemo(
		memoBase64(t, MemoTypeHash, memoHash[:]),
		"not-a-profile-hash",
	)
	if !errors.Is(err, ErrInvalidProfileHash) {
		t.Fatalf("expected ErrInvalidProfileHash, got %v", err)
	}
	if records := sink.Records(); len(records) != 0 {
		t.Fatalf("expected no audit records for malformed profile_hash, got %d", len(records))
	}
}

func TestMemoValidator_PropagatesMemoParseErrors(t *testing.T) {
	validator := NewMemoValidator(&InMemoryMemoAuditSink{}, discardLogger())

	if _, err := validator.ValidatePaymentMemo("", FormatProfileHash(testHash(0x70))); !errors.Is(err, ErrMemoMissing) {
		t.Fatalf("expected ErrMemoMissing, got %v", err)
	}
	if _, err := validator.ValidatePaymentMemo("!!!bad!!!", FormatProfileHash(testHash(0x70))); !errors.Is(err, ErrInvalidMemoXDR) {
		t.Fatalf("expected ErrInvalidMemoXDR, got %v", err)
	}
}

func TestMemoValidator_NilSinkFallsBackToLogging(t *testing.T) {
	validator := NewMemoValidator(nil, discardLogger())

	memoHash := testHash(0x80)
	_, err := validator.ValidatePaymentMemo(
		memoBase64(t, MemoTypeHash, memoHash[:]),
		FormatProfileHash(testHash(0x81)),
	)
	if !errors.Is(err, ErrMemoMismatch) {
		t.Fatalf("expected ErrMemoMismatch with nil sink, got %v", err)
	}
}

func TestValidatePaymentMemo_DefaultValidator(t *testing.T) {
	profileHash := sha256.Sum256([]byte("default-validator"))
	if _, err := ValidatePaymentMemo(
		memoBase64(t, MemoTypeHash, profileHash[:]),
		FormatProfileHash(profileHash),
	); err != nil {
		t.Fatalf("unexpected error from default validator: %v", err)
	}
}

func TestLogMemoAuditSink_NilLogger(t *testing.T) {
	sink := LogMemoAuditSink{}
	sink.FlagMemoMismatch(MemoAuditRecord{Reason: "test", FlaggedAt: time.Now()})
}

func TestInMemoryMemoAuditSink_ReturnsCopy(t *testing.T) {
	sink := &InMemoryMemoAuditSink{}
	sink.FlagMemoMismatch(MemoAuditRecord{Reason: "first"})

	records := sink.Records()
	records[0].Reason = "mutated"

	if got := sink.Records()[0].Reason; got != "first" {
		t.Fatalf("expected audit records to be isolated from callers, got %q", got)
	}
}

func TestInMemoryMemoAuditSink_NilReceiver(t *testing.T) {
	var sink *InMemoryMemoAuditSink
	sink.FlagMemoMismatch(MemoAuditRecord{})
	if records := sink.Records(); records != nil {
		t.Fatalf("expected nil records from nil sink, got %v", records)
	}
}

func TestMemoTypeString(t *testing.T) {
	cases := map[MemoType]string{
		MemoTypeNone:   "none",
		MemoTypeText:   "text",
		MemoTypeID:     "id",
		MemoTypeHash:   "hash",
		MemoTypeReturn: "return",
		MemoType(42):   "unknown(42)",
	}

	for memoType, want := range cases {
		if got := memoType.String(); got != want {
			t.Fatalf("expected %q, got %q", want, got)
		}
	}
}
