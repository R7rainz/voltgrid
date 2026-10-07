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
	ChargerID          string  `json:"chargerId"`
	RequestedPowerKw   float64 `json:"requestedPowerKw"`
	MaxPowerKw         float64 `json:"maxPowerKw"`
	FeederID           string  `json:"feederId,omitempty"`
	EnergyRequiredKwh  float64 `json:"energyRequiredKwh,omitempty"`
	EnergyDeliveredKwh float64 `json:"energyDeliveredKwh,omitempty"`
	DepartureAt        string  `json:"departureAt,omitempty"`
	Priority           float64 `json:"priority,omitempty"`
}

type feederLimit struct {
	FeederID     string  `json:"feederId"`
	PowerLimitKw float64 `json:"powerLimitKw"`
}

type allocationRequest struct {
	SitePowerLimitKw float64          `json:"sitePowerLimitKw"`
	ActiveChargers   []chargerRequest `json:"activeChargers"`
	Policy           string           `json:"policy,omitempty"`
	FeederLimits     []feederLimit    `json:"feederLimits,omitempty"`
}

type feederAllocation struct {
	FeederID         string  `json:"feederId"`
	PowerLimitKw     float64 `json:"powerLimitKw"`
	RequestedPowerKw float64 `json:"requestedPowerKw"`
	AllocatedPowerKw float64 `json:"allocatedPowerKw"`
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
	EffectivePowerLimitKw float64             `json:"effectivePowerLimitKw"`
	ConstraintPath        string              `json:"constraintPath"`
	Feeders               []feederAllocation  `json:"feeders"`
}

