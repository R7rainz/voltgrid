package main

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"sort"
	"strings"
)

type simulationVehicle struct {
	VehicleID          string  `json:"vehicleId"`
	ArrivalStep        int     `json:"arrivalStep"`
	DepartureStep      int     `json:"departureStep"`
	EnergyRequiredKwh  float64 `json:"energyRequiredKwh"`
	MaxPowerKw         float64 `json:"maxPowerKw"`
	Priority           float64 `json:"priority"`
	BatteryCapacityKwh float64 `json:"batteryCapacityKwh"`
	InitialSocPct      float64 `json:"initialSocPct"`
	TargetSocPct       float64 `json:"targetSocPct"`
}

type compareRequest struct {
	SitePowerLimitKw       float64             `json:"sitePowerLimitKw"`
	TimeStepMinutes        float64             `json:"timeStepMinutes"`
	BuildingLoadKw         []float64           `json:"buildingLoadKw"`
	SolarGenerationKw      []float64           `json:"solarGenerationKw"`
	TariffPaisePerKwh      []float64           `json:"tariffPaisePerKwh"`
	DemandChargePaisePerKw float64             `json:"demandChargePaisePerKw"`
	Vehicles               []simulationVehicle `json:"vehicles"`
	Policies               []string            `json:"policies"`
}

type policyResult struct {
	PolicyID    string            `json:"policyId"`
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Metrics     simulationMetrics `json:"metrics"`
	Steps       []simulationStep  `json:"steps"`
	Vehicles    []vehicleResult   `json:"vehicles"`
}

type compareResponse struct {
	SitePowerLimitKw float64        `json:"sitePowerLimitKw"`
	TimeStepMinutes  float64        `json:"timeStepMinutes"`
	Policies         []policyResult `json:"policies"`
	Constraint       string         `json:"constraint"`
	CostsAreModeled  bool           `json:"costsAreModeled"`
}

type simulationMetrics struct {
	TotalEnergyDeliveredKwh float64 `json:"totalEnergyDeliveredKwh"`
	TotalEnergyShortfallKwh float64 `json:"totalEnergyShortfallKwh"`
	MissedDeadlines         int     `json:"missedDeadlines"`
	PeakSiteImportKw        float64 `json:"peakSiteImportKw"`
	TransformerUtilization  float64 `json:"transformerUtilization"`
	EnergyCostPaise         float64 `json:"energyCostPaise"`
	DemandCostPaise         float64 `json:"demandCostPaise"`
	TotalCostPaise          float64 `json:"totalCostPaise"`
	DeliveryFairness        float64 `json:"deliveryFairness"`
	AllocationChanges       int     `json:"allocationChanges"`
}

type simulationStep struct {
	Step                int                 `json:"step"`
	BuildingLoadKw      float64             `json:"buildingLoadKw"`
	SolarGenerationKw   float64             `json:"solarGenerationKw"`
	AvailableEvPowerKw  float64             `json:"availableEvPowerKw"`
	TotalEvAllocationKw float64             `json:"totalEvAllocationKw"`
	SiteImportKw        float64             `json:"siteImportKw"`
	TariffPaisePerKwh   float64             `json:"tariffPaisePerKwh"`
	Allocations         []vehicleAllocation `json:"allocations"`
}

type vehicleAllocation struct {
	VehicleID        string  `json:"vehicleId"`
	RequestedPowerKw float64 `json:"requestedPowerKw"`
	AllocatedPowerKw float64 `json:"allocatedPowerKw"`
	Reason           string  `json:"reason"`
}

type vehicleResult struct {
	VehicleID          string  `json:"vehicleId"`
	EnergyRequiredKwh  float64 `json:"energyRequiredKwh"`
	EnergyDeliveredKwh float64 `json:"energyDeliveredKwh"`
	EnergyShortfallKwh float64 `json:"energyShortfallKwh"`
	MissedDeadline     bool    `json:"missedDeadline"`
	FinalSocPct        float64 `json:"finalSocPct,omitempty"`
}

