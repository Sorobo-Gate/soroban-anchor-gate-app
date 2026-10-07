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
		contractID = "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT"
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

	storePath := os.Getenv("STORE_PATH")
	if storePath == "" {
		storePath = "data/relay_store.json"
	}

	var relayStore store.IdempotencyStore
	if storePath == ":memory:" {
		relayStore = store.NewMemoryStore(startLedger)
	} else {
		durableStore, err := store.NewDurableFileStore(storePath, startLedger)
		if err != nil {
			logger.Error("Failed to initialize durable file store, using memory store fallback", "error", err)
			relayStore = store.NewMemoryStore(startLedger)
		} else {
			relayStore = durableStore
			defer durableStore.Close()
		}
	}

	logger.Info("SorobanAnchor Gate Relay daemon starting",
		"rpc_url", rpcURL,
		"contract_id", contractID,
		"start_ledger", relayStore.GetCursor(),
		"store_path", storePath,
	)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	eventChan := make(chan listener.EventPayload, 100)
	sub := listener.NewEventSubscriber(rpcURL, contractID, relayStore, logger)

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

				// Complete processing after downstream handling
				if err := relayStore.MarkCompleted(payload.EventID); err != nil {
					logger.Error("Failed to mark event completed", "event_id", payload.EventID, "error", err)
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	<-ctx.Done()
	logger.Info("Shutting down relay daemon gracefully")
}
