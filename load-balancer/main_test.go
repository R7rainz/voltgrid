package main

import "testing"

func TestAllocateRespectsSiteLimit(t *testing.T) {
	allocations, total, err := allocate(allocationRequest{
		SitePowerLimitKw: 100,
		ActiveChargers: []chargerRequest{
			{ChargerID: "sim-car-001", RequestedPowerKw: 80, MaxPowerKw: 80},
			{ChargerID: "sim-car-002", RequestedPowerKw: 80, MaxPowerKw: 80},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	if total > 100 {
		t.Fatalf("allocated %.2f kW above site limit", total)
	}

	if allocations[0].AllocatedPowerKw != 50 || allocations[1].AllocatedPowerKw != 50 {
		t.Fatalf("expected a fair 50/50 allocation, got %#v", allocations)
	}
}
