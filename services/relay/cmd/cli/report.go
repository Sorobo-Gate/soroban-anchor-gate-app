// Command relay-cli provides operational tooling for the SorobanAnchor Gate
// relay daemon.
//
// The report command produces the daily reconciliation export used by
// accounting teams to compare on-chain contract releases with anchor fiat
// payouts:
//
//	relay-cli report --date=2026-11-15 --format=csv
//
// Input is a settlement export document: either a JSON array or newline
// delimited JSON objects (JSONL), read from --input or stdin. Each record
// carries the settled escrow fields, and optionally the on-chain token amount
// and the fiat rate so the CLI can verify the payout arithmetic before the
// export is handed to accounting.
//
// Every record is validated (required fields, positive amounts, canonical
// currencies, Stellar account and transaction identifiers, date bucketing,
// unique escrow IDs and transaction hashes) and the report is refused with a
// non-zero exit status when any settled record fails verification. Output is
// either CSV with the fixed reconciliation columns or the same data as JSON
// for machine consumption.
package main

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	// reportSubcommand is the CLI verb for the audit export.
	reportSubcommand = "report"
	// reportDateFormat is the settlement bucketing date format.
	reportDateFormat = "2006-01-02"
	// defaultTolerance is the default fiat rounding tolerance used when
	// verifying token_amount x fiat_rate against fiat_amount, i.e. half a cent.
	defaultTolerance = "0.005"
	// maxReportInputBytes bounds the settlement export read into memory.
	maxReportInputBytes = 64 << 20 // 64 MiB
)

// ErrVerification marks a report that was refused because settled records did
// not reconcile. main exits with status 2 for verification failures and 1 for
// usage or I/O failures.
var ErrVerification = errors.New("report verification failed")

// reportCSVHeader is the fixed reconciliation column order required by
// accounting.
var reportCSVHeader = []string{
	"EscrowID",
	"Payer",
	"Beneficiary",
	"Token",
	"FiatAmount",
	"FiatCurrency",
	"TxHash",
	"ConfirmedAt",
}

var (
	// decimalPattern matches non-negative plain decimals without exponents,
	// signs or thousands separators: at most 18 integer digits and 12 decimals.
	decimalPattern = regexp.MustCompile(`^[0-9]{1,18}(\.[0-9]{1,12})?$`)
	// currencyPattern matches ISO-4217-style three letter currency codes.
	currencyPattern = regexp.MustCompile(`^[A-Za-z]{3}$`)
	// txHashPattern matches a Stellar transaction hash.
	txHashPattern = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)
)

// jsonDecimal accepts either a JSON string or a JSON number so settlement
// exports produced by different systems can be reconciled without losing
// decimal precision to float64.
type jsonDecimal string

// UnmarshalJSON implements json.Unmarshaler.
func (d *jsonDecimal) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		*d = ""
		return nil
	}
	var text string
	if err := json.Unmarshal(data, &text); err == nil {
		*d = jsonDecimal(text)
		return nil
	}
	var number json.Number
	if err := json.Unmarshal(data, &number); err == nil {
		*d = jsonDecimal(number.String())
		return nil
	}
	return fmt.Errorf("expected a decimal string or number, got %s", string(data))
}

// settlement is one settled escrow record from the relay's reconciliation
// export.
type settlement struct {
	EscrowID     uint64      `json:"escrow_id"`
	Payer        string      `json:"payer"`
	Beneficiary  string      `json:"beneficiary"`
	Token        string      `json:"token"`
	FiatAmount   jsonDecimal `json:"fiat_amount"`
	FiatCurrency string      `json:"fiat_currency"`
	TxHash       string      `json:"tx_hash"`
	ConfirmedAt  string      `json:"confirmed_at"`
	// TokenAmount and FiatRate are optional reconciliation inputs: when both
	// are present the CLI verifies token_amount * fiat_rate == fiat_amount
	// within the configured tolerance.
	TokenAmount jsonDecimal `json:"token_amount,omitempty"`
	FiatRate    jsonDecimal `json:"fiat_rate,omitempty"`
}

// ReportRow is a validated settlement row ready for export.
type ReportRow struct {
	EscrowID     uint64
	Payer        string
	Beneficiary  string
	Token        string
	FiatAmount   string
	FiatCurrency string
	TxHash       string
	ConfirmedAt  time.Time
}