type policyDefinition struct {
	ID          string
	Name        string
	Description string
}

var supportedPolicies = []policyDefinition{
	{ID: "fcfs", Name: "First-come first-served", Description: "Fills requests in arrival order until the site capacity is used."},
	{ID: "equal-share", Name: "Equal-share water-filling", Description: "Shares available EV power fairly and caps low-demand vehicles."},
	{ID: "demand-weighted", Name: "Demand-weighted sharing", Description: "Gives each vehicle a share proportional to its effective power requirement."},
	{ID: "deadline-aware", Name: "Deadline-aware weighted sharing", Description: "Weights vehicles by energy deficit, departure urgency, and priority."},
}

func compareHandler(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeError(response, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	request.Body = http.MaxBytesReader(response, request.Body, maxRequestBytes)
	decoder := jsonDecoder(request.Body)

	var input compareRequest
	if err := decoder.Decode(&input); err != nil {
		writeError(response, http.StatusBadRequest, "invalid JSON request")
		return
	}

	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		writeError(response, http.StatusBadRequest, "request must contain one JSON object")
		return
	}

	result, err := compare(input)
	if err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}

	writeJSON(response, http.StatusOK, result)
}

func jsonDecoder(reader io.Reader) *json.Decoder {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	return decoder
}

func compare(input compareRequest) (compareResponse, error) {
	horizon, solar, tariff, err := validateCompareInput(input)
	if err != nil {
		return compareResponse{}, err
	}
	normalizeVehicleEnergy(input.Vehicles)

	requestedPolicies := input.Policies
	if len(requestedPolicies) == 0 {
		requestedPolicies = []string{"fcfs", "equal-share", "demand-weighted", "deadline-aware"}
	}

	definitions := make([]policyDefinition, 0, len(requestedPolicies))
	seen := make(map[string]struct{}, len(requestedPolicies))
	for _, policyID := range requestedPolicies {
		policyID = strings.TrimSpace(policyID)
		if _, exists := seen[policyID]; exists {
			return compareResponse{}, errors.New("policies must be unique")
		}
		seen[policyID] = struct{}{}

		definition, ok := policyByID(policyID)
		if !ok {
			return compareResponse{}, errors.New("unsupported policy: " + policyID)
		}
		definitions = append(definitions, definition)
	}

	results := make([]policyResult, 0, len(definitions))
	for _, definition := range definitions {
		results = append(results, runPolicy(input, horizon, solar, tariff, definition))
	}

	return compareResponse{
		SitePowerLimitKw: input.SitePowerLimitKw,
		TimeStepMinutes:  input.TimeStepMinutes,
		Policies:         results,
		Constraint:       "building load + EV allocation - solar generation <= site import limit",
		CostsAreModeled:  true,
	}, nil
}

func normalizeVehicleEnergy(vehicles []simulationVehicle) {
	for index := range vehicles {
		vehicle := &vehicles[index]
		if vehicle.EnergyRequiredKwh == 0 && vehicle.BatteryCapacityKwh > 0 {
			vehicle.EnergyRequiredKwh = vehicle.BatteryCapacityKwh *
				(vehicle.TargetSocPct - vehicle.InitialSocPct) / 100
		}
	}
}

