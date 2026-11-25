package main

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	payer       = "GCHIAK3LLDWJ5N4Z4TH6GHCH2LQX5SUL2WEU42I324CFXGDUWXMNNSDZ"
	beneficiary = "GABFQIK63R2NETJM7T673EAMZN4RJLLGP3OFUEJU5SZVTGWUKULZJNL6"
	token       = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
)

// settlementJSON builds one JSONL settlement record. Empty optional fields are
// omitted so tests exercise both shapes of the export format.
func settlementJSON(escrowID uint64, hash, amount, currency, confirmedAt, tokenAmount, rate string) string {
	record := map[string]interface{}{
		"escrow_id":     escrowID,
		"payer":         payer,
		"beneficiary":   beneficiary,
		"token":         token,
		"fiat_amount":   amount,
		"fiat_currency": currency,
		"tx_hash":       hash,
		"confirmed_at":  confirmedAt,
	}
	if tokenAmount != "" {
		record["token_amount"] = tokenAmount
	}
	if rate != "" {
		record["fiat_rate"] = rate
	}
	data, err := json.Marshal(record)
	if err != nil {
		panic(err)
	}
	return string(data)
}

// hashOf returns a deterministic 64-character transaction hash.
func hashOf(seed string) string {
	return strings.Repeat(seed, 64/len(seed)+1)[:64]
}

func runReport(t *testing.T, args []string, input string) (string, string, error) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	err := run(args, strings.NewReader(input), &stdout, &stderr)
	return stdout.String(), stderr.String(), err
}

