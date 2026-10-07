package listener

import (
	"math/big"
	"testing"
)

const (
	testContractID = "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT"
	testProfileHex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

	// XDR generated from authoritative Stellar SDK and contract event specification:
	// Topic 0: Symbol("disbursed")
	topicDisbursedXDR = "AAAADwAAAAlkaXNidXJzZWQAAAA="
	// Topic 0: Symbol("created")
	topicCreatedXDR = "AAAADwAAAAdjcmVhdGVkAA=="
	// Topic 1: u64(42)
	topicEscrow42XDR = "AAAABQAAAAAAAAAq"
	// Value tuple: (profile_hash: 32 bytes, payout_amount: 9,800,000 stroops)
	valueNormalXDR = "AAAAEAAAAAEAAAACAAAADQAAACABI0VniavN7wEjRWeJq83vASNFZ4mrze8BI0VniavN7wAAAAoAAAAAAAAAAAAAAAAAlYlA"
	// Value tuple: (profile_hash: 32 bytes, payout_amount: 2^127 - 1 max i128)
	valueMaxI128XDR = "AAAAEAAAAAEAAAACAAAADQAAACABI0VniavN7wEjRWeJq83vASNFZ4mrze8BI0VniavN7wAAAAp/////////////////////"
	// Value tuple: (profile_hash: 32 bytes, payout_amount: 0)
	valueZeroXDR = "AAAAEAAAAAEAAAACAAAADQAAACABI0VniavN7wEjRWeJq83vASNFZ4mrze8BI0VniavN7wAAAAoAAAAAAAAAAAAAAAAAAAAA"
	// Value tuple: (profile_hash: 32 bytes, payout_amount: -500)
	valueNegativeXDR = "AAAAEAAAAAEAAAACAAAADQAAACABI0VniavN7wEjRWeJq83vASNFZ4mrze8BI0VniavN7wAAAAr///////////////////4M"
	// Value tuple: (profile_hash: 16 bytes invalid, payout_amount: 9,800,000)
	valueShortHashXDR = "AAAAEAAAAAEAAAACAAAADQAAABABI0VniavN7wEjRWeJq83vAAAACgAAAAAAAAAAAAAAAACViUA="
)

func TestDecodeDisbursedEvent_ValidRealXDR(t *testing.T) {
	item := EventItem{
		ID:                       "0000000001-0000000001",
		ContractID:               testContractID,
		Topic:                    []string{topicDisbursedXDR, topicEscrow42XDR},
		Ledger:                   5000000,
		InSuccessfulContractCall: true,
		Value: EventValue{
			XDR: valueNormalXDR,
		},
	}

	payload, err := DecodeDisbursedEvent(item, testContractID)
	if err != nil {
		t.Fatalf("unexpected error decoding valid real XDR event: %v", err)
	}

	if payload.EscrowID != 42 {
		t.Fatalf("expected escrow ID 42, got %d", payload.EscrowID)
	}

	expectedAmount := big.NewInt(9800000)
	if payload.PayoutAmount.Cmp(expectedAmount) != 0 {
		t.Fatalf("expected amount %s, got %s", expectedAmount.String(), payload.PayoutAmount.String())
	}

	if payload.ProfileHashHex != testProfileHex {
		t.Fatalf("expected profile hash %s, got %s", testProfileHex, payload.ProfileHashHex)
	}
}

func TestDecodeDisbursedEvent_LargeI128Payout(t *testing.T) {
	item := EventItem{
		ID:                       "0000000002-0000000001",
		ContractID:               testContractID,
		Topic:                    []string{topicDisbursedXDR, topicEscrow42XDR},
		Ledger:                   5000001,
		InSuccessfulContractCall: true,
		Value: EventValue{
			XDR: valueMaxI128XDR,
		},
	}

	payload, err := DecodeDisbursedEvent(item, testContractID)
	if err != nil {
		t.Fatalf("unexpected error decoding large i128 event: %v", err)
	}

	// 2^127 - 1 = 170141183460469231731687303715884105727
	expectedMax, _ := new(big.Int).SetString("170141183460469231731687303715884105727", 10)
	if payload.PayoutAmount.Cmp(expectedMax) != 0 {
		t.Fatalf("expected max i128 %s, got %s", expectedMax.String(), payload.PayoutAmount.String())
	}
}

func TestDecodeDisbursedEvent_WrongContractID(t *testing.T) {
	item := EventItem{
		ID:                       "0000000001-0000000001",
		ContractID:               "CWRONGCONTRACTIDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		Topic:                    []string{topicDisbursedXDR, topicEscrow42XDR},
		InSuccessfulContractCall: true,
		Value: EventValue{
			XDR: valueNormalXDR,
		},
	}

	_, err := DecodeDisbursedEvent(item, testContractID)
	if err == nil {
		t.Fatalf("expected error for contract ID mismatch")
	}
}

