package tx

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
)

// Stellar XDR discriminants required to wrap an inner TransactionV1Envelope in
// a fee bump transaction. The relay intentionally hand-encodes this small
// subset of XDR instead of pulling in the full Stellar SDK, keeping the relay
// dependency-free as required by the repository's dependency policy.
const (
	// envelopeTypeTx is ENVELOPE_TYPE_TX, the only inner envelope type the
	// relay wraps. Legacy TransactionV0 envelopes are not produced by the
	// relay and are rejected explicitly.
	envelopeTypeTx int32 = 2
	// envelopeTypeTxFeeBump is ENVELOPE_TYPE_TX_FEE_BUMP.
	envelopeTypeTxFeeBump int32 = 5
	// keyTypeEd25519 is KEY_TYPE_ED25519 for a MuxedAccount.
	keyTypeEd25519 int32 = 0
	// maxDecoratedSignatures is the XDR bound on FeeBumpTransactionEnvelope
	// signatures<20>.
	maxDecoratedSignatures = 20
)

// Errors returned while building a fee bump envelope.
var (
	// ErrEmptyNetworkPassphrase is returned when no Stellar network passphrase
	// is configured, which would make the derived transaction hash ambiguous.
	ErrEmptyNetworkPassphrase = errors.New("tx: network passphrase must not be empty")
	// ErrInvalidFeeSource is returned for a fee source key that is not a
	// 32-byte Ed25519 public key.
	ErrInvalidFeeSource = errors.New("tx: fee source must be a 32-byte ed25519 public key")
	// ErrInvalidFee is returned for a non-positive fee.
	ErrInvalidFee = errors.New("tx: fee bump fee must be greater than zero")
	// ErrInvalidSignature is returned for a signature that is not exactly one
	// 64-byte Ed25519 signature.
	ErrInvalidSignature = errors.New("tx: fee bump signature must be 64 bytes")
)

// UnsignedFeeBump is a fee bump transaction body plus the hash that the fee
// source must sign. The body is kept as raw XDR so the same bytes are hashed
// and embedded in the submitted envelope.
type UnsignedFeeBump struct {
	feeSource ed25519.PublicKey
	body      []byte
	// Hash is the 32-byte Stellar transaction hash committed to by the fee
	// source signature.
	Hash [32]byte
}

// FeeBumpEnvelope is a signed fee bump transaction ready for submission to
// Soroban RPC via sendTransaction.
type FeeBumpEnvelope struct {
	// EnvelopeXDR is the base64-encoded TransactionEnvelope.
	EnvelopeXDR string
	// Hash is the hex-encoded hash of the fee bump transaction.
	Hash string
	// Fee is the total fee, in stroops, paid by the fee source.
	Fee int64
}

// NetworkID derives the Stellar network identifier from a network passphrase.
// The identifier is the SHA-256 digest of the passphrase and is prefixed to
// every transaction signature payload.
func NetworkID(passphrase string) [32]byte {
	return sha256.Sum256([]byte(passphrase))
}

// BuildFeeBump wraps the base64 TransactionV1Envelope in innerEnvelopeXDR in a
// fee bump transaction paying fee stroops, sourced from feeSource.
//
// The returned UnsignedFeeBump exposes Hash, which must be signed with the fee
// source key before the envelope can be assembled with Sign.
func BuildFeeBump(passphrase string, feeSource ed25519.PublicKey, fee int64, innerEnvelopeXDR string) (*UnsignedFeeBump, error) {
	if passphrase == "" {
		return nil, ErrEmptyNetworkPassphrase
	}
	if len(feeSource) != ed25519.PublicKeySize {
		return nil, ErrInvalidFeeSource
	}
	if fee <= 0 {
		return nil, ErrInvalidFee
	}

	inner, err := decodeInnerEnvelope(innerEnvelopeXDR)
	if err != nil {
		return nil, err
	}

	// FeeBumpTransaction ::= {
	//   MuxedAccount feeSource;
	//   int64        fee;
	//   union switch (EnvelopeType type) {
	//   case ENVELOPE_TYPE_TX: TransactionV1Envelope v1;
	//   } innerTx;
	//   union switch (int v) { case 0: void; } ext;
	// }
	//
	// The innerTx union discriminant is encoded before the inner envelope, and
	// a TransactionV1Envelope has the same layout as InnerTransaction, so the
	// signed inner envelope is embedded byte for byte.
	var feeBumpTx xdrEncoder
	feeBumpTx.int32(keyTypeEd25519)
	feeBumpTx.fixed(feeSource)
	feeBumpTx.int64(fee)
	feeBumpTx.int32(envelopeTypeTx)
	feeBumpTx.fixed(inner)
	feeBumpTx.int32(0) // FeeBumpTransaction.ext = v0

	// TransactionSignaturePayload ::= {
	//   Hash networkId;
	//   union switch (EnvelopeType type) {
	//   case ENVELOPE_TYPE_TX_FEE_BUMP: FeeBumpTransaction feeBump;
	//   } taggedTransaction;
	// }
	networkID := NetworkID(passphrase)
	var payload xdrEncoder
	payload.fixed(networkID[:])
	payload.int32(envelopeTypeTxFeeBump)
	payload.fixed(feeBumpTx.buf)

	return &UnsignedFeeBump{
		feeSource: append(ed25519.PublicKey(nil), feeSource...),
		body:      feeBumpTx.buf,
		Hash:      sha256.Sum256(payload.buf),
	}, nil
}