const (
	policyFCFS           = "fcfs"
	policyEqualShare     = "equal-share"
	policyDemandWeighted = "demand-weighted"
	policyDeadlineAware  = "deadline-aware"
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
	effectiveLimit, feeders := treeSummary(input, allocations)

	writeJSON(response, http.StatusOK, allocationResponse{
		Policy:                policy,
		SitePowerLimitKw:      input.SitePowerLimitKw,
		TotalRequestedPowerKw: totalRequested,
		TotalAllocatedPowerKw: total,
		Allocations:           allocations,
		EffectivePowerLimitKw: effectiveLimit,
		ConstraintPath:        "site → feeder → charger",
		Feeders:               feeders,
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
	if err := validateFeederLimits(input.FeederLimits); err != nil {
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
		if !isFiniteNonNegative(charger.EnergyRequiredKwh) ||
			!isFiniteNonNegative(charger.EnergyDeliveredKwh) ||
			!isFiniteNonNegative(charger.Priority) {
			return nil, 0, errors.New("charger energy and priority values must be finite and non-negative")
		}
		if charger.DepartureAt != "" {
			if _, err := time.Parse(time.RFC3339, charger.DepartureAt); err != nil {
				return nil, 0, errors.New("departureAt must be an RFC3339 timestamp")
			}
		}

		demands[index] = math.Min(charger.RequestedPowerKw, charger.MaxPowerKw)
		totalDemand += demands[index]
		allocations[index] = chargerAllocation{
			ChargerID:        chargerID,
			RequestedPowerKw: demands[index],
		}
	}

	effectiveLimit, feederCapacities := treeCapacity(input)
	feederIndexes := groupByFeeder(input.ActiveChargers)
	feederDemands := make([]float64, 0, len(feederIndexes))
	feederLimits := make([]float64, 0, len(feederIndexes))
	for _, feederID := range feederIndexes {
		requested := 0.0
		for index, charger := range input.ActiveChargers {
			if normalizedFeederID(charger.FeederID) == feederID {
				requested += demands[index]
			}
		}
		feederDemands = append(feederDemands, requested)
		feederLimits = append(feederLimits, feederCapacities[feederID])
	}
	feederAllocations := make([]float64, len(feederIndexes))
	allocateTreeChildren(effectiveLimit, feederDemands, feederLimits, feederAllocations)

	for feederIndex, feederID := range feederIndexes {
		indexes := make([]int, 0)
		for index, charger := range input.ActiveChargers {
			if normalizedFeederID(charger.FeederID) == feederID {
				indexes = append(indexes, index)
			}
		}
		allocatePolicy(feederAllocations[feederIndex], indexes, demands, input.ActiveChargers, allocations, policy)
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

	if total > effectiveLimit {
		scale := effectiveLimit / total
		for index := range allocations {
			allocations[index].AllocatedPowerKw *= scale
			allocations[index].UnmetPowerKw = math.Max(
				0,
				allocations[index].RequestedPowerKw-allocations[index].AllocatedPowerKw,
			)
		}
		total = effectiveLimit
	}

	return allocations, total, nil
}

func normalizePolicy(policy string) (string, error) {
	policy = strings.TrimSpace(policy)
	if policy == "" {
		return policyDemandWeighted, nil
	}

	switch policy {
	case policyFCFS, policyEqualShare, policyDemandWeighted, policyDeadlineAware:
		return policy, nil
	default:
		return "", errors.New("unsupported allocation policy: " + policy)
	}
}

func normalizedFeederID(feederID string) string {
	feederID = strings.TrimSpace(feederID)
	if feederID == "" {
		return "main-feeder"
	}
	return feederID
}

func groupByFeeder(chargers []chargerRequest) []string {
	groups := make([]string, 0)
	seen := make(map[string]struct{})
	for _, charger := range chargers {
		feederID := normalizedFeederID(charger.FeederID)
		if _, ok := seen[feederID]; ok {
			continue
		}
		seen[feederID] = struct{}{}
		groups = append(groups, feederID)
	}
	return groups
}

func treeCapacity(input allocationRequest) (float64, map[string]float64) {
	limits := make(map[string]float64)
	for _, feeder := range input.FeederLimits {
		limits[normalizedFeederID(feeder.FeederID)] = feeder.PowerLimitKw
	}
	for _, feederID := range groupByFeeder(input.ActiveChargers) {
		if _, exists := limits[feederID]; !exists {
			limits[feederID] = input.SitePowerLimitKw
		}
	}
	return input.SitePowerLimitKw, limits
}

func validateFeederLimits(feeders []feederLimit) error {
	seen := make(map[string]struct{}, len(feeders))
	for _, feeder := range feeders {
		feederID := normalizedFeederID(feeder.FeederID)
		if _, exists := seen[feederID]; exists {
			return errors.New("feederId values must be unique")
		}
		if !isFiniteNonNegative(feeder.PowerLimitKw) {
			return errors.New("feeder power limits must be finite and non-negative")
		}
		seen[feederID] = struct{}{}
	}
	return nil
}

func allocateTreeChildren(capacity float64, demands, limits, result []float64) {
	capped := make([]float64, len(demands))
	for index := range demands {
		capped[index] = math.Min(demands[index], limits[index])
	}
	pending := make([]int, 0, len(demands))
	for index, demand := range capped {
		if demand > 0 {
			pending = append(pending, index)
		}
	}
	remaining := capacity
	const epsilon = 1e-9
	for len(pending) > 0 && remaining > epsilon {
		share := remaining / float64(len(pending))
		next := make([]int, 0, len(pending))
		used := 0.0
		for _, index := range pending {
			power := math.Min(capped[index]-result[index], share)
			result[index] += power
			used += power
			if capped[index]-result[index] > epsilon {
				next = append(next, index)
			}
		}
		if used <= epsilon {
			return
		}
		remaining -= used
		pending = next
	}
}

func allocatePolicy(capacity float64, indexes []int, demands []float64, chargers []chargerRequest, allocations []chargerAllocation, policy string) {
	switch policy {
	case policyFCFS:
		remaining := capacity
		for _, index := range indexes {
			allocations[index].AllocatedPowerKw = math.Min(demands[index], remaining)
			remaining -= allocations[index].AllocatedPowerKw
		}
	case policyEqualShare:
		allocateEqualShareForIndexes(capacity, indexes, demands, allocations)
	case policyDeadlineAware:
		weights := make(map[int]float64, len(indexes))
		for _, index := range indexes {
			weights[index] = deadlineWeight(chargers[index], demands[index])
		}
		allocateWeightedForIndexes(capacity, indexes, demands, weights, allocations)
	default:
		totalDemand := 0.0
		for _, index := range indexes {
			totalDemand += demands[index]
		}
		for _, index := range indexes {
			if totalDemand <= capacity {
				allocations[index].AllocatedPowerKw = demands[index]
			} else if totalDemand > 0 {
				allocations[index].AllocatedPowerKw = capacity * demands[index] / totalDemand
			}
		}
	}
}

func allocateEqualShareForIndexes(capacity float64, indexes []int, demands []float64, allocations []chargerAllocation) {
	pending := append([]int(nil), indexes...)
	remaining := capacity
	const epsilon = 1e-9
	for len(pending) > 0 && remaining > epsilon {
		share := remaining / float64(len(pending))
		next := make([]int, 0, len(pending))
		used := 0.0
		for _, index := range pending {
			power := math.Min(demands[index]-allocations[index].AllocatedPowerKw, share)
			allocations[index].AllocatedPowerKw += power
			used += power
			if demands[index]-allocations[index].AllocatedPowerKw > epsilon {
				next = append(next, index)
			}
		}
		if used <= epsilon {
			return
		}
		remaining -= used
		pending = next
	}
}

func allocateWeightedForIndexes(capacity float64, indexes []int, demands []float64, weights map[int]float64, allocations []chargerAllocation) {
	totalWeight := 0.0
	for _, index := range indexes {
		totalWeight += math.Max(1, weights[index])
	}
	totalDemand := 0.0
	for _, index := range indexes {
		totalDemand += demands[index]
	}
	if totalDemand <= capacity {
		for _, index := range indexes {
			allocations[index].AllocatedPowerKw = demands[index]
		}
		return
	}
	for _, index := range indexes {
		allocations[index].AllocatedPowerKw = math.Min(
			demands[index],
			capacity*math.Max(1, weights[index])/totalWeight,
		)
	}
}

func deadlineWeight(charger chargerRequest, demand float64) float64 {
	weight := 1 + charger.Priority
	remainingEnergy := math.Max(0, charger.EnergyRequiredKwh-charger.EnergyDeliveredKwh)
	if remainingEnergy <= 0 || demand <= 0 || charger.DepartureAt == "" {
		return weight
	}
	departure, err := time.Parse(time.RFC3339, charger.DepartureAt)
	if err != nil {
		return weight
	}
	hoursRemaining := math.Max(departure.Sub(time.Now()).Hours(), 1.0/60.0)
	requiredPower := remainingEnergy / hoursRemaining
	return weight + math.Min(5, requiredPower/math.Max(demand, 1e-9))
}

func treeSummary(input allocationRequest, allocations []chargerAllocation) (float64, []feederAllocation) {
	demands := make(map[string]float64)
	allocated := make(map[string]float64)
	for index, charger := range input.ActiveChargers {
		feederID := normalizedFeederID(charger.FeederID)
		demands[feederID] += allocations[index].RequestedPowerKw
		allocated[feederID] += allocations[index].AllocatedPowerKw
	}
	limits := make(map[string]float64)
	for _, feeder := range input.FeederLimits {
		limits[normalizedFeederID(feeder.FeederID)] = feeder.PowerLimitKw
	}
	rows := make([]feederAllocation, 0, len(demands))
	effective := input.SitePowerLimitKw
	limitTotal := 0.0
	for _, feederID := range groupByFeeder(input.ActiveChargers) {
		requested := demands[feederID]
		limit, exists := limits[feederID]
		if !exists {
			limit = input.SitePowerLimitKw
		}
		limitTotal += limit
		rows = append(rows, feederAllocation{
			FeederID:         feederID,
			PowerLimitKw:     limit,
			RequestedPowerKw: requested,
			AllocatedPowerKw: allocated[feederID],
		})
	}
	if len(rows) > 0 {
		effective = math.Min(effective, limitTotal)
	}
	return effective, rows
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
	case policyDeadlineAware:
		if capacity <= 0 {
			return "The station has no available power."
		}
		return "Weighted by remaining energy, departure time, and vehicle priority."
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