func TestReportCSVColumnIntegrity(t *testing.T) {
	input := strings.Join([]string{
		settlementJSON(2, hashOf("ab"), "50.00", "eur", "2026-11-15T12:30:00Z", "", ""),
		settlementJSON(1, hashOf("cd"), "118.50", "USD", "2026-11-15T09:00:00Z", "1000", "0.1185"),
	}, "\n")

	stdout, stderr, err := runReport(t, []string{"--date", "2026-11-15"}, input)
	if err != nil {
		t.Fatalf("run: %v", err)
	}

	rows, err := csv.NewReader(strings.NewReader(stdout)).ReadAll()
	if err != nil {
		t.Fatalf("parse CSV output: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("got %d CSV rows (including header), want 3", len(rows))
	}

	wantHeader := []string{"EscrowID", "Payer", "Beneficiary", "Token", "FiatAmount", "FiatCurrency", "TxHash", "ConfirmedAt"}
	if len(rows[0]) != len(wantHeader) {
		t.Fatalf("header has %d columns, want %d", len(rows[0]), len(wantHeader))
	}
	for i, column := range wantHeader {
		if rows[0][i] != column {
			t.Errorf("header column %d = %q, want %q", i, rows[0][i], column)
		}
	}
	for index, row := range rows[1:] {
		if len(row) != len(wantHeader) {
			t.Fatalf("row %d has %d columns, want %d", index, len(row), len(wantHeader))
		}
	}

	// Rows are ordered by escrow ID and currency codes are canonicalised.
	if rows[1][0] != "1" || rows[2][0] != "2" {
		t.Fatalf("rows are not ordered by escrow ID: %q, %q", rows[1][0], rows[2][0])
	}
	if rows[1][5] != "USD" || rows[2][5] != "EUR" {
		t.Fatalf("currency codes were not upper-cased: %q, %q", rows[1][5], rows[2][5])
	}
	if rows[1][4] != "118.50" {
		t.Fatalf("fiat amount = %q, want 118.50", rows[1][4])
	}
	if rows[1][7] != "2026-11-15T09:00:00Z" {
		t.Fatalf("confirmed_at = %q, want RFC3339 UTC", rows[1][7])
	}
	if rows[1][6] != hashOf("cd") {
		t.Fatalf("tx hash = %q, want %q", rows[1][6], hashOf("cd"))
	}

	if !strings.Contains(stderr, "verified 2 settled record(s) for 2026-11-15") {
		t.Fatalf("summary missing record count: %q", stderr)
	}
	if !strings.Contains(stderr, "USD 118.5") || !strings.Contains(stderr, "EUR 50") {
		t.Fatalf("summary missing exact per-currency totals: %q", stderr)
	}
	if !strings.Contains(stderr, "1 arithmetic check(s)") {
		t.Fatalf("summary missing arithmetic check count: %q", stderr)
	}
}

func TestReportCSVQuoting(t *testing.T) {
	var stdout, stderr bytes.Buffer
	record := map[string]interface{}{
		"escrow_id":     7,
		"payer":         `GPAYER,"quoted"`,
		"beneficiary":   "GBENEFICIARY",
		"token":         token,
		"fiat_amount":   "10.00",
		"fiat_currency": "GBP",
		"tx_hash":       hashOf("ef"),
		"confirmed_at":  "2026-11-15T00:00:00Z",
	}
	data, err := json.Marshal(record)
	if err != nil {
		t.Fatalf("marshal record: %v", err)
	}

	if err := run([]string{"--date", "2026-11-15"}, strings.NewReader(string(data)), &stdout, &stderr); err != nil {
		t.Fatalf("run: %v", err)
	}

	rows, err := csv.NewReader(strings.NewReader(stdout.String())).ReadAll()
	if err != nil {
		t.Fatalf("parse CSV: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	if rows[1][1] != `GPAYER,"quoted"` {
		t.Fatalf("payer = %q, want the original value after CSV round-trip", rows[1][1])
	}
	if len(rows[1]) != len(reportCSVHeader) {
		t.Fatalf("quoted row has %d columns, want %d", len(rows[1]), len(reportCSVHeader))
	}
}

func TestReportJSONFormat(t *testing.T) {
	input := settlementJSON(3, hashOf("11"), "42.00", "USD", "2026-11-15T15:45:00Z", "", "")
	stdout, _, err := runReport(t, []string{"--date", "2026-11-15", "--format", "json"}, input)
	if err != nil {
		t.Fatalf("run: %v", err)
	}

	var document struct {
		Date        string            `json:"date"`
		RecordCount int               `json:"record_count"`
		Totals      map[string]string `json:"totals_by_currency"`
		Rows        []struct {
			EscrowID     uint64 `json:"escrow_id"`
			FiatAmount   string `json:"fiat_amount"`
			FiatCurrency string `json:"fiat_currency"`
			ConfirmedAt  string `json:"confirmed_at"`
		} `json:"rows"`
	}
	if err := json.Unmarshal([]byte(stdout), &document); err != nil {
		t.Fatalf("parse JSON output: %v", err)
	}
	if document.Date != "2026-11-15" || document.RecordCount != 1 {
		t.Fatalf("unexpected JSON document: %+v", document)
	}
	if document.Totals["USD"] != "42" {
		t.Fatalf("USD total = %q, want 42", document.Totals["USD"])
	}
	if len(document.Rows) != 1 || document.Rows[0].EscrowID != 3 {
		t.Fatalf("unexpected rows: %+v", document.Rows)
	}
	if document.Rows[0].ConfirmedAt != "2026-11-15T15:45:00Z" {
		t.Fatalf("confirmed_at = %q", document.Rows[0].ConfirmedAt)
	}
}

func TestReportArithmeticVerification(t *testing.T) {
	t.Run("product within tolerance", func(t *testing.T) {
		input := settlementJSON(1, hashOf("22"), "118.504", "USD", "2026-11-15T10:00:00Z", "1000", "0.1185")
		if _, _, err := runReport(t, []string{"--date", "2026-11-15"}, input); err != nil {
			t.Fatalf("expected within-tolerance record to verify, got %v", err)
		}
	})

	t.Run("product outside tolerance", func(t *testing.T) {
		input := settlementJSON(1, hashOf("22"), "118.00", "USD", "2026-11-15T10:00:00Z", "1000", "0.1185")
		_, _, err := runReport(t, []string{"--date", "2026-11-15"}, input)
		if !errors.Is(err, ErrVerification) {
			t.Fatalf("expected ErrVerification, got %v", err)
		}
		if !strings.Contains(err.Error(), "arithmetic mismatch") {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("custom tolerance", func(t *testing.T) {
		input := settlementJSON(1, hashOf("22"), "118.00", "USD", "2026-11-15T10:00:00Z", "1000", "0.1185")
		if _, _, err := runReport(t, []string{"--date", "2026-11-15", "--tolerance", "0.6"}, input); err != nil {
			t.Fatalf("expected custom tolerance to accept the record, got %v", err)
		}
	})

	t.Run("half of the pair", func(t *testing.T) {
		input := settlementJSON(1, hashOf("22"), "118.50", "USD", "2026-11-15T10:00:00Z", "1000", "")
		_, _, err := runReport(t, []string{"--date", "2026-11-15"}, input)
		if !errors.Is(err, ErrVerification) {
			t.Fatalf("expected ErrVerification, got %v", err)
		}
	})
}

func TestReportRejectsInvalidRecords(t *testing.T) {
	tests := []struct {
		name    string
		record  string
		wantMsg string
	}{
		{
			name:    "zero escrow id",
			record:  settlementJSON(0, hashOf("33"), "10.00", "USD", "2026-11-15T10:00:00Z", "", ""),
			wantMsg: "escrow_id must be greater than zero",
		},
		{
			name:    "bad currency",
			record:  settlementJSON(1, hashOf("33"), "10.00", "US", "2026-11-15T10:00:00Z", "", ""),
			wantMsg: "three letter currency code",
		},
		{
			name:    "negative amount",
			record:  settlementJSON(1, hashOf("33"), "-10.00", "USD", "2026-11-15T10:00:00Z", "", ""),
			wantMsg: "plain non-negative decimal",
		},
		{
			name:    "exponent amount",
			record:  settlementJSON(1, hashOf("33"), "1e5", "USD", "2026-11-15T10:00:00Z", "", ""),
			wantMsg: "plain non-negative decimal",
		},
		{
			name:    "zero amount",
			record:  settlementJSON(1, hashOf("33"), "0.00", "USD", "2026-11-15T10:00:00Z", "", ""),
			wantMsg: "must be greater than zero",
		},
		{
			name:    "short tx hash",
			record:  settlementJSON(1, "abcd", "10.00", "USD", "2026-11-15T10:00:00Z", "", ""),
			wantMsg: "64 character hex transaction hash",
		},
		{
			name:    "bad timestamp",
			record:  settlementJSON(1, hashOf("33"), "10.00", "USD", "2026-11-15 10:00:00", "", ""),
			wantMsg: "RFC3339",
		},
		{
			name:    "outside date",
			record:  settlementJSON(1, hashOf("33"), "10.00", "USD", "2026-11-16T00:00:00Z", "", ""),
			wantMsg: "outside the requested settlement date",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, err := runReport(t, []string{"--date", "2026-11-15"}, tt.record)
			if !errors.Is(err, ErrVerification) {
				t.Fatalf("expected ErrVerification, got %v", err)
			}
			if tt.wantMsg != "" && !strings.Contains(err.Error(), tt.wantMsg) {
				t.Fatalf("error %q does not contain %q", err, tt.wantMsg)
			}
		})
	}
}

func TestReportRejectsEmptyPayer(t *testing.T) {
	record := fmt.Sprintf(`{"escrow_id":1,"payer":"","beneficiary":%q,"token":%q,"fiat_amount":"10.00","fiat_currency":"USD","tx_hash":%q,"confirmed_at":"2026-11-15T10:00:00Z"}`,
		beneficiary, token, hashOf("33"))
	_, _, err := runReport(t, []string{"--date", "2026-11-15"}, record)
	if !errors.Is(err, ErrVerification) {
		t.Fatalf("expected ErrVerification, got %v", err)
	}
	if !strings.Contains(err.Error(), "payer must not be empty") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestReportRejectsPayerWhitespace(t *testing.T) {
	record := fmt.Sprintf(`{"escrow_id":1,"payer":"G PAYER","beneficiary":%q,"token":%q,"fiat_amount":"10.00","fiat_currency":"USD","tx_hash":%q,"confirmed_at":"2026-11-15T10:00:00Z"}`,
		beneficiary, token, hashOf("33"))
	_, _, err := runReport(t, []string{"--date", "2026-11-15"}, record)
	if !errors.Is(err, ErrVerification) {
		t.Fatalf("expected ErrVerification, got %v", err)
	}
	if !strings.Contains(err.Error(), "must not contain whitespace") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestReportRejectsDuplicates(t *testing.T) {
	t.Run("duplicate escrow", func(t *testing.T) {
		input := strings.Join([]string{
			settlementJSON(1, hashOf("44"), "10.00", "USD", "2026-11-15T10:00:00Z", "", ""),
			settlementJSON(1, hashOf("55"), "20.00", "USD", "2026-11-15T11:00:00Z", "", ""),
		}, "\n")
		_, _, err := runReport(t, []string{"--date", "2026-11-15"}, input)
		if !errors.Is(err, ErrVerification) || !strings.Contains(err.Error(), "duplicate escrow_id 1") {
			t.Fatalf("expected duplicate escrow error, got %v", err)
		}
	})

	t.Run("duplicate transaction hash", func(t *testing.T) {
		input := strings.Join([]string{
			settlementJSON(1, hashOf("44"), "10.00", "USD", "2026-11-15T10:00:00Z", "", ""),
			settlementJSON(2, hashOf("44"), "20.00", "USD", "2026-11-15T11:00:00Z", "", ""),
		}, "\n")
		_, _, err := runReport(t, []string{"--date", "2026-11-15"}, input)
		if !errors.Is(err, ErrVerification) || !strings.Contains(err.Error(), "duplicate tx_hash") {
			t.Fatalf("expected duplicate tx_hash error, got %v", err)
		}
	})
}

func TestReportDateNormalisation(t *testing.T) {
	// 01:00+05:00 is the previous UTC day, so it must not appear in the
	// 2026-11-15 export.
	input := settlementJSON(1, hashOf("66"), "10.00", "USD", "2026-11-15T01:00:00+05:00", "", "")
	_, _, err := runReport(t, []string{"--date", "2026-11-15"}, input)
	if !errors.Is(err, ErrVerification) {
		t.Fatalf("expected ErrVerification, got %v", err)
	}
}

func TestReportEmptyInput(t *testing.T) {
	stdout, stderr, err := runReport(t, []string{"--date", "2026-11-15"}, "")
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	rows, err := csv.NewReader(strings.NewReader(stdout)).ReadAll()
	if err != nil {
		t.Fatalf("parse CSV: %v", err)
	}
	if len(rows) != 1 || len(rows[0]) != len(reportCSVHeader) {
		t.Fatalf("expected a header-only export, got %v", rows)
	}
	if !strings.Contains(stderr, "verified 0 settled record(s)") {
		t.Fatalf("unexpected summary: %q", stderr)
	}
}

func TestReportOutputFile(t *testing.T) {
	dir := t.TempDir()
	outputPath := filepath.Join(dir, "recon.csv")
	input := settlementJSON(9, hashOf("77"), "7.25", "EUR", "2026-11-15T08:00:00Z", "", "")

	var stdout, stderr bytes.Buffer
	if err := run([]string{"--date", "2026-11-15", "--output", outputPath}, strings.NewReader(input), &stdout, &stderr); err != nil {
		t.Fatalf("run: %v", err)
	}
	if stdout.Len() != 0 {
		t.Fatalf("expected no stdout when writing a file, got %q", stdout.String())
	}

	data, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatalf("read output file: %v", err)
	}
	rows, err := csv.NewReader(strings.NewReader(string(data))).ReadAll()
	if err != nil {
		t.Fatalf("parse CSV file: %v", err)
	}
	if len(rows) != 2 || rows[1][0] != "9" || rows[1][5] != "EUR" {
		t.Fatalf("unexpected output file contents: %v", rows)
	}
}

func TestReportFlagValidation(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		wantMsg string
	}{
		{name: "missing date", args: nil, wantMsg: "--date is required"},
		{name: "bad date", args: []string{"--date", "15-11-2026"}, wantMsg: "invalid --date"},
		{name: "bad format", args: []string{"--date", "2026-11-15", "--format", "xlsx"}, wantMsg: "invalid --format"},
		{name: "bad tolerance", args: []string{"--date", "2026-11-15", "--tolerance", "abc"}, wantMsg: "tolerance"},
		{name: "extra argument", args: []string{"--date", "2026-11-15", "extra"}, wantMsg: "unexpected argument"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, err := runReport(t, tt.args, "")
			if err == nil {
				t.Fatal("expected an error, got nil")
			}
			if !strings.Contains(err.Error(), tt.wantMsg) {
				t.Fatalf("error %q does not contain %q", err, tt.wantMsg)
			}
			if errors.Is(err, ErrVerification) {
				t.Fatal("usage errors must not be reported as verification failures")
			}
		})
	}
}

func TestRealMainExitStatus(t *testing.T) {
	var stdout, stderr bytes.Buffer

	if status := realMain(nil, strings.NewReader(""), &stdout, &stderr); status != 1 {
		t.Fatalf("no arguments exit status = %d, want 1", status)
	}
	if status := realMain([]string{"help"}, strings.NewReader(""), &stdout, &stderr); status != 0 {
		t.Fatalf("help exit status = %d, want 0", status)
	}
	if !strings.Contains(stdout.String(), "relay-cli report --date") {
		t.Fatalf("help text missing usage: %q", stdout.String())
	}

	stdout.Reset()
	stderr.Reset()
	if status := realMain([]string{"unknown"}, strings.NewReader(""), &stdout, &stderr); status != 1 {
		t.Fatalf("unknown command exit status = %d, want 1", status)
	}

	stdout.Reset()
	stderr.Reset()
	badRecord := settlementJSON(1, hashOf("88"), "10.00", "USD", "2026-11-15T10:00:00Z", "", "")
	badRecord = strings.Replace(badRecord, `"escrow_id":1`, `"escrow_id":0`, 1)
	if status := realMain([]string{"report", "--date", "2026-11-15"}, strings.NewReader(badRecord), &stdout, &stderr); status != 2 {
		t.Fatalf("verification failure exit status = %d, want 2", status)
	}
	if !strings.Contains(stderr.String(), ErrVerification.Error()) {
		t.Fatalf("stderr missing verification error: %q", stderr.String())
	}

	stdout.Reset()
	stderr.Reset()
	goodRecord := settlementJSON(1, hashOf("88"), "10.00", "USD", "2026-11-15T10:00:00Z", "", "")
	if status := realMain([]string{"report", "--date", "2026-11-15"}, strings.NewReader(goodRecord), &stdout, &stderr); status != 0 {
		t.Fatalf("successful exit status = %d, want 0 (stderr: %s)", status, stderr.String())
	}
}

func TestDecodeSettlements(t *testing.T) {
	t.Run("json array", func(t *testing.T) {
		input := "[" + settlementJSON(1, hashOf("99"), "10.00", "USD", "2026-11-15T10:00:00Z", "", "") + "]"
		records, err := decodeSettlements([]byte(input))
		if err != nil {
			t.Fatalf("decodeSettlements: %v", err)
		}
		if len(records) != 1 || records[0].EscrowID != 1 {
			t.Fatalf("unexpected records: %+v", records)
		}
	})

	t.Run("jsonl with blank lines", func(t *testing.T) {
		input := settlementJSON(1, hashOf("99"), "10.00", "USD", "2026-11-15T10:00:00Z", "", "") + "\n\n" +
			settlementJSON(2, hashOf("98"), "20.00", "USD", "2026-11-15T11:00:00Z", "", "") + "\n"
		records, err := decodeSettlements([]byte(input))
		if err != nil {
			t.Fatalf("decodeSettlements: %v", err)
		}
		if len(records) != 2 {
			t.Fatalf("got %d records, want 2", len(records))
		}
	})

	t.Run("numeric amounts", func(t *testing.T) {
		input := `{"escrow_id":1,"payer":"GPAYER","beneficiary":"GBEN","token":"XLM","fiat_amount":10.5,"fiat_currency":"USD","tx_hash":"` + hashOf("99") + `","confirmed_at":"2026-11-15T10:00:00Z","token_amount":2,"fiat_rate":5.25}`
		records, err := decodeSettlements([]byte(input))
		if err != nil {
			t.Fatalf("decodeSettlements: %v", err)
		}
		if len(records) != 1 || string(records[0].FiatAmount) != "10.5" {
			t.Fatalf("unexpected records: %+v", records)
		}
	})

	t.Run("empty", func(t *testing.T) {
		records, err := decodeSettlements([]byte("   \n"))
		if err != nil {
			t.Fatalf("decodeSettlements: %v", err)
		}
		if len(records) != 0 {
			t.Fatalf("got %d records, want 0", len(records))
		}
	})

	t.Run("malformed", func(t *testing.T) {
		if _, err := decodeSettlements([]byte(`{"escrow_id":`)); err == nil {
			t.Fatal("expected an error for malformed JSON")
		}
	})
}

func TestDecimalHelpers(t *testing.T) {
	tests := []struct {
		input     string
		want      string
		wantError bool
	}{
		{input: "0012.50", want: "12.50"},
		{input: "0.005", want: "0.005"},
		{input: "0", want: "0"},
		{input: "", wantError: true},
		{input: "-1", wantError: true},
		{input: "1e5", wantError: true},
		{input: "1,000", wantError: true},
		{input: "1.1234567890123", wantError: true},
	}
	for _, tt := range tests {
		_, canonical, err := parseDecimal("amount", tt.input)
		if tt.wantError {
			if err == nil {
				t.Errorf("parseDecimal(%q): expected an error", tt.input)
			}
			continue
		}
		if err != nil {
			t.Errorf("parseDecimal(%q): %v", tt.input, err)
			continue
		}
		if canonical != tt.want {
			t.Errorf("parseDecimal(%q) canonical = %q, want %q", tt.input, canonical, tt.want)
		}
	}

	if got := formatRat(big.NewRat(1, 4)); got != "0.25" {
		t.Errorf("formatRat(1/4) = %q, want 0.25", got)
	}
	if got := formatRat(new(big.Rat).SetInt64(7)); got != "7" {
		t.Errorf("formatRat(7) = %q, want 7", got)
	}
	if got := formatRat(nil); got != "0" {
		t.Errorf("formatRat(nil) = %q, want 0", got)
	}
}

func TestReportWriteErrors(t *testing.T) {
	report := &Report{Date: time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)}
	failing := failingWriter{}
	if err := report.WriteCSV(failing); err == nil {
		t.Fatal("expected a CSV write error")
	}
	if err := report.WriteJSON(failing); err == nil {
		t.Fatal("expected a JSON write error")
	}
	if err := report.WriteSummary(failing); err == nil {
		t.Fatal("expected a summary write error")
	}

	var nilReport *Report
	if err := nilReport.WriteCSV(io.Discard); err == nil {
		t.Fatal("expected an error writing a nil report")
	}
	if err := nilReport.WriteJSON(io.Discard); err == nil {
		t.Fatal("expected an error writing a nil report")
	}
}

// failingWriter fails every write.
type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) {
	return 0, errors.New("write failed")
}
