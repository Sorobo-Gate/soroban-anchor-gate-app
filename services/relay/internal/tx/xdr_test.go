package tx

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"strings"
	"testing"
)

const testnetPassphrase = "Test SDF Network ; September 2015"

// testInnerEnvelope builds a minimal, structurally valid base64
// TransactionV1Envelope. The relay only validates the envelope type and
// length, so an opaque transaction body is sufficient here.
func testInnerEnvelope(t *testing.T, envelopeType int32) string {
	t.Helper()
	body := make([]byte, 4+8)
	binary.BigEndian.PutUint32(body[:4], uint32(envelopeType))
	for i := 4; i < len(body); i++ {
		body[i] = 0x7f
	}
	return base64.StdEncoding.EncodeToString(body)
}

func TestNetworkID(t *testing.T) {
	id := NetworkID(testnetPassphrase)
	got := hex.EncodeToString(id[:])
	const want = "cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472"
	if got != want {
		t.Fatalf("NetworkID mismatch: got %s, want %s", got, want)
	}
}

func TestBuildFeeBumpEnvelope(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	inner := testInnerEnvelope(t, envelopeTypeTx)
	unsigned, err := BuildFeeBump(testnetPassphrase, pub, 300, inner)
	if err != nil {
		t.Fatalf("BuildFeeBump: %v", err)
	}
	if unsigned.Hash == ([32]byte{}) {
		t.Fatal("expected a non-zero transaction hash")
	}

	sig := ed25519.Sign(priv, unsigned.Hash[:])
	envelope, err := unsigned.Sign(sig)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}

	if envelope.Hash != hex.EncodeToString(unsigned.Hash[:]) {
		t.Fatalf("envelope hash %q does not match unsigned hash %x", envelope.Hash, unsigned.Hash)
	}
	if envelope.Fee != 300 {
		t.Fatalf("envelope fee = %d, want 300", envelope.Fee)
	}

	raw, err := base64.StdEncoding.DecodeString(envelope.EnvelopeXDR)
	if err != nil {
		t.Fatalf("envelope is not valid base64: %v", err)
	}

	if got := int32(binary.BigEndian.Uint32(raw[:4])); got != envelopeTypeTxFeeBump {
		t.Fatalf("envelope type = %d, want %d", got, envelopeTypeTxFeeBump)
	}
	if got := int32(binary.BigEndian.Uint32(raw[4:8])); got != keyTypeEd25519 {
		t.Fatalf("fee source key type = %d, want %d", got, keyTypeEd25519)
	}
	if !strings.EqualFold(hex.EncodeToString(raw[8:40]), hex.EncodeToString(pub)) {
		t.Fatal("fee source public key was not encoded in the envelope")
	}
	if got := int64(binary.BigEndian.Uint64(raw[40:48])); got != 300 {
		t.Fatalf("encoded fee = %d, want 300", got)
	}

	// The inner envelope must be embedded verbatim right after the fee.
	innerRaw, err := base64.StdEncoding.DecodeString(inner)
	if err != nil {
		t.Fatalf("decode inner envelope: %v", err)
	}
	// innerTx union discriminant (ENVELOPE_TYPE_TX) precedes the envelope.
	innerTypeOffset := 48
	if got := int32(binary.BigEndian.Uint32(raw[innerTypeOffset : innerTypeOffset+4])); got != envelopeTypeTx {
		t.Fatalf("inner transaction union type = %d, want %d", got, envelopeTypeTx)
	}
	innerStart := innerTypeOffset + 4
	innerEnd := innerStart + len(innerRaw)
	if innerEnd > len(raw) {
		t.Fatalf("envelope too short to embed inner transaction: %d bytes", len(raw))
	}
	if string(raw[innerStart:innerEnd]) != string(innerRaw) {
		t.Fatal("inner transaction envelope was not embedded verbatim")
	}

	// Trailing layout: ext int32, signature count int32, hint[4], opaque sig.
	trailer := raw[innerEnd:]
	if len(trailer) != 4+4+4+4+ed25519.SignatureSize {
		t.Fatalf("unexpected trailer length: %d", len(trailer))
	}
	if got := int32(binary.BigEndian.Uint32(trailer[4:8])); got != 1 {
		t.Fatalf("signature count = %d, want 1", got)
	}
	if got := hex.EncodeToString(trailer[8:12]); got != hex.EncodeToString(pub[len(pub)-4:]) {
		t.Fatalf("signature hint = %s, want %s", got, hex.EncodeToString(pub[len(pub)-4:]))
	}
	if got := int32(binary.BigEndian.Uint32(trailer[12:16])); got != ed25519.SignatureSize {
		t.Fatalf("signature length = %d, want %d", got, ed25519.SignatureSize)
	}
	if !ed25519.Verify(pub, unsigned.Hash[:], trailer[16:]) {
		t.Fatal("embedded signature does not verify against the transaction hash")
	}

	// The transaction hash must be the SHA-256 of network id, envelope type and
	// the fee bump transaction body (everything except the signature envelope
	// prefix, ext trailer and signatures).
	networkID := sha256.Sum256([]byte(testnetPassphrase))
	payload := make([]byte, 0, 32+4+len(raw))
	payload = append(payload, networkID[:]...)
	var envelopeType [4]byte
	binary.BigEndian.PutUint32(envelopeType[:], uint32(envelopeTypeTxFeeBump))
	payload = append(payload, envelopeType[:]...)
	payload = append(payload, raw[4:innerEnd+4]...)
	sum := sha256.Sum256(payload)
	if hex.EncodeToString(sum[:]) != envelope.Hash {
		t.Fatalf("hash mismatch: got %s, want %s", hex.EncodeToString(sum[:]), envelope.Hash)
	}
}

