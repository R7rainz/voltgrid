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

func TestAllocateWaterFillsUnequalDemands(t *testing.T) {
	allocations, total, err := allocate(allocationRequest{
		SitePowerLimitKw: 100,
		ActiveChargers: []chargerRequest{
			{ChargerID: "one", RequestedPowerKw: 20, MaxPowerKw: 20},
			{ChargerID: "two", RequestedPowerKw: 80, MaxPowerKw: 80},
			{ChargerID: "three", RequestedPowerKw: 80, MaxPowerKw: 80},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if total != 100 || allocations[0].AllocatedPowerKw != 20 ||
		allocations[1].AllocatedPowerKw != 40 || allocations[2].AllocatedPowerKw != 40 {
		t.Fatalf("expected 20/40/40 kW, got %#v (total %.3f)", allocations, total)
	}
}

func TestAllocateReclaimsFaultedChargerShare(t *testing.T) {
	allocations, total, err := allocate(allocationRequest{
		SitePowerLimitKw: 100,
		ActiveChargers: []chargerRequest{
			{ChargerID: "one", RequestedPowerKw: 40, MaxPowerKw: 40},
			{ChargerID: "two", RequestedPowerKw: 40, MaxPowerKw: 40},
			{ChargerID: "faulted", RequestedPowerKw: 0, MaxPowerKw: 0},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if total != 80 || allocations[0].AllocatedPowerKw != 40 ||
		allocations[1].AllocatedPowerKw != 40 || allocations[2].AllocatedPowerKw != 0 {
		t.Fatalf("expected 40/40/0 kW after fault, got %#v (total %.3f)", allocations, total)
	}
}
