package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestComparePoliciesShowsDeadlineTradeoff(t *testing.T) {
	result, err := compare(compareRequest{
		SitePowerLimitKw:       60,
		TimeStepMinutes:        60,
		BuildingLoadKw:         []float64{0, 0, 0},
		DemandChargePaisePerKw: 100,
		Vehicles: []simulationVehicle{
			{
				VehicleID:         "early",
				ArrivalStep:       0,
				DepartureStep:     3,
				EnergyRequiredKwh: 120,
				MaxPowerKw:        60,
			},
			{
				VehicleID:         "urgent",
				ArrivalStep:       1,
				DepartureStep:     2,
				EnergyRequiredKwh: 50,
				MaxPowerKw:        50,
				Priority:          10,
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	if len(result.Policies) != 4 {
		t.Fatalf("expected four policy results, got %d", len(result.Policies))
	}

	var fcfs, deadline policyResult
	for _, policy := range result.Policies {
		for _, step := range policy.Steps {
			if step.SiteImportKw > result.SitePowerLimitKw+1e-9 {
				t.Fatalf("%s exceeded site limit at step %d", policy.PolicyID, step.Step)
			}
		}
		switch policy.PolicyID {
		case "fcfs":
			fcfs = policy
		case "deadline-aware":
			deadline = policy
		}
	}

	if fcfs.Metrics.MissedDeadlines != 1 {
		t.Fatalf("expected FCFS to miss the urgent vehicle, got %#v", fcfs.Metrics)
	}
	if deadline.Metrics.MissedDeadlines != 0 {
		t.Fatalf("expected deadline-aware policy to meet both targets, got %#v", deadline.Metrics)
	}
	if deadline.Metrics.TotalEnergyDeliveredKwh <= fcfs.Metrics.TotalEnergyDeliveredKwh {
		t.Fatalf("expected deadline-aware policy to deliver more energy, got deadline %.2f and FCFS %.2f",
			deadline.Metrics.TotalEnergyDeliveredKwh, fcfs.Metrics.TotalEnergyDeliveredKwh)
	}
}

func TestCompareRejectsBaseLoadAboveSiteLimit(t *testing.T) {
	_, err := compare(compareRequest{
		SitePowerLimitKw: 100,
		TimeStepMinutes:  15,
		BuildingLoadKw:   []float64{101},
		Vehicles: []simulationVehicle{{
			VehicleID:         "car",
			ArrivalStep:       0,
			DepartureStep:     1,
			EnergyRequiredKwh: 1,
			MaxPowerKw:        10,
		}},
	})
	if err == nil {
		t.Fatal("expected a base-load capacity error")
	}
}

func TestCompareHandlerReturnsAllPolicies(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/v1/compare", strings.NewReader(`{
		"sitePowerLimitKw": 50,
		"timeStepMinutes": 60,
		"buildingLoadKw": [10, 10],
		"vehicles": [{
			"vehicleId": "car",
			"arrivalStep": 0,
			"departureStep": 2,
			"energyRequiredKwh": 20,
			"maxPowerKw": 30
		}]
	}`))
	response := httptest.NewRecorder()

	compareHandler(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"policyId":"deadline-aware"`) {
		t.Fatalf("expected deadline-aware policy in response: %s", response.Body.String())
	}
}
