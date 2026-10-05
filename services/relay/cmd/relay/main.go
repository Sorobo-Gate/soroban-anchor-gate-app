package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/soroban-anchor-gate/relay/internal/listener"
	"github.com/soroban-anchor-gate/relay/internal/store"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	contractID := os.Getenv("SOROBAN_CONTRACT_ID")
	if contractID == "" {
		contractID = "CCCSLE7UN2FRLB2HQWEUEXM4365NDYH3QSC6J5TILQWBSTTIDKFWXX2Y"
	}

	rpcURL := os.Getenv("SOROBAN_RPC_URL")
	if rpcURL == "" {
		rpcURL = "https://soroban-testnet.stellar.org"
	}

	var startLedger uint32 = 1
	if s := os.Getenv("START_LEDGER"); s != "" {
		if val, err := strconv.ParseUint(s, 10, 32); err == nil {
			startLedger = uint32(val)
		}
	}

	logger.Info("SorobanAnchor Gate Relay daemon starting",
		"rpc_url", rpcURL,
		"contract_id", contractID,
		"start_ledger", startLedger,
	)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	memStore := store.NewMemoryStore(startLedger)
	eventChan := make(chan listener.EventPayload, 100)
	sub := listener.NewEventSubscriber(rpcURL, contractID, memStore, logger)

	go func() {
		if err := sub.PollEvents(ctx, eventChan); err != nil && err != context.Canceled {
			logger.Error("Event poller failure", "error", err)
		}
	}()

	go func() {
		for {
			select {
			case payload, ok := <-eventChan:
				if !ok {
					return
				}
				logger.Info("Relay received contract event",
					"event_id", payload.EventID,
					"escrow_id", payload.EscrowID,
					"amount", payload.PayoutAmount.String(),
					"profile_hash", payload.ProfileHashHex,
				)
			case <-ctx.Done():
				return
			}
		}
	}()

	<-ctx.Done()
	logger.Info("Shutting down relay daemon gracefully")
}