// Report is a verified daily reconciliation export.
type Report struct {
	// Date is the UTC settlement date the report covers.
	Date time.Time
	// Rows are the settled records ordered by escrow ID.
	Rows []ReportRow
	// Totals holds exact per-currency fiat totals.
	Totals map[string]*big.Rat
	// VerifiedArithmetic is the number of rows whose token_amount x fiat_rate
	// product was reconciled against fiat_amount.
	VerifiedArithmetic int
}

// CurrencyTotal is one currency's exact fiat total, formatted for display.
type CurrencyTotal struct {
	Currency string
	Amount   string
}

// main is the relay-cli entry point.
func main() {
	os.Exit(realMain(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

// realMain dispatches subcommands and returns the process exit status.
func realMain(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		writeUsage(stderr)
		return 1
	}

	switch args[0] {
	case reportSubcommand:
		if err := run(args[1:], stdin, stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "relay-cli %s: %v\n", reportSubcommand, err)
			if errors.Is(err, ErrVerification) {
				return 2
			}
			return 1
		}
		return 0
	case "help", "-h", "--help":
		writeUsage(stdout)
		return 0
	default:
		fmt.Fprintf(stderr, "relay-cli: unknown command %q\n", args[0])
		writeUsage(stderr)
		return 1
	}
}

// run executes the report command.
func run(args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("relay-cli report", flag.ContinueOnError)
	fs.SetOutput(stderr)

	dateFlag := fs.String("date", "", "settlement date to export in YYYY-MM-DD (UTC); required")
	formatFlag := fs.String("format", "csv", "export format: csv or json")
	inputFlag := fs.String("input", "-", "settlement export path (JSON array or JSONL), or - for stdin")
	outputFlag := fs.String("output", "-", "output path, or - for stdout")
	toleranceFlag := fs.String("tolerance", defaultTolerance, "maximum allowed difference when verifying token_amount x fiat_rate against fiat_amount")

	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}

	if strings.TrimSpace(*dateFlag) == "" {
		return errors.New("--date is required")
	}
	date, err := time.Parse(reportDateFormat, strings.TrimSpace(*dateFlag))
	if err != nil {
		return fmt.Errorf("invalid --date %q: expected YYYY-MM-DD", *dateFlag)
	}
	date = date.UTC()

	format := strings.ToLower(strings.TrimSpace(*formatFlag))
	switch format {
	case "csv", "json":
	default:
		return fmt.Errorf("invalid --format %q: expected csv or json", *formatFlag)
	}

	tolerance, err := parseTolerance(*toleranceFlag)
	if err != nil {
		return err
	}

	records, err := readSettlements(*inputFlag, stdin)
	if err != nil {
		return err
	}

	report, err := buildReport(records, date, tolerance)
	if err != nil {
		return err
	}

	output, closeOutput, err := openReportOutput(*outputFlag, stdout)
	if err != nil {
		return err
	}

	if format == "json" {
		err = report.WriteJSON(output)
	} else {
		err = report.WriteCSV(output)
	}
	if err != nil {
		_ = closeOutput()
		return err
	}
	if err := closeOutput(); err != nil {
		return err
	}

	return report.WriteSummary(stderr)
}

// writeUsage prints the command help text.
func writeUsage(w io.Writer) {
	fmt.Fprint(w, `relay-cli - SorobanAnchor Gate relay operations tooling

Usage:
  relay-cli report --date=YYYY-MM-DD [--format=csv|json] [--input=PATH] [--output=PATH] [--tolerance=0.005]

Commands:
  report    Export and verify the settled escrow reconciliation report for one UTC day.

Report flags:
  --date       Settlement date to export (required, YYYY-MM-DD, UTC).
  --format     Output format: csv (default) or json.
  --input      Settlement export path (JSON array or JSONL), or - for stdin (default).
  --output     Output path, or - for stdout (default).
  --tolerance  Allowed fiat difference when checking token_amount x fiat_rate
               against fiat_amount. Defaults to 0.005.

Exit status:
  0  report written and every settled record verified
  1  usage or I/O failure
  2  report refused: a settled record failed verification

Examples:
  relay-cli report --date=2026-11-15 --format=csv
  relay-cli report --date=2026-11-15 --input=settlements.jsonl --output=recon-2026-11-15.csv
`)
}