func TestDecodeDisbursedEvent_WrongSymbol(t *testing.T) {
	item := EventItem{
		ID:                       "0000000001-0000000001",
		ContractID:               testContractID,
		Topic:                    []string{topicCreatedXDR, topicEscrow42XDR},
		InSuccessfulContractCall: true,
		Value: EventValue{
			XDR: valueNormalXDR,
		},
	}

	_, err := DecodeDisbursedEvent(item, testContractID)
	if err == nil {
		t.Fatalf("expected error for topic symbol mismatch")
	}
}

func TestDecodeDisbursedEvent_MissingEscrowID(t *testing.T) {
	item := EventItem{
		ID:                       "0000000001-0000000001",
		ContractID:               testContractID,
		Topic:                    []string{topicDisbursedXDR}, // missing second topic
		InSuccessfulContractCall: true,
		Value: EventValue{
			XDR: valueNormalXDR,
		},
	}

	_, err := DecodeDisbursedEvent(item, testContractID)
	if err == nil {
		t.Fatalf("expected error for missing escrow ID in topic")
	}
}

func TestDecodeDisbursedEvent_MalformedTopic(t *testing.T) {
	item := EventItem{
		ID:                       "0000000001-0000000001",
		ContractID:               testContractID,
		Topic:                    []string{"!!!invalid_base64!!!", topicEscrow42XDR},
		InSuccessfulContractCall: true,
		Value: EventValue{
			XDR: valueNormalXDR,
		},
	}

	_, err := DecodeDisbursedEvent(item, testContractID)
	if err == nil {
		t.Fatalf("expected error for malformed topic")
	}
}

func TestDecodeDisbursedEvent_MalformedValue(t *testing.T) {
	item := EventItem{
		ID:                       "0000000001-0000000001",
		ContractID:               testContractID,
		Topic:                    []string{topicDisbursedXDR, topicEscrow42XDR},
		InSuccessfulContractCall: true,
		Value: EventValue{
			XDR: "AAAAAQ==", // truncated value
		},
	}

	_, err := DecodeDisbursedEvent(item, testContractID)
	if err == nil {
		t.Fatalf("expected error for malformed value XDR")
	}
}

func TestDecodeDisbursedEvent_InvalidProfileHashLength(t *testing.T) {
	item := EventItem{
		ID:                       "0000000001-0000000001",
		ContractID:               testContractID,
		Topic:                    []string{topicDisbursedXDR, topicEscrow42XDR},
		InSuccessfulContractCall: true,
		Value: EventValue{
			XDR: valueShortHashXDR, // 16 bytes instead of 32 bytes
		},
	}

	_, err := DecodeDisbursedEvent(item, testContractID)
	if err == nil {
		t.Fatalf("expected error for invalid profile hash length")
	}
}

func TestDecodeDisbursedEvent_ZeroPayout(t *testing.T) {
	item := EventItem{
		ID:                       "0000000001-0000000001",
		ContractID:               testContractID,
		Topic:                    []string{topicDisbursedXDR, topicEscrow42XDR},
		InSuccessfulContractCall: true,
		Value: EventValue{
			XDR: valueZeroXDR,
		},
	}

	_, err := DecodeDisbursedEvent(item, testContractID)
	if err == nil {
		t.Fatalf("expected error for zero payout amount")
	}
}

func TestDecodeDisbursedEvent_NegativePayout(t *testing.T) {
	item := EventItem{
		ID:                       "0000000001-0000000001",
		ContractID:               testContractID,
		Topic:                    []string{topicDisbursedXDR, topicEscrow42XDR},
		InSuccessfulContractCall: true,
		Value: EventValue{
			XDR: valueNegativeXDR,
		},
	}

	_, err := DecodeDisbursedEvent(item, testContractID)
	if err == nil {
		t.Fatalf("expected error for negative payout amount")
	}
}

func TestDecodeDisbursedEvent_FailedContractCall(t *testing.T) {
	item := EventItem{
		ID:                       "0000000001-0000000001",
		ContractID:               testContractID,
		Topic:                    []string{topicDisbursedXDR, topicEscrow42XDR},
		InSuccessfulContractCall: false, // failed contract call
		Value: EventValue{
			XDR: valueNormalXDR,
		},
	}

	_, err := DecodeDisbursedEvent(item, testContractID)
	if err == nil {
		t.Fatalf("expected error for event from failed contract call")
	}
}
