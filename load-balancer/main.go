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
	Policy           string           `json:"policy,omitempty"`
}

type chargerAllocation struct {
	ChargerID        string  `json:"chargerId"`
	RequestedPowerKw float64 `json:"requestedPowerKw"`
	AllocatedPowerKw float64 `json:"allocatedPowerKw"`
	DemandSharePct   float64 `json:"demandSharePct"`
	UnmetPowerKw     float64 `json:"unmetPowerKw"`
	Reason           string  `json:"reason"`
}

type allocationResponse struct {
	Policy                string              `json:"policy"`
	SitePowerLimitKw      float64             `json:"sitePowerLimitKw"`
	TotalRequestedPowerKw float64             `json:"totalRequestedPowerKw"`
	TotalAllocatedPowerKw float64             `json:"totalAllocatedPowerKw"`
	Allocations           []chargerAllocation `json:"allocations"`
}

const (
	policyFCFS           = "fcfs"
	policyEqualShare     = "equal-share"
	policyDemandWeighted = "demand-weighted"
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)
	mux.HandleFunc("/v1/allocate", allocateHandler)
	mux.HandleFunc("/v1/compare", compareHandler)

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

	policy, _ := normalizePolicy(input.Policy)
	totalRequested := 0.0
	for _, allocation := range allocations {
		totalRequested += allocation.RequestedPowerKw
	}

	writeJSON(response, http.StatusOK, allocationResponse{
		Policy:                policy,
		SitePowerLimitKw:      input.SitePowerLimitKw,
		TotalRequestedPowerKw: totalRequested,
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

	policy, err := normalizePolicy(input.Policy)
	if err != nil {
		return nil, 0, err
	}

	demands := make([]float64, len(input.ActiveChargers))
	allocations := make([]chargerAllocation, len(input.ActiveChargers))
	seen := make(map[string]struct{}, len(input.ActiveChargers))
	totalDemand := 0.0

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
		totalDemand += demands[index]
		allocations[index] = chargerAllocation{
			ChargerID:        chargerID,
			RequestedPowerKw: demands[index],
		}
	}

	switch policy {
	case policyFCFS:
		remainingPower := input.SitePowerLimitKw
		for index, demand := range demands {
			allocations[index].AllocatedPowerKw = math.Min(demand, remainingPower)
			remainingPower -= allocations[index].AllocatedPowerKw
		}
	case policyEqualShare:
		allocateEqualShare(input.SitePowerLimitKw, demands, allocations)
	case policyDemandWeighted:
		for index, demand := range demands {
			if totalDemand <= input.SitePowerLimitKw {
				allocations[index].AllocatedPowerKw = demand
				continue
			}
			allocations[index].AllocatedPowerKw =
				input.SitePowerLimitKw * demand / totalDemand
		}
	}

	total := 0.0
	for index := range allocations {
		allocation := &allocations[index]
		if totalDemand > 0 {
			allocation.DemandSharePct = (allocation.RequestedPowerKw / totalDemand) * 100
		}
		allocation.UnmetPowerKw = math.Max(0, allocation.RequestedPowerKw-allocation.AllocatedPowerKw)
		allocation.Reason = liveAllocationReason(
			policy,
			allocation.AllocatedPowerKw,
			allocation.RequestedPowerKw,
			input.SitePowerLimitKw,
		)
		total += allocation.AllocatedPowerKw
	}

	if total > input.SitePowerLimitKw {
		scale := input.SitePowerLimitKw / total
		for index := range allocations {
			allocations[index].AllocatedPowerKw *= scale
			allocations[index].UnmetPowerKw = math.Max(
				0,
				allocations[index].RequestedPowerKw-allocations[index].AllocatedPowerKw,
			)
		}
		total = input.SitePowerLimitKw
	}

	return allocations, total, nil
}

func normalizePolicy(policy string) (string, error) {
	policy = strings.TrimSpace(policy)
	if policy == "" {
		return policyDemandWeighted, nil
	}

	switch policy {
	case policyFCFS, policyEqualShare, policyDemandWeighted:
		return policy, nil
	default:
		return "", errors.New("unsupported allocation policy: " + policy)
	}
}

func allocateEqualShare(
	capacity float64,
	demands []float64,
	allocations []chargerAllocation,
) {
	pending := make([]int, 0, len(demands))
	for index, demand := range demands {
		if demand > 0 {
			pending = append(pending, index)
		}
	}

	remaining := capacity
	const epsilon = 1e-9
	for len(pending) > 0 && remaining > epsilon {
		share := remaining / float64(len(pending))
		nextPending := make([]int, 0, len(pending))
		used := 0.0

		for _, index := range pending {
			power := math.Min(
				demands[index]-allocations[index].AllocatedPowerKw,
				share,
			)
			allocations[index].AllocatedPowerKw += power
			used += power
			if demands[index]-allocations[index].AllocatedPowerKw > epsilon {
				nextPending = append(nextPending, index)
			}
		}

		if used <= epsilon {
			return
		}
		remaining -= used
		pending = nextPending
	}
}

func liveAllocationReason(policy string, allocated, requested, capacity float64) string {
	if requested <= 0 {
		return "No charging demand was requested."
	}
	if allocated+1e-9 >= requested {
		return "Full requested power is available at the station."
	}
	switch policy {
	case policyFCFS:
		return "Earlier vehicles consumed the remaining station capacity."
	case policyEqualShare:
		return "Available power is shared equally among active vehicles."
	default:
		if capacity <= 0 {
			return "The station has no available power."
		}
		return "Power is weighted by this vehicle's share of total demand."
	}
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