// readSettlements loads the settlement export from path, or stdin when path is
// "-". Both a JSON array and newline delimited JSON objects are accepted.
func readSettlements(path string, stdin io.Reader) ([]settlement, error) {
	var (
		source   io.Reader
		closeSrc func() error = func() error { return nil }
	)
	if path == "-" || strings.TrimSpace(path) == "" {
		if stdin == nil {
			return nil, errors.New("--input is stdin but no input stream is available")
		}
		source = stdin
	} else {
		file, err := os.Open(path)
		if err != nil {
			return nil, fmt.Errorf("failed to open settlement export %q: %w", path, err)
		}
		source = file
		closeSrc = file.Close
	}
	defer func() { _ = closeSrc() }()

	data, err := io.ReadAll(io.LimitReader(source, maxReportInputBytes+1))
	if err != nil {
		return nil, fmt.Errorf("failed to read settlement export: %w", err)
	}
	if len(data) > maxReportInputBytes {
		return nil, fmt.Errorf("settlement export exceeds the %d byte limit", maxReportInputBytes)
	}

	return decodeSettlements(data)
}

// decodeSettlements parses a JSON array or JSONL settlement export.
func decodeSettlements(data []byte) ([]settlement, error) {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" {
		return nil, nil
	}

	if strings.HasPrefix(trimmed, "[") {
		var records []settlement
		if err := json.Unmarshal([]byte(trimmed), &records); err != nil {
			return nil, fmt.Errorf("failed to parse settlement export as a JSON array: %w", err)
		}
		return records, nil
	}

	decoder := json.NewDecoder(strings.NewReader(trimmed))
	var records []settlement
	for {
		var record settlement
		if err := decoder.Decode(&record); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, fmt.Errorf("failed to parse settlement export line %d: %w", len(records)+1, err)
		}
		records = append(records, record)
	}
	return records, nil
}

// buildReport validates every record, verifies reconciliation arithmetic and
// returns the ordered report. Any invalid or unmatched record fails the whole
// export so accounting never receives a silently incomplete reconciliation.
func buildReport(records []settlement, date time.Time, tolerance *big.Rat) (*Report, error) {
	if tolerance == nil {
		parsed, err := parseTolerance(defaultTolerance)
		if err != nil {
			return nil, err
		}
		tolerance = parsed
	}

	report := &Report{
		Date:   date.UTC(),
		Rows:   make([]ReportRow, 0, len(records)),
		Totals: make(map[string]*big.Rat),
	}

	seenEscrows := make(map[uint64]struct{}, len(records))
	seenHashes := make(map[string]struct{}, len(records))

	for index, record := range records {
		row, amount, verified, err := validateSettlement(record, report.Date, tolerance)
		if err != nil {
			return nil, fmt.Errorf("%w: record %d: %v", ErrVerification, index+1, err)
		}
		if _, exists := seenEscrows[row.EscrowID]; exists {
			return nil, fmt.Errorf("%w: record %d: duplicate escrow_id %d", ErrVerification, index+1, row.EscrowID)
		}
		seenEscrows[row.EscrowID] = struct{}{}
		if _, exists := seenHashes[row.TxHash]; exists {
			return nil, fmt.Errorf("%w: record %d: duplicate tx_hash %s", ErrVerification, index+1, row.TxHash)
		}
		seenHashes[row.TxHash] = struct{}{}

		report.Rows = append(report.Rows, row)
		if verified {
			report.VerifiedArithmetic++
		}
		addToTotals(report.Totals, row.FiatCurrency, amount)
	}

	sort.Slice(report.Rows, func(i, j int) bool {
		if report.Rows[i].EscrowID != report.Rows[j].EscrowID {
			return report.Rows[i].EscrowID < report.Rows[j].EscrowID
		}
		return report.Rows[i].TxHash < report.Rows[j].TxHash
	})

	// Cross-check the accumulated totals against an independent pass over the
	// emitted row values. This catches truncation or normalisation drift between
	// the verified amount and the amount written to the export.
	recomputed := make(map[string]*big.Rat, len(report.Totals))
	for _, row := range report.Rows {
		amount, _, err := parseDecimal("fiat_amount", row.FiatAmount)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrVerification, err)
		}
		addToTotals(recomputed, row.FiatCurrency, amount)
	}
	if !equalTotals(report.Totals, recomputed) {
		return nil, fmt.Errorf("%w: aggregate fiat totals do not match the settled records", ErrVerification)
	}

	return report, nil
}

