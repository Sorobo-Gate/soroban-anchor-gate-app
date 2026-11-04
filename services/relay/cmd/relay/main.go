package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/soroban-anchor-gate/relay/internal/api"
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

	apiPort := os.Getenv("PORT")
	if apiPort == "" {
		apiPort = "8080"
	}

	var startLedger uint32 = 0
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
		"api_port", apiPort,
	)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	// Start HTTP API monitoring server
	apiServer := api.NewServer(contractID, rpcURL, relayStore)
	httpServer := &http.Server{
		Addr:         ":" + apiPort,
		Handler:      apiServer.Handler(),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go func() {
		logger.Info("Relay HTTP API server listening", "port", apiPort)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("HTTP API server failure", "error", err)
		}
	}()

	eventChan := make(chan listener.EventPayload, 100)
	sub := listener.NewEventSubscriber(rpcURL, contractID, relayStore, logger)

	go func() {
		if err := sub.PollEvents(ctx, eventChan); err != nil && !errors.Is(err, context.Canceled) {
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

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	_ = httpServer.Shutdown(shutdownCtx)
}
