package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCheckHealth(t *testing.T) {
	okServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer okServer.Close()

	if err := checkHealth(okServer.URL + "/health"); err != nil {
		t.Fatalf("expected healthy endpoint to pass, got error: %v", err)
	}

	failServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer failServer.Close()

	if err := checkHealth(failServer.URL + "/health"); err == nil {
		t.Fatal("expected 503 endpoint to return an error")
	}

	if err := checkHealth("http://127.0.0.1:1/health"); err == nil {
		t.Fatal("expected unreachable endpoint to return an error")
	}
}