// validateSettlement validates one record and returns the export row, the
// parsed fiat amount and whether on-chain arithmetic was reconciled.
func validateSettlement(record settlement, date time.Time, tolerance *big.Rat) (ReportRow, *big.Rat, bool, error) {
	if record.EscrowID == 0 {
		return ReportRow{}, nil, false, errors.New("escrow_id must be greater than zero")
	}
	if err := validateIdentifier("payer", record.Payer); err != nil {
		return ReportRow{}, nil, false, err
	}
	if err := validateIdentifier("beneficiary", record.Beneficiary); err != nil {
		return ReportRow{}, nil, false, err
	}
	if err := validateIdentifier("token", record.Token); err != nil {
		return ReportRow{}, nil, false, err
	}

	currency := strings.ToUpper(strings.TrimSpace(record.FiatCurrency))
	if !currencyPattern.MatchString(currency) {
		return ReportRow{}, nil, false, fmt.Errorf("fiat_currency %q must be a three letter currency code", record.FiatCurrency)
	}

	amount, canonicalAmount, err := parseDecimal("fiat_amount", string(record.FiatAmount))
	if err != nil {
		return ReportRow{}, nil, false, err
	}
	if amount.Sign() <= 0 {
		return ReportRow{}, nil, false, fmt.Errorf("fiat_amount %q must be greater than zero", record.FiatAmount)
	}

	txHash := strings.ToLower(strings.TrimSpace(record.TxHash))
	if !txHashPattern.MatchString(txHash) {
		return ReportRow{}, nil, false, fmt.Errorf("tx_hash %q must be a 64 character hex transaction hash", record.TxHash)
	}

	confirmedAt, err := parseConfirmedAt(record.ConfirmedAt)
	if err != nil {
		return ReportRow{}, nil, false, err
	}
	if confirmedAt.Year() != date.Year() || confirmedAt.Month() != date.Month() || confirmedAt.Day() != date.Day() {
		return ReportRow{}, nil, false, fmt.Errorf("confirmed_at %s is outside the requested settlement date %s",
			confirmedAt.Format(time.RFC3339), date.Format(reportDateFormat))
	}

	tokenAmount := strings.TrimSpace(string(record.TokenAmount))
	rate := strings.TrimSpace(string(record.FiatRate))
	if (tokenAmount == "") != (rate == "") {
		return ReportRow{}, nil, false, errors.New("token_amount and fiat_rate must be provided together")
	}
	verified := false
	if tokenAmount != "" {
		token, _, err := parseDecimal("token_amount", tokenAmount)
		if err != nil {
			return ReportRow{}, nil, false, err
		}
		if token.Sign() <= 0 {
			return ReportRow{}, nil, false, fmt.Errorf("token_amount %q must be greater than zero", tokenAmount)
		}
		fiatRate, _, err := parseDecimal("fiat_rate", rate)
		if err != nil {
			return ReportRow{}, nil, false, err
		}
		if fiatRate.Sign() <= 0 {
			return ReportRow{}, nil, false, fmt.Errorf("fiat_rate %q must be greater than zero", rate)
		}

		expected := new(big.Rat).Mul(token, fiatRate)
		diff := new(big.Rat).Sub(expected, amount)
		diff.Abs(diff)
		if diff.Cmp(tolerance) > 0 {
			return ReportRow{}, nil, false, fmt.Errorf(
				"arithmetic mismatch for escrow %d: token_amount %s x fiat_rate %s = %s, but fiat_amount is %s (tolerance %s)",
				record.EscrowID, tokenAmount, rate, formatRat(expected), canonicalAmount, formatRat(tolerance),
			)
		}
		verified = true
	}

	return ReportRow{
		EscrowID:     record.EscrowID,
		Payer:        strings.TrimSpace(record.Payer),
		Beneficiary:  strings.TrimSpace(record.Beneficiary),
		Token:        strings.TrimSpace(record.Token),
		FiatAmount:   canonicalAmount,
		FiatCurrency: currency,
		TxHash:       txHash,
		ConfirmedAt:  confirmedAt,
	}, amount, verified, nil
}