func validateCompareInput(input compareRequest) (int, []float64, []float64, error) {
	if !isFiniteNonNegative(input.SitePowerLimitKw) || input.SitePowerLimitKw == 0 {
		return 0, nil, nil, errors.New("sitePowerLimitKw must be a finite positive number")
	}
	if !isFinitePositive(input.TimeStepMinutes) {
		return 0, nil, nil, errors.New("timeStepMinutes must be a finite positive number")
	}
	if len(input.BuildingLoadKw) == 0 || len(input.BuildingLoadKw) > 288 {
		return 0, nil, nil, errors.New("buildingLoadKw must contain between 1 and 288 time steps")
	}
	if len(input.Vehicles) == 0 || len(input.Vehicles) > 100 {
		return 0, nil, nil, errors.New("vehicles must contain between 1 and 100 vehicles")
	}

	horizon := len(input.BuildingLoadKw)
	solar := make([]float64, horizon)
	tariff := make([]float64, horizon)
	if len(input.SolarGenerationKw) > 0 {
		if len(input.SolarGenerationKw) != horizon {
			return 0, nil, nil, errors.New("solarGenerationKw must match buildingLoadKw length")
		}
		copy(solar, input.SolarGenerationKw)
	}
	if len(input.TariffPaisePerKwh) > 0 {
		if len(input.TariffPaisePerKwh) != horizon {
			return 0, nil, nil, errors.New("tariffPaisePerKwh must match buildingLoadKw length")
		}
		copy(tariff, input.TariffPaisePerKwh)
	}
	if !isFiniteNonNegative(input.DemandChargePaisePerKw) {
		return 0, nil, nil, errors.New("demandChargePaisePerKw must be finite and non-negative")
	}

	seen := make(map[string]struct{}, len(input.Vehicles))
	for _, vehicle := range input.Vehicles {
		vehicleID := strings.TrimSpace(vehicle.VehicleID)
		if vehicleID == "" {
			return 0, nil, nil, errors.New("vehicleId cannot be empty")
		}
		if _, exists := seen[vehicleID]; exists {
			return 0, nil, nil, errors.New("vehicleId values must be unique")
		}
		seen[vehicleID] = struct{}{}
		if vehicle.ArrivalStep < 0 || vehicle.DepartureStep <= vehicle.ArrivalStep ||
			vehicle.DepartureStep > horizon {
			return 0, nil, nil, errors.New("vehicle arrival and departure steps must fit the horizon")
		}
		if !isFiniteNonNegative(vehicle.EnergyRequiredKwh) ||
			!isFinitePositive(vehicle.MaxPowerKw) ||
			!isFiniteNonNegative(vehicle.Priority) {
			return 0, nil, nil, errors.New("vehicle energy, power, and priority values are invalid")
		}
		if !isFiniteNonNegative(vehicle.BatteryCapacityKwh) ||
			!isFiniteNonNegative(vehicle.InitialSocPct) ||
			!isFiniteNonNegative(vehicle.TargetSocPct) ||
			vehicle.InitialSocPct > 100 ||
			vehicle.TargetSocPct > 100 ||
			vehicle.TargetSocPct < vehicle.InitialSocPct {
			return 0, nil, nil, errors.New("vehicle battery and state-of-charge values are invalid")
		}
		if vehicle.BatteryCapacityKwh > 0 {
			socEnergy := vehicle.BatteryCapacityKwh *
				(vehicle.TargetSocPct - vehicle.InitialSocPct) / 100
			if vehicle.EnergyRequiredKwh == 0 {
				vehicle.EnergyRequiredKwh = socEnergy
			}
			if vehicle.EnergyRequiredKwh > vehicle.BatteryCapacityKwh*
				(100-vehicle.InitialSocPct)/100+1e-9 {
				return 0, nil, nil, errors.New("vehicle energy exceeds available battery capacity")
			}
		}
	}

	for index, buildingLoad := range input.BuildingLoadKw {
		if !isFiniteNonNegative(buildingLoad) || !isFiniteNonNegative(solar[index]) ||
			!isFiniteNonNegative(tariff[index]) {
			return 0, nil, nil, errors.New("load, solar, and tariff values must be finite and non-negative")
		}
		if math.Max(0, buildingLoad-solar[index]) > input.SitePowerLimitKw+1e-9 {
			return 0, nil, nil, errors.New("base load already exceeds the site power limit")
		}
	}

	return horizon, solar, tariff, nil
}

