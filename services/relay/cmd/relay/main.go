package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	_ "github.com/lib/pq"
	"github.com/soroban-anchor-gate/relay/internal/anchor"
	"github.com/soroban-anchor-gate/relay/internal/api"
	"github.com/soroban-anchor-gate/relay/internal/listener"
	"github.com/soroban-anchor-gate/relay/internal/signer"
	"github.com/soroban-anchor-gate/relay/internal/store"
	"github.com/soroban-anchor-gate/relay/internal/store/migrations"
	"github.com/soroban-anchor-gate/relay/internal/telemetry"
	"github.com/soroban-anchor-gate/relay/internal/worker"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	// Support CLI database migration subcommands: `relay migrate down`, `relay migrate up`, `relay migrate version`
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		handleMigrateCommand(logger, os.Args[2:])
		return
	}

	// Support container HEALTHCHECK without curl/wget in distroless runtime images.
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		apiPort := os.Getenv("PORT")
		if apiPort == "" {
			apiPort = "8080"
		}
		if err := checkHealth(fmt.Sprintf("http://127.0.0.1:%s/health", apiPort)); err != nil {
			logger.Error("Relay healthcheck failed", "error", err)
			os.Exit(1)
		}
		return
	}

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

	// Production observability: Prometheus metrics and OTel trace propagation.
	metrics := telemetry.NewMetrics()
	otlpEndpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	shutdownTracer, err := telemetry.InitTracer(ctx, telemetry.TracingConfig{
		ServiceName:    "soroban-anchor-relay",
		ServiceVersion: os.Getenv("RELAY_VERSION"),
		Environment:    os.Getenv("RELAY_ENVIRONMENT"),
		OTLPEndpoint:   otlpEndpoint,
	})
	if err != nil {
		logger.Error("Failed to initialize OpenTelemetry tracer; continuing without trace export", "error", err)
		shutdownTracer = func(context.Context) error { return nil }
	}
	if otlpEndpoint != "" {
		logger.Info("OpenTelemetry OTLP trace export enabled", "endpoint", otlpEndpoint)
	}

	// Start HTTP API monitoring server
	apiServer := api.NewServer(contractID, rpcURL, relayStore)
	handler := http.NewServeMux()
	handler.Handle("/metrics", metrics.Handler())
	handler.Handle("/", apiServer.Handler())
	httpServer := &http.Server{
		Addr:         ":" + apiPort,
		Handler:      telemetry.Middleware(handler),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go func() {
		logger.Info("Relay HTTP API server listening", "port", apiPort)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("HTTP API server failure", "error", err)
		}
	}()

	// Initialize transactional outbox store (PostgreSQL if DATABASE_URL configured, otherwise in-memory)
	var outboxStore store.OutboxStore
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL != "" {
		logger.Info("DATABASE_URL configured; running pending database migrations")
		db, err := sql.Open("postgres", dbURL)
		if err != nil {
			logger.Error("Failed to open database for migrations", "error", err)
			os.Exit(1)
		}
		defer db.Close()

		migCtx, migCancel := context.WithTimeout(context.Background(), 30*time.Second)
		migrator := migrations.NewMigrator(db, logger)
		if err := migrator.RunPending(migCtx); err != nil {
			migCancel()
			logger.Error("Automated database migration failed on boot", "error", err)
			os.Exit(1)
		}
		migCancel()
		logger.Info("Automated database migrations completed successfully")
		outboxStore = store.NewPostgresOutboxStore(db)
	} else {
		outboxStore = store.NewMemoryOutboxStore()
	}

	// Initialize background outbox worker with advisory locking
	outboxBatchSize := 10
	if s := os.Getenv("OUTBOX_BATCH_SIZE"); s != "" {
		if val, err := strconv.Atoi(s); err == nil && val > 0 {
			outboxBatchSize = val
		}
	}
	outboxWorker := worker.NewOutboxWorker(outboxStore, func(workerCtx context.Context, ev store.OutboxEvent) error {
		logger.Info("Outbox worker processing event",
			"event_id", ev.EventID,
			"event_type", ev.EventType,
		)
		return nil
	}, worker.OutboxWorkerConfig{
		BatchSize:      outboxBatchSize,
		PollInterval:   500 * time.Millisecond,
		AdvisoryLockID: 737475,
		MaxRetries:     5,
	}, logger)
	outboxWorker.SetMetrics(metrics)
	if err := outboxWorker.Start(ctx); err != nil {
		logger.Error("Failed to start outbox background worker", "error", err)
	}
	defer outboxWorker.Stop()

	// Initialize SEP-10 web authentication client if configured
	anchorDomain := os.Getenv("ANCHOR_DOMAIN")
	anchorAuthEndpoint := os.Getenv("ANCHOR_AUTH_ENDPOINT")
	if anchorDomain != "" || anchorAuthEndpoint != "" {
		var keyMgr signer.KeyManager
		if hexKey := os.Getenv("RELAY_SIGNER_KEY"); hexKey != "" {
			km, kErr := signer.NewEnvKeyManagerFromHex(hexKey)
			if kErr != nil {
				logger.Error("Failed to parse RELAY_SIGNER_KEY, generating ephemeral key", "error", kErr)
				keyMgr, _ = signer.GenerateEphemeralKeyManager()
			} else {
				keyMgr = km
			}
		} else {
			keyMgr, _ = signer.GenerateEphemeralKeyManager()
		}

		clientAccount := os.Getenv("RELAY_CLIENT_ACCOUNT")
		if clientAccount == "" {
			clientAccount = "GCHIAK3LLDWJ5N4Z4TH6GHCH2LQX5SUL2WEU42I324CFXGDUWXMNNSDZ"
		}

		if anchorAuthEndpoint == "" && anchorDomain != "" {
			toml, tErr := anchor.FetchAnchorTOML(ctx, nil, anchorDomain)
			if tErr == nil {
				anchorAuthEndpoint = toml.WebAuthEndpoint
			}
		}

		sep10Client := anchor.NewSEP10Client(
			anchorAuthEndpoint,
			os.Getenv("ANCHOR_SIGNING_KEY"),
			clientAccount,
			keyMgr,
			nil,
		)
		logger.Info("SEP-10 web authentication client initialized with automatic renewal",
			"auth_endpoint", anchorAuthEndpoint,
			"client_account", clientAccount,
		)
		_ = sep10Client
	}

	eventChan := make(chan listener.EventPayload, 100)
	sub := listener.NewEventSubscriber(rpcURL, contractID, relayStore, logger)
	sub.SetMetrics(metrics)

	go func() {
		if err := sub.PollEvents(ctx, eventChan); err != nil && !errors.Is(err, context.Canceled) {
			metrics.RecordRPCError("getEvents")
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
				metrics.RecordEscrowEvent("received")
				processingStarted := time.Now()
				processCtx, span := telemetry.Tracer().Start(ctx, "relay.process_escrow_event",
					trace.WithAttributes(
						attribute.String("escrow.event_id", payload.EventID),
						attribute.Int64("escrow.id", int64(payload.EscrowID)),
					),
				)
				logger.Info("Relay received contract event",
					"event_id", payload.EventID,
					"escrow_id", payload.EscrowID,
					"amount", payload.PayoutAmount.String(),
					"profile_hash", payload.ProfileHashHex,
					"trace_id", telemetry.TraceID(processCtx),
				)

				// Persist atomically to durable transaction outbox
				outboxEv := store.OutboxEvent{
					EventID:   payload.EventID,
					EventType: "disbursed",
					Payload:   fmt.Sprintf(`{"escrow_id":%d,"amount":"%s","profile_hash":"%s"}`, payload.EscrowID, payload.PayoutAmount.String(), payload.ProfileHashHex),
				}
				if err := outboxStore.InsertLedgerEventsAtomic(processCtx, payload.Ledger, []store.OutboxEvent{outboxEv}); err != nil {
					logger.Debug("Outbox atomic ledger insert notice", "event_id", payload.EventID, "reason", err)
				}

				// Complete processing after downstream handling
				if err := relayStore.MarkCompleted(payload.EventID); err != nil {
					metrics.RecordEscrowEvent("failed")
					logger.Error("Failed to mark event completed", "event_id", payload.EventID, "error", err)
				} else {
					metrics.RecordEscrowEvent("completed")
				}
				metrics.ObserveLedgerProcessing(time.Since(processingStarted))
				span.End()
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
	if err := shutdownTracer(shutdownCtx); err != nil {
		logger.Error("Failed to flush OpenTelemetry tracer on shutdown", "error", err)
	}
}

func handleMigrateCommand(logger *slog.Logger, args []string) {
	if len(args) == 0 {
		fmt.Println("Usage: relay migrate [up|down|version]")
		os.Exit(1)
	}

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		logger.Error("DATABASE_URL environment variable is required for migrations")
		os.Exit(1)
	}

	db, err := sql.Open("postgres", dbURL)
	if err != nil {
		logger.Error("Failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	migrator := migrations.NewMigrator(db, logger)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	switch args[0] {
	case "up":
		if err := migrator.RunPending(ctx); err != nil {
			logger.Error("Failed to run pending migrations", "error", err)
			os.Exit(1)
		}
		logger.Info("Migrations applied successfully")
	case "down":
		if err := migrator.RollbackLatest(ctx); err != nil {
			logger.Error("Failed to rollback migration", "error", err)
			os.Exit(1)
		}
		logger.Info("Migration rollback completed successfully")
	case "version":
		ver, dirty, err := migrator.GetVersion(ctx)
		if err != nil {
			logger.Error("Failed to get migration version", "error", err)
			os.Exit(1)
		}
		logger.Info("Current migration version", "version", ver, "dirty", dirty)
	default:
		logger.Error("Unknown migration command", "command", args[0])
		os.Exit(1)
	}
}

func checkHealth(endpoint string) error {
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(endpoint)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected health status: %d", resp.StatusCode)
	}
	return nil
}