// validateIdentifier rejects empty identifiers and values carrying whitespace
// or control characters, which would corrupt a reconciliation export.
func validateIdentifier(field, value string) error {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return fmt.Errorf("%s must not be empty", field)
	}
	for _, r := range trimmed {
		if r < 0x20 || r == 0x7f || r == ' ' {
			return fmt.Errorf("%s %q must not contain whitespace or control characters", field, value)
		}
	}
	return nil
}

// parseConfirmedAt parses an RFC3339 timestamp and normalises it to UTC.
func parseConfirmedAt(value string) (time.Time, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return time.Time{}, errors.New("confirmed_at must not be empty")
	}
	parsed, err := time.Parse(time.RFC3339, trimmed)
	if err != nil {
		return time.Time{}, fmt.Errorf("confirmed_at %q must be an RFC3339 timestamp", value)
	}
	return parsed.UTC(), nil
}

// parseDecimal converts a validated plain decimal into an exact rational and
// returns its canonical string form (leading zeros removed, fractional digits
// preserved).
func parseDecimal(field, value string) (*big.Rat, string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil, "", fmt.Errorf("%s must not be empty", field)
	}
	if !decimalPattern.MatchString(trimmed) {
		return nil, "", fmt.Errorf("%s %q must be a plain non-negative decimal with at most 12 fractional digits", field, value)
	}
	rational, ok := new(big.Rat).SetString(trimmed)
	if !ok {
		return nil, "", fmt.Errorf("%s %q is not a valid decimal", field, value)
	}
	return rational, canonicalDecimal(trimmed), nil
}

// canonicalDecimal strips leading zeros from the integer part while preserving
// the fractional digits as provided.
func canonicalDecimal(value string) string {
	integer := value
	fraction := ""
	if index := strings.IndexByte(value, '.'); index >= 0 {
		integer = value[:index]
		fraction = value[index+1:]
	}
	integer = strings.TrimLeft(integer, "0")
	if integer == "" {
		integer = "0"
	}
	if fraction == "" {
		return integer
	}
	return integer + "." + fraction
}

// parseTolerance parses the reconciliation tolerance.
func parseTolerance(value string) (*big.Rat, error) {
	rational, _, err := parseDecimal("tolerance", value)
	if err != nil {
		return nil, err
	}
	if rational.Sign() < 0 {
		return nil, errors.New("tolerance must not be negative")
	}
	return rational, nil
}

// addToTotals accumulates amount under currency.
func addToTotals(totals map[string]*big.Rat, currency string, amount *big.Rat) {
	current, ok := totals[currency]
	if !ok {
		current = new(big.Rat)
		totals[currency] = current
	}
	current.Add(current, amount)
}

// equalTotals compares two per-currency total maps exactly.
func equalTotals(a, b map[string]*big.Rat) bool {
	if len(a) != len(b) {
		return false
	}
	for currency, left := range a {
		right, ok := b[currency]
		if !ok || left.Cmp(right) != 0 {
			return false
		}
	}
	return true
}

// formatRat renders an exact rational as a decimal string without losing
// precision or emitting an exponent.
func formatRat(value *big.Rat) string {
	if value == nil {
		return "0"
	}
	if value.IsInt() {
		return value.Num().String()
	}
	formatted := value.FloatString(12)
	formatted = strings.TrimRight(formatted, "0")
	return strings.TrimSuffix(formatted, ".")
}

// SortedTotals returns the per-currency totals ordered by currency code.
func (r *Report) SortedTotals() []CurrencyTotal {
	if r == nil {
		return nil
	}
	currencies := make([]string, 0, len(r.Totals))
	for currency := range r.Totals {
		currencies = append(currencies, currency)
	}
	sort.Strings(currencies)

	totals := make([]CurrencyTotal, 0, len(currencies))
	for _, currency := range currencies {
		totals = append(totals, CurrencyTotal{Currency: currency, Amount: formatRat(r.Totals[currency])})
	}
	return totals
}

