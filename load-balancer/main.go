package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

const maxRequestBytes = 1 << 20

type chargerRequest struct {
	ChargerID        string  `json:"chargerId"`
	RequestedPowerKw float64 `json:"requestedPowerKw"`
	MaxPowerKw       float64 `json:"maxPowerKw"`
}

type allocationRequest struct {
	SitePowerLimitKw float64          `json:"sitePowerLimitKw"`
	ActiveChargers   []chargerRequest `json:"activeChargers"`
}

type chargerAllocation struct {
	ChargerID        string  `json:"chargerId"`
	AllocatedPowerKw float64 `json:"allocatedPowerKw"`
}

type allocationResponse struct {
	SitePowerLimitKw      float64             `json:"sitePowerLimitKw"`
	TotalAllocatedPowerKw float64             `json:"totalAllocatedPowerKw"`
	Allocations           []chargerAllocation `json:"allocations"`
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)
	mux.HandleFunc("/v1/allocate", allocateHandler)

	address := os.Getenv("LOAD_BALANCER_ADDR")
	if address == "" {
		address = ":8787"
	}

	server := &http.Server{
		Addr:              address,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}

	stop, stopSignal := signal.NotifyContext(
		context.Background(),
		os.Interrupt,
		syscall.SIGTERM,
	)
	defer stopSignal()

	serverErrors := make(chan error, 1)
	go func() {
		log.Printf("VoltGrid load balancer listening on %s", address)
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case <-stop.Done():
		shutdownContext, cancel := context.WithTimeout(
			context.Background(),
			5*time.Second,
		)
		defer cancel()

		if err := server.Shutdown(shutdownContext); err != nil {
			log.Printf("load balancer shutdown error: %v", err)
		}
	case err := <-serverErrors:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}
}

func healthHandler(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeError(response, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	writeJSON(response, http.StatusOK, map[string]string{
		"service": "load-balancer",
		"status":  "ok",
	})
}

func allocateHandler(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeError(response, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	request.Body = http.MaxBytesReader(response, request.Body, maxRequestBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()

	var input allocationRequest
	if err := decoder.Decode(&input); err != nil {
		writeError(response, http.StatusBadRequest, "invalid JSON request")
		return
	}

	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		writeError(response, http.StatusBadRequest, "request must contain one JSON object")
		return
	}

	allocations, total, err := allocate(input)
	if err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}

	writeJSON(response, http.StatusOK, allocationResponse{
		SitePowerLimitKw:      input.SitePowerLimitKw,
		TotalAllocatedPowerKw: total,
		Allocations:           allocations,
	})
}

func allocate(input allocationRequest) ([]chargerAllocation, float64, error) {
	if !isFiniteNonNegative(input.SitePowerLimitKw) {
		return nil, 0, errors.New("sitePowerLimitKw must be a finite non-negative number")
	}

	if len(input.ActiveChargers) > 1000 {
		return nil, 0, errors.New("activeChargers cannot contain more than 1000 chargers")
	}

	demands := make([]float64, len(input.ActiveChargers))
	allocations := make([]chargerAllocation, len(input.ActiveChargers))
	pending := make([]int, 0, len(input.ActiveChargers))
	seen := make(map[string]struct{}, len(input.ActiveChargers))

	for index, charger := range input.ActiveChargers {
		chargerID := strings.TrimSpace(charger.ChargerID)
		if chargerID == "" {
			return nil, 0, errors.New("chargerId cannot be empty")
		}

		if _, exists := seen[chargerID]; exists {
			return nil, 0, errors.New("chargerId values must be unique")
		}
		seen[chargerID] = struct{}{}

		if !isFiniteNonNegative(charger.RequestedPowerKw) ||
			!isFiniteNonNegative(charger.MaxPowerKw) {
			return nil, 0, errors.New("charger power values must be finite and non-negative")
		}

		demands[index] = math.Min(charger.RequestedPowerKw, charger.MaxPowerKw)
		allocations[index].ChargerID = chargerID
		if demands[index] > 0 {
			pending = append(pending, index)
		}
	}

	remainingPower := input.SitePowerLimitKw
	const epsilon = 1e-9

	// ponytail: water-filling is O(n²); sort demands only when real site sizes make it measurable.
	for len(pending) > 0 && remainingPower > epsilon {
		share := remainingPower / float64(len(pending))
		nextPending := make([]int, 0, len(pending))
		usedPower := 0.0

		for _, index := range pending {
			power := math.Min(demands[index], share)
			allocations[index].AllocatedPowerKw += power
			demands[index] -= power
			usedPower += power

			if demands[index] > epsilon {
				nextPending = append(nextPending, index)
			}
		}

		remainingPower -= usedPower
		pending = nextPending
	}

	total := 0.0
	for _, allocation := range allocations {
		total += allocation.AllocatedPowerKw
	}

	if total > input.SitePowerLimitKw {
		scale := input.SitePowerLimitKw / total
		for index := range allocations {
			allocations[index].AllocatedPowerKw *= scale
		}
		total = input.SitePowerLimitKw
	}

	return allocations, total, nil
}

func isFiniteNonNegative(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func writeError(response http.ResponseWriter, status int, message string) {
	writeJSON(response, status, map[string]string{"error": message})
}