func policyByID(policyID string) (policyDefinition, bool) {
	for _, definition := range supportedPolicies {
		if definition.ID == policyID {
			return definition, true
		}
	}
	return policyDefinition{}, false
}

func runPolicy(input compareRequest, horizon int, solar, tariff []float64, definition policyDefinition) policyResult {
	stepHours := input.TimeStepMinutes / 60
	delivered := make([]float64, len(input.Vehicles))
	previousAllocation := make([]float64, len(input.Vehicles))
	steps := make([]simulationStep, 0, horizon)
	peakSiteImportKw := 0.0
	energyCostPaise := 0.0
	allocationChanges := 0

	for step := 0; step < horizon; step++ {
		active := make([]int, 0, len(input.Vehicles))
		demands := make([]float64, len(input.Vehicles))
		weights := make([]float64, len(input.Vehicles))
		availableEvPower := math.Max(0, input.SitePowerLimitKw-input.BuildingLoadKw[step]+solar[step])

		for index, vehicle := range input.Vehicles {
			if step < vehicle.ArrivalStep || step >= vehicle.DepartureStep {
				continue
			}
			remainingEnergy := math.Max(0, vehicle.EnergyRequiredKwh-delivered[index])
			demands[index] = math.Min(vehicle.MaxPowerKw, remainingEnergy/stepHours)
			if demands[index] == 0 {
				continue
			}
			active = append(active, index)
			weights[index] = 1
			if definition.ID == "deadline-aware" {
				remainingHours := float64(vehicle.DepartureStep-step) * stepHours
				urgency := remainingEnergy / math.Max(remainingHours, 1e-9)
				weights[index] = 1 + vehicle.Priority + urgency/math.Max(vehicle.MaxPowerKw, 1e-9)
			} else if definition.ID == "demand-weighted" {
				weights[index] = demands[index]
			}
		}

		allocated := make([]float64, len(input.Vehicles))
		switch definition.ID {
		case "fcfs":
			ordered := append([]int(nil), active...)
			sort.SliceStable(ordered, func(left, right int) bool {
				return input.Vehicles[ordered[left]].ArrivalStep <
					input.Vehicles[ordered[right]].ArrivalStep
			})
			remaining := availableEvPower
			for _, index := range ordered {
				allocated[index] = math.Min(demands[index], remaining)
				remaining -= allocated[index]
			}
		default:
			allocateWeighted(availableEvPower, active, demands, weights, allocated)
		}

		totalEvAllocation := 0.0
		for index, power := range allocated {
			delivered[index] += power * stepHours
			totalEvAllocation += power
			if math.Abs(power-previousAllocation[index]) > 1e-9 {
				allocationChanges++
			}
		}
		siteImport := math.Max(0, input.BuildingLoadKw[step]+totalEvAllocation-solar[step])
		peakSiteImportKw = math.Max(peakSiteImportKw, siteImport)
		energyCostPaise += totalEvAllocation * stepHours * tariff[step]
		previousAllocation = allocated

		allocationRows := make([]vehicleAllocation, 0, len(active))
		for _, index := range active {
			allocationRows = append(allocationRows, vehicleAllocation{
				VehicleID:        input.Vehicles[index].VehicleID,
				RequestedPowerKw: demands[index],
				AllocatedPowerKw: allocated[index],
				Reason:           allocationReason(definition.ID, allocated[index], demands[index], availableEvPower),
			})
		}
		steps = append(steps, simulationStep{
			Step:                step,
			BuildingLoadKw:      input.BuildingLoadKw[step],
			SolarGenerationKw:   solar[step],
			AvailableEvPowerKw:  availableEvPower,
			TotalEvAllocationKw: totalEvAllocation,
			SiteImportKw:        siteImport,
			TariffPaisePerKwh:   tariff[step],
			Allocations:         allocationRows,
		})
	}

	vehicleRows := make([]vehicleResult, 0, len(input.Vehicles))
	totalShortfall := 0.0
	missedDeadlines := 0
	sumDelivered := 0.0
	sumSquares := 0.0
	for index, vehicle := range input.Vehicles {
		shortfall := math.Max(0, vehicle.EnergyRequiredKwh-delivered[index])
		missed := shortfall > 1e-6
		if missed {
			missedDeadlines++
		}
		totalShortfall += shortfall
		sumDelivered += delivered[index]
		sumSquares += delivered[index] * delivered[index]
		finalSoc := 0.0
		if vehicle.BatteryCapacityKwh > 0 {
			finalSoc = math.Min(100, vehicle.InitialSocPct+
				delivered[index]/vehicle.BatteryCapacityKwh*100)
		}
		vehicleRows = append(vehicleRows, vehicleResult{
			VehicleID:          vehicle.VehicleID,
			EnergyRequiredKwh:  vehicle.EnergyRequiredKwh,
			EnergyDeliveredKwh: delivered[index],
			EnergyShortfallKwh: shortfall,
			MissedDeadline:     missed,
			FinalSocPct:        finalSoc,
		})
	}

	fairness := 1.0
	if sumSquares > 0 {
		fairness = sumDelivered * sumDelivered /
			(float64(len(input.Vehicles)) * sumSquares)
	}
	demandCostPaise := peakSiteImportKw * input.DemandChargePaisePerKw

	return policyResult{
		PolicyID:    definition.ID,
		Name:        definition.Name,
		Description: definition.Description,
		Metrics: simulationMetrics{
			TotalEnergyDeliveredKwh: sumDelivered,
			TotalEnergyShortfallKwh: totalShortfall,
			MissedDeadlines:         missedDeadlines,
			PeakSiteImportKw:        peakSiteImportKw,
			TransformerUtilization:  peakSiteImportKw / input.SitePowerLimitKw,
			EnergyCostPaise:         energyCostPaise,
			DemandCostPaise:         demandCostPaise,
			TotalCostPaise:          energyCostPaise + demandCostPaise,
			DeliveryFairness:        fairness,
			AllocationChanges:       allocationChanges,
		},
		Steps:    steps,
		Vehicles: vehicleRows,
	}
}