// WriteCSV writes the reconciliation export with the required column order.
func (r *Report) WriteCSV(w io.Writer) error {
	if r == nil {
		return errors.New("report is nil")
	}
	writer := csv.NewWriter(w)

	if err := writer.Write(reportCSVHeader); err != nil {
		return fmt.Errorf("failed to write CSV header: %w", err)
	}
	for _, row := range r.Rows {
		record := []string{
			fmt.Sprintf("%d", row.EscrowID),
			row.Payer,
			row.Beneficiary,
			row.Token,
			row.FiatAmount,
			row.FiatCurrency,
			row.TxHash,
			row.ConfirmedAt.Format(time.RFC3339),
		}
		if err := writer.Write(record); err != nil {
			return fmt.Errorf("failed to write CSV row for escrow %d: %w", row.EscrowID, err)
		}
	}

	writer.Flush()
	if err := writer.Error(); err != nil {
		return fmt.Errorf("failed to flush CSV export: %w", err)
	}
	return nil
}

// jsonReportRow is the JSON representation of one settled record.
type jsonReportRow struct {
	EscrowID     uint64 `json:"escrow_id"`
	Payer        string `json:"payer"`
	Beneficiary  string `json:"beneficiary"`
	Token        string `json:"token"`
	FiatAmount   string `json:"fiat_amount"`
	FiatCurrency string `json:"fiat_currency"`
	TxHash       string `json:"tx_hash"`
	ConfirmedAt  string `json:"confirmed_at"`
}

// jsonReport is the JSON export document.
type jsonReport struct {
	Date               string            `json:"date"`
	RecordCount        int               `json:"record_count"`
	VerifiedArithmetic int               `json:"verified_arithmetic_records"`
	Totals             map[string]string `json:"totals_by_currency"`
	Rows               []jsonReportRow   `json:"rows"`
}

// WriteJSON writes the same report data as an indented JSON document.
func (r *Report) WriteJSON(w io.Writer) error {
	if r == nil {
		return errors.New("report is nil")
	}

	document := jsonReport{
		Date:               r.Date.Format(reportDateFormat),
		RecordCount:        len(r.Rows),
		VerifiedArithmetic: r.VerifiedArithmetic,
		Totals:             make(map[string]string, len(r.Totals)),
		Rows:               make([]jsonReportRow, 0, len(r.Rows)),
	}
	for _, total := range r.SortedTotals() {
		document.Totals[total.Currency] = total.Amount
	}
	for _, row := range r.Rows {
		document.Rows = append(document.Rows, jsonReportRow{
			EscrowID:     row.EscrowID,
			Payer:        row.Payer,
			Beneficiary:  row.Beneficiary,
			Token:        row.Token,
			FiatAmount:   row.FiatAmount,
			FiatCurrency: row.FiatCurrency,
			TxHash:       row.TxHash,
			ConfirmedAt:  row.ConfirmedAt.Format(time.RFC3339),
		})
	}

	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(document); err != nil {
		return fmt.Errorf("failed to write JSON export: %w", err)
	}
	return nil
}

// WriteSummary reports record counts and exact per-currency totals for the
// operator running the export. The summary never pollutes the export stream.
func (r *Report) WriteSummary(w io.Writer) error {
	if r == nil {
		return errors.New("report is nil")
	}
	if _, err := fmt.Fprintf(w, "relay-cli report: verified %d settled record(s) for %s (%d arithmetic check(s))\n",
		len(r.Rows), r.Date.Format(reportDateFormat), r.VerifiedArithmetic); err != nil {
		return err
	}
	for _, total := range r.SortedTotals() {
		if _, err := fmt.Fprintf(w, "  %s %s\n", total.Currency, total.Amount); err != nil {
			return err
		}
	}
	return nil
}

// openReportOutput opens the export destination. The returned closer is a
// no-op for stdout and must be called once to flush file writes.
func openReportOutput(path string, stdout io.Writer) (io.Writer, func() error, error) {
	if path == "-" || strings.TrimSpace(path) == "" {
		if stdout == nil {
			return nil, nil, errors.New("--output is stdout but no output stream is available")
		}
		return stdout, func() error { return nil }, nil
	}

	file, err := os.Create(path)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create output file %q: %w", path, err)
	}
	return file, file.Close, nil
}