func TestBuildFeeBumpRejectsInvalidInput(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	validInner := testInnerEnvelope(t, envelopeTypeTx)
	backwardsEnvelope := base64.StdEncoding.EncodeToString([]byte{0, 0, 0, 1, 0, 0, 0, 0})

	tests := []struct {
		name       string
		passphrase string
		feeSource  ed25519.PublicKey
		fee        int64
		inner      string
		wantErr    error
	}{
		{name: "empty passphrase", passphrase: "", feeSource: pub, fee: 100, inner: validInner, wantErr: ErrEmptyNetworkPassphrase},
		{name: "short key", passphrase: testnetPassphrase, feeSource: pub[:16], fee: 100, inner: validInner, wantErr: ErrInvalidFeeSource},
		{name: "zero fee", passphrase: testnetPassphrase, feeSource: pub, fee: 0, inner: validInner, wantErr: ErrInvalidFee},
		{name: "negative fee", passphrase: testnetPassphrase, feeSource: pub, fee: -1, inner: validInner, wantErr: ErrInvalidFee},
		{name: "empty inner", passphrase: testnetPassphrase, feeSource: pub, fee: 100, inner: "", wantErr: nil},
		{name: "invalid base64", passphrase: testnetPassphrase, feeSource: pub, fee: 100, inner: "not-base64!!", wantErr: nil},
		{name: "unsupported envelope type", passphrase: testnetPassphrase, feeSource: pub, fee: 100, inner: backwardsEnvelope, wantErr: nil},
		{name: "truncated inner", passphrase: testnetPassphrase, feeSource: pub, fee: 100, inner: base64.StdEncoding.EncodeToString([]byte{0, 0, 0, 2}), wantErr: nil},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			unsigned, err := BuildFeeBump(tt.passphrase, tt.feeSource, tt.fee, tt.inner)
			if tt.wantErr != nil {
				if err == nil {
					t.Fatalf("expected error %v, got nil", tt.wantErr)
				}
				if err != tt.wantErr {
					t.Fatalf("expected error %v, got %v", tt.wantErr, err)
				}
				if unsigned != nil {
					t.Fatal("expected no envelope on error")
				}
				return
			}
			if err == nil {
				t.Fatal("expected an error, got nil")
			}
			if unsigned != nil {
				t.Fatal("expected no envelope on error")
			}
		})
	}
}

func TestUnsignedFeeBumpSignRejectsBadSignature(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	unsigned, err := BuildFeeBump(testnetPassphrase, pub, 100, testInnerEnvelope(t, envelopeTypeTx))
	if err != nil {
		t.Fatalf("BuildFeeBump: %v", err)
	}

	if _, err := unsigned.Sign([]byte{1, 2, 3}); err != ErrInvalidSignature {
		t.Fatalf("expected ErrInvalidSignature, got %v", err)
	}

	var empty *UnsignedFeeBump
	if _, err := empty.Sign(make([]byte, ed25519.SignatureSize)); err == nil {
		t.Fatal("expected error signing a nil fee bump transaction")
	}
}