func allocateWeighted(capacity float64, active []int, demands, weights, result []float64) {
	pending := append([]int(nil), active...)
	remaining := capacity
	const epsilon = 1e-9
	for len(pending) > 0 && remaining > epsilon {
		weightTotal := 0.0
		for _, index := range pending {
			weightTotal += math.Max(weights[index], 1)
		}
		next := make([]int, 0, len(pending))
		used := 0.0
		for _, index := range pending {
			share := remaining * math.Max(weights[index], 1) / weightTotal
			power := math.Min(demands[index]-result[index], share)
			result[index] += power
			used += power
			if demands[index]-result[index] > epsilon {
				next = append(next, index)
			}
		}
		if used <= epsilon {
			break
		}
		remaining -= used
		pending = next
	}
}

func allocationReason(policyID string, allocated, requested, available float64) string {
	if allocated <= 1e-9 {
		if available <= 1e-9 {
			return "No EV capacity remains after site load and solar."
		}
		if policyID == "fcfs" {
			return "Earlier arrivals consumed the available EV capacity."
		}
		return "Available capacity was assigned to higher-weight active vehicles."
	}
	if allocated+1e-9 < requested {
		switch policyID {
		case "fcfs":
			return "Capped by remaining site capacity and arrival order."
		case "deadline-aware":
			return "Weighted by energy deficit, departure time, and priority."
		case "demand-weighted":
			return "Proportional to this vehicle's share of total active demand."
		default:
			return "Shared fairly across active vehicles."
		}
	}
	return "Vehicle demand fits within the current site capacity."
}

func isFinitePositive(value float64) bool {
	return isFiniteNonNegative(value) && value > 0
}
