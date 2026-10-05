package listener

import (
	"math/big"
	"testing"
)

func TestDecodeDisbursedEvent_Valid(t *testing.T) {
	contractID := "CCCSLE7UN2FRLB2HQWEUEXM4365NDYH3QSC6J5TILQWBSTTIDKFWXX2Y"
	hashHex := "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

	item := EventItem{
		ID:         "0000000001-0000000001",
		ContractID: contractID,
		Topic:      []string{"disbursed"},
		Ledger:     1000,
		Value: EventValue{
			Raw: map[string]interface{}{
				"escrow_id":    float64(42),
				"amount":       "340282366920938463463374607431768211455", // Large i128
				"profile_hash": hashHex,
			},
		},
	}

	payload, err := DecodeDisbursedEvent(item, contractID)
	if err != nil {
		t.Fatalf("unexpected error decoding valid event: %v", err)
	}

	if payload.EscrowID != 42 {
		t.Fatalf("expected escrow ID 42, got %d", payload.EscrowID)
	}

	expectedAmount, _ := new(big.Int).SetString("340282366920938463463374607431768211455", 10)
	if payload.PayoutAmount.Cmp(expectedAmount) != 0 {
		t.Fatalf("expected amount %s, got %s", expectedAmount.String(), payload.PayoutAmount.String())
	}

	if payload.ProfileHashHex != hashHex {
		t.Fatalf("expected profile hash %s, got %s", hashHex, payload.ProfileHashHex)
	}
}

func TestDecodeDisbursedEvent_WrongContractID(t *testing.T) {
	item := EventItem{
		ID:         "0000000001-0000000001",
		ContractID: "CWRONGCONTRACTIDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		Topic:      []string{"disbursed"},
	}

	_, err := DecodeDisbursedEvent(item, "CCCSLE7UN2FRLB2HQWEUEXM4365NDYH3QSC6J5TILQWBSTTIDKFWXX2Y")
	if err == nil {
		t.Fatalf("expected error for contract ID mismatch")
	}
}

func TestDecodeDisbursedEvent_WrongTopic(t *testing.T) {
	contractID := "CCCSLE7UN2FRLB2HQWEUEXM4365NDYH3QSC6J5TILQWBSTTIDKFWXX2Y"
	item := EventItem{
		ID:         "0000000001-0000000001",
		ContractID: contractID,
		Topic:      []string{"other_event"},
	}

	_, err := DecodeDisbursedEvent(item, contractID)
	if err == nil {
		t.Fatalf("expected error for topic mismatch")
	}
}

func TestDecodeDisbursedEvent_MalformedProfileHash(t *testing.T) {
	contractID := "CCCSLE7UN2FRLB2HQWEUEXM4365NDYH3QSC6J5TILQWBSTTIDKFWXX2Y"
	item := EventItem{
		ID:         "0000000001-0000000001",
		ContractID: contractID,
		Topic:      []string{"disbursed"},
		Value: EventValue{
			Raw: map[string]interface{}{
				"escrow_id":    float64(1),
				"amount":       "1000",
				"profile_hash": "invalid-short-hash",
			},
		},
	}

	_, err := DecodeDisbursedEvent(item, contractID)
	if err == nil {
		t.Fatalf("expected error for malformed profile hash length")
	}
}

func TestDecodeDisbursedEvent_ZeroOrNegativeAmount(t *testing.T) {
	contractID := "CCCSLE7UN2FRLB2HQWEUEXM4365NDYH3QSC6J5TILQWBSTTIDKFWXX2Y"
	item := EventItem{
		ID:         "0000000001-0000000001",
		ContractID: contractID,
		Topic:      []string{"disbursed"},
		Value: EventValue{
			Raw: map[string]interface{}{
				"escrow_id":    float64(1),
				"amount":       "0",
				"profile_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			},
		},
	}

	_, err := DecodeDisbursedEvent(item, contractID)
	if err == nil {
		t.Fatalf("expected error for zero amount")
	}
}