// Sign assembles the signed TransactionEnvelope for an UnsignedFeeBump.
// signature must be the 64-byte Ed25519 signature over u.Hash produced by the
// fee source key.
func (u *UnsignedFeeBump) Sign(signature []byte) (FeeBumpEnvelope, error) {
	if u == nil || len(u.body) == 0 {
		return FeeBumpEnvelope{}, errors.New("tx: fee bump transaction is not initialized")
	}
	if len(signature) != ed25519.SignatureSize {
		return FeeBumpEnvelope{}, ErrInvalidSignature
	}

	// TransactionEnvelope ::= union switch (EnvelopeType type) {
	// case ENVELOPE_TYPE_TX_FEE_BUMP: FeeBumpTransactionEnvelope feeBump;
	// }
	// FeeBumpTransactionEnvelope ::= {
	//   FeeBumpTransaction tx;
	//   DecoratedSignature signatures<20>;
	// }
	var envelope xdrEncoder
	envelope.int32(envelopeTypeTxFeeBump)
	envelope.fixed(u.body)
	envelope.int32(1) // exactly one fee source signature
	envelope.fixed(u.feeSource[ed25519.PublicKeySize-4:])
	envelope.opaque(signature)

	return FeeBumpEnvelope{
		EnvelopeXDR: base64.StdEncoding.EncodeToString(envelope.buf),
		Hash:        hex.EncodeToString(u.Hash[:]),
		Fee:         feeOfFeeBumpBody(u.body),
	}, nil
}

// decodeInnerEnvelope validates and decodes a base64 TransactionV1Envelope.
func decodeInnerEnvelope(innerEnvelopeXDR string) ([]byte, error) {
	if innerEnvelopeXDR == "" {
		return nil, errors.New("tx: inner transaction envelope XDR must not be empty")
	}
	decoded, err := base64.StdEncoding.DecodeString(innerEnvelopeXDR)
	if err != nil {
		return nil, fmt.Errorf("tx: inner transaction envelope is not valid base64: %w", err)
	}
	if len(decoded) < 8 {
		return nil, fmt.Errorf("tx: inner transaction envelope is truncated: %d bytes", len(decoded))
	}
	envelopeType := int32(binary.BigEndian.Uint32(decoded[:4]))
	if envelopeType != envelopeTypeTx {
		return nil, fmt.Errorf("tx: unsupported inner envelope type %d, expected ENVELOPE_TYPE_TX (%d)", envelopeType, envelopeTypeTx)
	}
	// A TransactionV1Envelope carries at least the transaction union arm and a
	// signature count, so anything shorter cannot be submitted.
	if len(decoded) <= 4 {
		return nil, errors.New("tx: inner transaction envelope has no transaction body")
	}
	return decoded, nil
}

// feeOfFeeBumpBody extracts the int64 fee from an encoded FeeBumpTransaction
// body: MuxedAccount feeSource (4-byte type + 32-byte key) then int64 fee.
func feeOfFeeBumpBody(body []byte) int64 {
	const feeOffset = 4 + ed25519.PublicKeySize
	if len(body) < feeOffset+8 {
		return 0
	}
	return int64(binary.BigEndian.Uint64(body[feeOffset : feeOffset+8]))
}

// xdrEncoder accumulates big-endian XDR bytes. Values are appended in place,
// so a copy must be taken before reusing a buffer.
type xdrEncoder struct {
	buf []byte
}

// int32 appends an XDR int.
func (e *xdrEncoder) int32(v int32) {
	e.buf = binary.BigEndian.AppendUint32(e.buf, uint32(v))
}

// int64 appends an XDR hyper.
func (e *xdrEncoder) int64(v int64) {
	e.buf = binary.BigEndian.AppendUint64(e.buf, uint64(v))
}

// fixed appends fixed-length opaque data without a length prefix.
func (e *xdrEncoder) fixed(b []byte) {
	e.buf = append(e.buf, b...)
}

// opaque appends variable-length opaque data as a length-prefixed, 4-byte
// padded XDR vector.
func (e *xdrEncoder) opaque(b []byte) {
	e.int32(int32(len(b)))
	e.fixed(b)
	if rem := len(b) % 4; rem != 0 {
		e.fixed(make([]byte, 4-rem))
	}
}
